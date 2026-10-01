import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import { CanvasRenderer } from "./canvas-renderer";
import { resolveUpscaler } from "@/upscale";
import type { Upscaler, UpscaleRequest } from "@/upscale/types";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	upscale?: UpscaleRequest;
};

// NOTE on color management: sources are treated as sRGB/rec.709 (same
// primaries; transfer differences ignored) and the pipeline presents
// sRGB-encoded frames, which mediabunny encodes as rec.709. Display-P3
// sources are not gamut-mapped — out-of-sRGB colors clip. Graded projects
// should export at very_high/ultra: 4:2:0 chroma subsampling bleeds
// saturated colors at low bitrates regardless of pipeline precision.
/** How often (in frames) the upscale output is checked for blankness.
 * getImageData on a 4K canvas is a full GPU->CPU sync, so it must not run
 * per frame. */
const AI_BLANK_WARN_INTERVAL = 30;

/** Frames kept in flight: one being encoded, one in the worker, and this
 * many being rendered. Bounds memory (each in-flight frame owns a
 * full-resolution snapshot) while still letting the worker start frame N+1
 * the instant frame N is done. */
const PIPELINE_DEPTH = 3;

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
	// Ultra: fixed 40 Mbps video to preserve graded color (4:2:0 codecs
	// bleed saturated reds at lower rates). Audio stays at very_high.
	ultra: 40_000_000,
};

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private upscale?: UpscaleRequest;
	private upscaler: Upscaler | null = null;
	private feedCanvas: HTMLCanvasElement | null = null;
	/**
	 * Persistent 2D frame canvas at canvas size. Every export frame is
	 * rendered into it via renderToCanvas() and the encoder/upscaler only
	 * ever read from 2D canvases — never from the presented WebGL canvas,
	 * whose drawing buffer may already be cleared (transparent black).
	 */
	private frameCanvas: HTMLCanvasElement | null = null;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		upscale,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		// Upscale to strictly larger targets; AI enhance may also run at
		// canvas size (2x internal, then fit back) for detail + denoise.
		if (
			upscale &&
			upscale.width > 0 &&
			upscale.height > 0 &&
			(upscale.width > width ||
				upscale.height > height ||
				upscale.method === "ai")
		) {
			this.upscale = upscale;
		}
	}

	cancel(): void {
		this.isCancelled = true;
		// Must settle the in-flight upscale, not terminate its worker —
		// dropping the promise would hang the export loop forever.
		this.upscaler?.cancel?.();
	}

	/** Canvas the encoder reads. Upscaled copy when requested, else the 2D frame. */
	private getFeedCanvas(): HTMLCanvasElement {
		if (!this.upscale) {
			return this.getFrameCanvas();
		}
		if (!this.feedCanvas) {
			this.feedCanvas = document.createElement("canvas");
			this.feedCanvas.width = this.upscale.width;
			this.feedCanvas.height = this.upscale.height;
		}
		return this.feedCanvas;
	}

	private getFrameCanvas(): HTMLCanvasElement {
		if (!this.frameCanvas) {
			this.frameCanvas = document.createElement("canvas");
			this.frameCanvas.width = this.renderer.width;
			this.frameCanvas.height = this.renderer.height;
		}
		return this.frameCanvas;
	}

	/**
	 * Render one frame and hand back an OWNED copy.
	 *
	 * The pipeline renders frame N+1 while frame N is still being upscaled,
	 * so the caller must never hold a reference to the shared frame canvas
	 * across an await — it gets overwritten. Each in-flight frame therefore
	 * carries its own snapshot.
	 *
	 * NOTE: the snapshot is kept as a plain HTMLCanvasElement rather than an
	 * ImageBitmap. The snapshot draw has to land before the next
	 * renderToCanvas() overwrites the source, and a queued drawImage is not
	 * guaranteed to have executed before that happens. Encoding also runs
	 * faster than AI inference, so a small post-await delay here does not
	 * cost throughput — the producer simply runs a frame ahead.
	 */
	private async renderFrameSnapshot({
		rootNode,
		timeTicks,
		index,
	}: {
		rootNode: RootNode;
		timeTicks: number;
		index: number;
	}): Promise<HTMLCanvasElement> {
		await this.renderer.renderToCanvas({
			node: rootNode,
			time: timeTicks,
			targetCanvas: this.getFrameCanvas(),
		});
		if (index === 0) {
			this.assertFrameNotBlank({ canvas: this.getFrameCanvas(), what: "frame" });
		}
		const frame = this.getFrameCanvas();
		const snapshot = document.createElement("canvas");
		snapshot.width = frame.width;
		snapshot.height = frame.height;
		const ctx = snapshot.getContext("2d", { willReadFrequently: false });
		if (!ctx) throw new Error("Failed to snapshot frame canvas");
		ctx.drawImage(frame, 0, 0);
		return snapshot;
	}

	/**
	 * Start an upscale without awaiting it. The worker serializes inference,
	 * so several frames can be queued; that is what keeps the GPU busy while
	 * the main thread renders and the encoder compresses.
	 */
	private startUpscale(source: HTMLCanvasElement): Promise<OffscreenCanvas> {
		if (!this.upscale) {
			throw new Error("startUpscale called without an upscale request");
		}
		if (!this.upscaler) {
			this.upscaler = resolveUpscaler(this.upscale.method);
		}
		return this.upscaler.upscale(source, {
			width: this.upscale.width,
			height: this.upscale.height,
		});
	}

	/** Draw an upscaled frame into the encoder's canvas. */
	private drawUpscaled(upscaled: OffscreenCanvas): void {
		if (!this.feedCanvas) return;
		const ctx = this.feedCanvas.getContext("2d", { willReadFrequently: false });
		if (!ctx) throw new Error("Failed to get feed canvas context");
		ctx.clearRect(0, 0, this.feedCanvas.width, this.feedCanvas.height);
		ctx.drawImage(upscaled, 0, 0, this.feedCanvas.width, this.feedCanvas.height);
	}

	/** true when every sampled pixel is fully transparent. */
	private isFrameBlank(canvas: HTMLCanvasElement): boolean {
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return false;
		let img: ImageData;
		try {
			img = ctx.getImageData(0, 0, canvas.width, canvas.height);
		} catch {
			return false;
		}
		const d = img.data;
		const step = 4099 * 4;
		for (let i = 3; i < d.length; i += step) {
			if ((d[i] ?? 0) > 8) return false;
		}
		return true;
	}

	/**
	 * Fail loud instead of encoding a black file: a fully transparent
	 * source frame means frame capture broke (never legitimate — the
	 * compositor clears opaque). Genuinely black content still has alpha
	 * 255 and passes.
	 */
	private assertFrameNotBlank({
		canvas,
		what,
	}: {
		canvas: HTMLCanvasElement;
		what: string;
	}): void {
		if (!this.isFrameBlank(canvas)) return;
		throw new Error(
			`Export rendered a blank (fully transparent) ${what} — capture failed. ` +
				"If this persists, export without upscale/AI and report the project setup.",
		);
	}

	/** Non-fatal counterpart for the upscale path: warn, keep exporting. */
	private warnIfBlankFrame({
		canvas,
		what,
	}: {
		canvas: HTMLCanvasElement;
		what: string;
	}): void {
		if (!this.isFrameBlank(canvas)) return;
		console.warn(
			`[export] ${what} is fully transparent after upscale. The video will ` +
				"contain blank frames. Consider exporting without AI enhance.",
		);
	}

	private async abort(output: Output): Promise<null> {
		await output.cancel();
		this.upscaler?.dispose?.();
		this.emit("cancelled");
		return null;
	}

	/**
	 * Overlapped upscale export.
	 *
	 * A producer task renders frames and hands each one to the worker; a
	 * consumer task awaits the results in order, draws them into the encoder
	 * canvas and compresses. Because the worker serializes its own queue, the
	 * producer can stay ahead and inference for frame N+1 overlaps encoding of
	 * frame N. The consumer never lets the feed canvas hold the wrong frame:
	 * it draws and calls add() back-to-back with no await in between that
	 * could reorder them.
	 */
	private async pipelinedExport({
		rootNode,
		videoSource,
		frameCount,
		ticksPerFrame,
		fpsFloat,
	}: {
		rootNode: RootNode;
		videoSource: CanvasSource;
		frameCount: number;
		ticksPerFrame: number;
		fpsFloat: number;
	}): Promise<void> {
		const queue: {
			index: number;
			timeSeconds: number;
			upscaled: Promise<OffscreenCanvas>;
		}[] = [];
		// A one-slot signal deadlocks the two tasks: the consumer can be
		// parked on an empty queue while the producer pushes a frame without
		// signalling, and then both park. A waiter list wakes whichever side
		// is actually blocked.
		const waiters: (() => void)[] = [];
		const notify = (): void => {
			while (waiters.length > 0) waiters.pop()?.();
		};
		const waitForWork = (): Promise<void> =>
			new Promise<void>((resolve) => {
				waiters.push(resolve);
			});
		let encoded = 0;
		let failure: unknown = null;
		let producerDone = false;

		const producer = (async () => {
			try {
				for (let index = 0; index < frameCount; index++) {
					if (this.isCancelled || failure) return;
					// Bound the window: each queued frame owns a
					// full-resolution snapshot plus its upscaled result.
					while (queue.length >= PIPELINE_DEPTH && !this.isCancelled && !failure) {
						await waitForWork();
					}
					if (this.isCancelled || failure) return;
					const timeTicks = index * ticksPerFrame;
					const snapshot = await this.renderFrameSnapshot({
						rootNode,
						timeTicks,
						index,
					});
					if (this.isCancelled || failure) return;
					queue.push({
						index,
						timeSeconds: mediaTimeToSeconds({ time: timeTicks }),
						upscaled: this.startUpscale(snapshot),
					});
					// Wake a consumer parked on an empty queue. Without this
					// the two tasks deadlock: the producer keeps rendering
					// while the consumer waits for a frame already queued.
					notify();
				}
			} finally {
				producerDone = true;
				// Release a consumer waiting on a queue that will never fill.
				notify();
			}
		})();

		const consumer = (async () => {
			while (encoded < frameCount) {
				const job = queue.shift();
				if (!job) {
					// Nothing queued: either the producer is mid-render or it
					// is finished. `producerDone` distinguishes the two, so we
					// can exit instead of waiting on a task that will never
					// push again.
					if (this.isCancelled || producerDone) return;
					await waitForWork();
					continue;
				}
				let upscaled: OffscreenCanvas;
				try {
					upscaled = await job.upscaled;
				} catch (error) {
					// A cancel landing mid-upscale is the only expected
					// failure here; anything else is a real export error.
					if (this.isCancelled) return;
					failure ??= error;
					return;
				}
				if (this.isCancelled) return;
				this.drawUpscaled(upscaled);
				// Sample, don't assert: a fully transparent AI frame is a
				// real failure mode of the upscale path, and throwing on
				// frame 0 only meant the user lost the whole export before
				// seeing why. Warn instead and keep encoding.
				if (job.index % AI_BLANK_WARN_INTERVAL === 0) {
					this.warnIfBlankFrame({
						canvas: this.getFeedCanvas(),
						what: `frame ${job.index}`,
					});
				}
				await videoSource.add(job.timeSeconds, 1 / fpsFloat);
				encoded++;
				this.emit("progress", encoded / frameCount);
				// Free a slot for the producer.
				notify();
			}
		})();

		// A producer that throws (capture failure, OOM) must not be able to
		// park the consumer forever on an empty queue.
		const settled = await Promise.allSettled([producer, consumer]);
		if (failure) throw failure;
		for (const result of settled) {
			if (result.status === "rejected") throw result.reason;
		}
		if (encoded < frameCount && !this.isCancelled) {
			throw new Error(
				`Export stopped after ${encoded}/${frameCount} frames without an error`,
			);
		}
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const output = new Output({
			format: outputFormat,
			target: new BufferTarget(),
		});

		const videoSource = new CanvasSource(this.getFeedCanvas(), {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate:
					this.quality === "ultra" ? QUALITY_VERY_HIGH : qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
		}

		await output.start();

		if (audioSource && this.audioBuffer) {
			await audioSource.add(this.audioBuffer);
			audioSource.close();
		}

try {
			if (!this.upscale) {
				// No upscale: the encoder reads the shared frame canvas
				// directly and there is no worker round-trip to hide, so a
				// pipeline would only add copies.
				for (let index = 0; index < frameCount; index++) {
					if (this.isCancelled) {
						return this.abort(output);
					}
					await this.renderer.renderToCanvas({
						node: rootNode,
						time: index * ticksPerFrame,
						targetCanvas: this.getFrameCanvas(),
					});
					if (index === 0) {
						this.assertFrameNotBlank({
							canvas: this.getFrameCanvas(),
							what: "frame",
						});
					}
					await videoSource.add(
						mediaTimeToSeconds({ time: index * ticksPerFrame }),
						1 / fpsFloat,
					);
					this.emit("progress", (index + 1) / frameCount);
				}
			} else {
				await this.pipelinedExport({ rootNode, videoSource, frameCount, ticksPerFrame, fpsFloat });
			}

			if (this.isCancelled) {
				return this.abort(output);
			}

			videoSource.close();
			await output.finalize();
		} catch (error) {
			// Never leave a half-written muxer (or a live upscale worker)
			// behind when a frame fails.
			await output.cancel().catch(() => {});
			this.upscaler?.dispose?.();
			throw error;
		}
		this.upscaler?.dispose?.();
		this.emit("progress", 1);

		const buffer = output.target.buffer;
		if (!buffer) {
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", buffer);
		return buffer;
	}
}
