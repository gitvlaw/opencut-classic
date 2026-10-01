import { fetchModelWithCache, UPSCALE_MODEL_CONFIG } from "./model";
import { TILE_SIZE } from "./tiling";
import type {
	UpscaleInboundMessage,
	UpscaleOutboundMessage,
} from "./protocol";

export interface UpscaleFrameProgress {
	doneTiles: number;
	totalTiles: number;
	percentage: number;
}

/** User aborted the export — never a failure worth falling back from. */
export class UpscaleCancelledError extends Error {
	constructor() {
		super("Upscale cancelled");
		this.name = "UpscaleCancelledError";
	}
}

type PendingJob = {
	id: number;
	resolve: (canvas: OffscreenCanvas) => void;
	reject: (error: Error) => void;
	onProgress?: (progress: UpscaleFrameProgress) => void;
};

/**
 * Main-thread driver for the Real-ESRGAN worker. Any number of frames may be in
 * flight — the worker queues them itself, so the export loop can keep the
 * GPU and the encoder busy at the same time. The worker is created lazily
 * and torn down via dispose().
 */
export class UpscaleService {
	private worker: Worker | null = null;
	private initPromise: Promise<string> | null = null;
	private jobId = 0;
	private pending = new Map<number, PendingJob>();
	private activeModelId = "";
	/**
	 * Bumped on dispose(). Frames already in flight (mid createImageBitmap,
	 * mid ensureInitialized) compare their captured generation against this
	 * and bail out. Without the check they would lazily recreate a worker
	 * after teardown — one leaked worker per export, each holding a WebGPU
	 * session and ~600MB of tile buffers.
	 */
	private generation = 0;

	onProgress?: (progress: UpscaleFrameProgress) => void;

	async ensureInitialized(
		onDownload?: (loaded: number, total: number) => void,
	): Promise<string> {
		if (!this.initPromise) {
			this.initPromise = this.init(onDownload).catch((error) => {
				// Clear the memo so a later export (new session, e.g. the
				// browser gained WebGPU) can retry. Without this a single
				// transient failure poisons the service for the page's life.
				this.initPromise = null;
				this.activeModelId = "";
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
		const generation = this.generation;
		await this.ensureInitialized();
		if (generation !== this.generation) {
			throw new UpscaleCancelledError();
		}

		const width = source.width;
		const height = source.height;

		const imageBitmap = await createImageBitmap(source);
		if (generation !== this.generation) {
			imageBitmap.close();
			throw new UpscaleCancelledError();
		}

		const id = ++this.jobId;
		const tileSize = TILE_SIZE;
		const result = new Promise<OffscreenCanvas>((resolve, reject) => {
			const wrappedResolve = (canvas: OffscreenCanvas) => {
				console.info(
					`[upscale] frame ${width}x${height} (${this.activeModelId}, tile ${tileSize}): ` +
						`${Math.round(performance.now() - started)}ms total`,
				);
				resolve(canvas);
			};
			this.pending.set(id, {
				id,
				resolve: wrappedResolve,
				reject,
				onProgress: onProgress ?? this.onProgress,
			});
		});
		this.getWorker().postMessage(
			{ type: "upscale-image", id, width, height, imageBitmap, tileSize } satisfies UpscaleInboundMessage,
			[imageBitmap as Transferable],
		);
		return result;
	}

	/** Reject one in-flight frame without touching the worker lifecycle. */
	private settleJobWith(id: number, error: Error): void {
		const job = this.pending.get(id);
		if (!job) return;
		this.pending.delete(id);
		job.reject(error);
	}

	/** Reject every in-flight frame (cancel / dispose). */
	private settleAllWith(error: Error): void {
		const jobs = [...this.pending.values()];
		this.pending.clear();
		for (const job of jobs) job.reject(error);
	}

	/**
	 * Stop the queued work. In-flight frame promises are rejected right away
	 * (never left hanging) and the worker is told to stop at the next tile
	 * boundary, so a cancel does not wait a whole tile.
	 */
	cancel(): void {
		// A cancel is final for this export: bump the generation so frames
		// that were still awaiting init/createImageBitmap don't post into a
		// worker that has already been told to stop.
		this.generation++;
		this.worker?.postMessage({ type: "cancel" } satisfies UpscaleInboundMessage);
		this.settleAllWith(new UpscaleCancelledError());
	}

	dispose(): void {
		this.generation++;
		this.worker?.terminate();
		this.worker = null;
		this.initPromise = null;
		this.activeModelId = "";
		this.settleAllWith(new UpscaleCancelledError());
	}

	private async init(
		onDownload?: (loaded: number, total: number) => void,
	): Promise<string> {
		const buffer = await fetchModelWithCache(UPSCALE_MODEL_CONFIG, onDownload);
		if (!buffer || buffer.byteLength < 1000) {
			throw new Error("Upscale model is missing or empty");
		}
		const provider = await this.initSession(buffer);
		this.activeModelId = `${UPSCALE_MODEL_CONFIG.id}+${provider}`;
		console.info(`[upscale] session ready: ${this.activeModelId}`);
		return provider;
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
				}			};
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
				this.pending.get(message.id)?.onProgress?.({
					doneTiles: message.done,
					totalTiles: message.total,
					percentage: message.percentage,
				});
				break;
			}
			case "image_complete": {
				const pending = this.pending.get(message.id);
				if (!pending) {
					// Cancelled after the worker already answered: drop the
					// bitmap so the transfer isn't leaked.
					message.imageBitmap?.close?.();
					break;
				}
				this.pending.delete(message.id);
				try {
					console.info(
						`[upscale] tiles done: avg ${message.avgTileMs.toFixed(1)}ms/tile (${this.activeModelId})`,
					);
					const bitmap = message.imageBitmap;
					if (!(bitmap instanceof ImageBitmap)) {
						throw new Error(
							`Invalid imageBitmap payload: ${typeof bitmap} (${String(bitmap)})`,
						);
					}
					if (bitmap.width === 0 || bitmap.height === 0) {
						throw new Error(
							`Upscale worker returned a zero-size frame: ${bitmap.width}x${bitmap.height}`,
						);
					}
					const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
					const ctx = canvas.getContext("2d", { willReadFrequently: false });
					if (!ctx) throw new Error("Failed to create output canvas");
					ctx.drawImage(bitmap, 0, 0);
					bitmap.close();
					pending.resolve(canvas);
				} catch (error) {
					pending.reject(error instanceof Error ? error : new Error(String(error)));
				}
				break;
			}
			case "cancelled": {
				this.settleJobWith(message.id, new UpscaleCancelledError());
				break;
			}
			case "error": {
				const error = new Error(message.message);
				// Init errors carry no id and must fail every waiter.
				if (message.id === undefined) this.settleAllWith(error);
				else this.settleJobWith(message.id, error);
				break;
			}
			default:
				break;
		}
	}
}

export const upscaleService = new UpscaleService();