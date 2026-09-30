import { fetchModelWithCache, UPSCALE_MODEL_FP16, UPSCALE_MODEL_FP32 } from "./model";
import { chooseTileSize } from "./tiling";
import type {
	UpscaleInboundMessage,
	UpscaleOutboundMessage,
} from "./protocol";

export interface UpscaleFrameProgress {
	doneTiles: number;
	totalTiles: number;
	percentage: number;
}

type PendingJob = {
	resolve: (canvas: OffscreenCanvas) => void;
	reject: (error: Error) => void;
	onProgress?: (progress: UpscaleFrameProgress) => void;
};

/**
 * Main-thread driver for the CUGAN worker. One job at a time (export
 * is strictly sequential); the worker is created lazily and torn down
 * via dispose().
 */
export class UpscaleService {
	private worker: Worker | null = null;
	private initPromise: Promise<string> | null = null;
	private jobId = 0;
	private pending: PendingJob | null = null;
	private activeModelId = "";

	onProgress?: (progress: UpscaleFrameProgress) => void;

	async ensureInitialized(
		onDownload?: (loaded: number, total: number) => void,
	): Promise<string> {
		if (!this.initPromise) {
			this.initPromise = this.init(onDownload).catch((error) => {
				this.initPromise = null;
				throw error;
			});
		}
		return this.initPromise;
	}

	get modelId(): string {
		return this.activeModelId;
	}

	async upscaleFrame(
		source: OffscreenCanvas,
		onProgress?: (progress: UpscaleFrameProgress) => void,
	): Promise<OffscreenCanvas> {
		const started = performance.now();
		await this.ensureInitialized();
		if (this.pending) throw new Error("Upscale already in progress");

		const width = source.width;
		const height = source.height;
		const ctx = source.getContext("2d", { willReadFrequently: true });
		if (!ctx) throw new Error("Failed to read source frame");
		let img: ImageData;
		try {
			img = ctx.getImageData(0, 0, width, height);
		} catch (error) {
			throw new Error(`Failed to read frame pixels: ${String(error)}`);
		}

		// RGB float 0..1 (alpha is handled on the caller side).
		const rgb = new Float32Array(width * height * 3);
		const px = img.data;
		for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
			rgb[j] = px[i]! / 255;
			rgb[j + 1] = px[i + 1]! / 255;
			rgb[j + 2] = px[i + 2]! / 255;
		}

		const id = ++this.jobId;
		const tileSize = chooseTileSize(width, height);
		const result = new Promise<OffscreenCanvas>((resolve, reject) => {
			const wrappedResolve = (canvas: OffscreenCanvas) => {
				console.info(
					`[upscale] frame ${width}x${height} (${this.activeModelId}, tile ${tileSize}): ` +
						`${Math.round(performance.now() - started)}ms total`,
				);
				resolve(canvas);
			};
			this.pending = { resolve: wrappedResolve, reject, onProgress: onProgress ?? this.onProgress };
		});
		this.getWorker().postMessage(
			{ type: "upscale-image", id, width, height, data: rgb, tileSize } satisfies UpscaleInboundMessage,
			[rgb.buffer as Transferable],
		);
		return result;
	}

	cancel(): void {
		this.worker?.postMessage({ type: "cancel" } satisfies UpscaleInboundMessage);
	}

	dispose(): void {
		this.worker?.terminate();
		this.worker = null;
		this.initPromise = null;
		this.pending = null;
	}

	private async init(
		onDownload?: (loaded: number, total: number) => void,
	): Promise<string> {
		// FP16 first (half bandwidth, faster on RTX); FP32 fallback covers
		// EPs without float16 support.
		const errors: string[] = [];
		for (const config of [UPSCALE_MODEL_FP16, UPSCALE_MODEL_FP32]) {
			try {
				const buffer = await fetchModelWithCache(config, onDownload);
				if (!buffer || buffer.byteLength < 1000) {
					throw new Error(`Model ${config.id} is missing or empty`);
				}
				const provider = await this.initSession(buffer);
				this.activeModelId = `${config.id}+${provider}`;
				console.info(`[upscale] session ready: ${this.activeModelId}`);
				return provider;
			} catch (error) {
				errors.push(`${config.id}: ${error instanceof Error ? error.message : String(error)}`);
				console.warn(`[upscale] ${config.id} failed, trying next:`, error);
			}
		}
		throw new Error(`Upscale init failed: ${errors.join(" | ")}`);
	}

	private initSession(buffer: ArrayBuffer): Promise<string> {
		const worker = this.getWorker();
		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Upscale worker init timed out")), 120_000);
			const onMessage = (event: MessageEvent<UpscaleOutboundMessage>) => {
				const message = event.data;
				if (message.type === "init_complete") {
					clearTimeout(timeout);
					worker.removeEventListener("message", onMessage);
					resolve(message.executionProvider);
				} else if (message.type === "error") {
					clearTimeout(timeout);
					worker.removeEventListener("message", onMessage);
					reject(new Error(message.message));
				}
			};
			worker.addEventListener("message", onMessage);
			worker.postMessage({ type: "init", model: buffer } satisfies UpscaleInboundMessage, [
				buffer as Transferable,
			]);
		});
	}

	private getWorker(): Worker {
		if (!this.worker) {
			this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
				type: "module",
			});
			this.worker.addEventListener("message", (event: MessageEvent<UpscaleOutboundMessage>) => {
				this.handleMessage(event.data);
			});
		}
		return this.worker;
	}

	private handleMessage(message: UpscaleOutboundMessage): void {
		switch (message.type) {
			case "tile_progress": {
				this.pending?.onProgress?.({
					doneTiles: message.done,
					totalTiles: message.total,
					percentage: message.percentage,
				});
				break;
			}
			case "image_complete": {
				const pending = this.pending;
				this.pending = null;
				if (!pending) break;
				try {
					console.info(
						`[upscale] tiles done: avg ${message.avgTileMs.toFixed(1)}ms/tile (${this.activeModelId})`,
					);
					const canvas = new OffscreenCanvas(message.width, message.height);
					const ctx = canvas.getContext("2d");
					if (!ctx) throw new Error("Failed to create output canvas");
					const img = ctx.createImageData(message.width, message.height);
					const px = img.data;
					const src = message.data;
					for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
						px[i] = Math.round(Math.min(1, Math.max(0, src[j] ?? 0)) * 255);
						px[i + 1] = Math.round(Math.min(1, Math.max(0, src[j + 1] ?? 0)) * 255);
						px[i + 2] = Math.round(Math.min(1, Math.max(0, src[j + 2] ?? 0)) * 255);
						px[i + 3] = 255;
					}
					ctx.putImageData(img, 0, 0);
					pending.resolve(canvas);
				} catch (error) {
					pending.reject(error instanceof Error ? error : new Error(String(error)));
				}
				break;
			}
			case "cancelled": {
				const pending = this.pending;
				this.pending = null;
				pending?.reject(new Error("Upscale cancelled"));
				break;
			}
			case "error": {
				const pending = this.pending;
				this.pending = null;
				pending?.reject(new Error(message.message));
				break;
			}
			default:
				break;
		}
	}
}

export const upscaleService = new UpscaleService();
