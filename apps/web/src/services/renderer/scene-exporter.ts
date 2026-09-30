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

	/** Resample the just-rendered frame into the feed canvas. */
	private async feedFrame(): Promise<void> {
		if (!this.upscale || !this.feedCanvas || !this.frameCanvas) return;
		if (!this.upscaler) {
			this.upscaler = resolveUpscaler(this.upscale.method);
		}
		const upscaled = await this.upscaler.upscale(
			this.getFrameCanvas(),
			{ width: this.upscale.width, height: this.upscale.height },
		);
		const ctx = this.feedCanvas.getContext("2d");
		if (!ctx) throw new Error("Failed to get feed canvas context");
		ctx.clearRect(0, 0, this.feedCanvas.width, this.feedCanvas.height);
		ctx.drawImage(upscaled, 0, 0, this.feedCanvas.width, this.feedCanvas.height);
	}

	/**
	 * Fail loud instead of encoding a black file: a fully transparent
	 * frame means frame capture broke (never legitimate — the compositor
	 * clears opaque). Genuinely black content still has alpha 255 and
	 * passes.
	 */
	private assertFrameNotBlank({
		canvas,
		what,
	}: {
		canvas: HTMLCanvasElement;
		what: string;
	}): void {
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;
		let img: ImageData;
		try {
			img = ctx.getImageData(0, 0, canvas.width, canvas.height);
		} catch {
			return;
		}
		const d = img.data;
		const step = 4099 * 4;
		for (let i = 3; i < d.length; i += step) {
			if ((d[i] ?? 0) > 8) return;
		}
		throw new Error(
			`Export rendered a blank (fully transparent) ${what} — capture failed. ` +
				"If this persists, export without upscale/AI and report the project setup.",
		);
	}

	private async abort(output: Output): Promise<null> {
		await output.cancel();
		this.upscaler?.dispose?.();
		this.emit("cancelled");
		return null;
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
			for (let i = 0; i < frameCount; i++) {
				if (this.isCancelled) {
					return this.abort(output);
				}

				const timeTicks = i * ticksPerFrame;
				const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
				await this.renderer.renderToCanvas({
					node: rootNode,
					time: timeTicks,
					targetCanvas: this.getFrameCanvas(),
				});
				if (i === 0) {
					this.assertFrameNotBlank({ canvas: this.getFrameCanvas(), what: "frame" });
				}
				try {
					await this.feedFrame();
				} catch (error) {
					// The only expected failure here is a user cancel landing
					// mid-upscale; anything else is a real export error.
					if (this.isCancelled) return this.abort(output);
					throw error;
				}
				if (i === 0 && this.upscale) {
					// The upscale path can blank the frame all by itself.
					this.assertFrameNotBlank({ canvas: this.getFeedCanvas(), what: "upscaled frame" });
				}
				await videoSource.add(timeSeconds, 1 / fpsFloat);

				this.emit("progress", i / frameCount);
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
