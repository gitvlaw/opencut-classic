import { registerAiUpscaler } from "./registry";
import { upscaleService, UpscaleCancelledError } from "./service";
import { ShaderUpscaler } from "./shader-upscaler";
import { resize2d, snapshotToOffscreen } from "./types";
import type { Upscaler, UpscaleTarget } from "./types";

/** Bound consecutive cache reuses so a long static hold still re-infers. */
const MAX_CACHED_FRAMES = 90;

/**
 * AI upscaler: Real-ESRGAN 2x worker, then an exact Lanczos resize to the
 * requested target (covers non-2x ratios like 720p -> 1080p). Alpha is
 * resampled with plain bilinear filtering and re-attached.
 *
 * Any init/inference failure degrades to the realtime shader path so an
 * export never dies because of the AI backend.
 */
export class AiUpscaler implements Upscaler {
	readonly method = "ai" as const;
	private readonly shader = new ShaderUpscaler();
	private lastSignature: { width: number; height: number; gray: Float32Array } | null = null;
	private lastOutput: { canvas: OffscreenCanvas; targetWidth: number; targetHeight: number } | null = null;
	private signatureCanvas: OffscreenCanvas | null = null;
	private signatureCtx: OffscreenCanvasRenderingContext2D | null = null;
	private aiDisabledPermanently = false;
	private cachedFrameCount = 0;
	/**
	 * Monotonic ticket. The pipeline runs several frames concurrently and
	 * their results can settle out of order, so the static-frame cache must
	 * only ever be written by the newest frame — otherwise a slow earlier
	 * frame installs a stale signature and the next frame compares against
	 * the wrong image.
	 */
	private latestIssuedFrame = 0;
	/** True once dispose() has been called because the AI backend broke.
	 * The pipeline keeps frames in flight, so dispose() rejects queued
	 * siblings with UpscaleCancelledError — indistinguishable from a user
	 * abort unless we remember why we tore down. */
	private backendFailed = false;

	async upscale(
		source: CanvasImageSource,
		target: UpscaleTarget,
	): Promise<OffscreenCanvas> {
		if (this.aiDisabledPermanently) {
			return this.shader.upscale(source, target);
		}
		// Claim the ticket before the first await.
		const frame = ++this.latestIssuedFrame;
		try {
			return await this.upscaleAi(source, target, frame);
		} catch (error) {
			// A cancel must reach the caller, not silently burn a shader
			// upscale on a frame nobody will encode.
			if (error instanceof UpscaleCancelledError) {
				if (this.backendFailed) {
					return this.shader.upscale(source, target);
				}
				throw error;
			}
			// A failed inference is a broken backend (no WebGPU, device
			// lost, model too big), not a transient hiccup. Retrying per frame
			// costs a worker round-trip + timeout on EVERY remaining frame and
			// pops between AI and shader output. Latch it off for the session.
			//
			// Note this frame is not the only one running: the pipeline keeps
			// several in flight, and dispose() rejects every queued sibling
			// with UpscaleCancelledError. Those siblings would then be treated
			// as a user abort and fail the export, so flag the backend as dead
			// FIRST and let them fall back to the shader too.
			console.warn("AI upscale failed, falling back to shader permanently:", error);
			this.aiDisabledPermanently = true;
			this.lastSignature = null;
			this.lastOutput = null;
			this.backendFailed = true;
			upscaleService.dispose();
			return this.shader.upscale(source, target);
		}
	}

	cancel(): void {
		upscaleService.cancel();
	}

	dispose(): void {
		upscaleService.dispose();
		this.lastSignature = null;
		this.lastOutput = null;
		this.signatureCanvas = null;
		this.signatureCtx = null;
		this.aiDisabledPermanently = false;
		this.backendFailed = false;
		this.cachedFrameCount = 0;
		this.latestIssuedFrame = 0;
	}

	private getSignatureCanvas({
		w,
		h,
	}: {
		w: number;
		h: number;
	}): { ctx: OffscreenCanvasRenderingContext2D } | null {
		if (
			!this.signatureCanvas ||
			this.signatureCanvas.width !== w ||
			this.signatureCanvas.height !== h
		) {
			this.signatureCanvas = new OffscreenCanvas(w, h);
			this.signatureCtx = this.signatureCanvas.getContext("2d", {
				willReadFrequently: true,
			});
		}
		if (!this.signatureCtx) return null;
		return { ctx: this.signatureCtx };
	}

	private computeFrameSignature(source: OffscreenCanvas): Float32Array {
		const w = 64;
		const h = Math.max(1, Math.round((64 * source.height) / Math.max(1, source.width)));
		const sig = this.getSignatureCanvas({ w, h });
		if (!sig) return new Float32Array(0);
		sig.ctx.drawImage(source, 0, 0, w, h);
		const img = sig.ctx.getImageData(0, 0, w, h);
		const out = new Float32Array(w * h);
		for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
			out[j] = 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
		}
		return out;
	}

	private async upscaleAi(
		source: CanvasImageSource,
		target: UpscaleTarget,
		frame: number,
	): Promise<OffscreenCanvas> {
		const sw = sourceWidthOf(source);
		const sh = sourceHeightOf(source);
		if (sw <= 0 || sh <= 0) throw new Error("Bad upscale source size");
		const snapshot = snapshotToOffscreen(source, sw, sh);
		if (!snapshot) throw new Error("Failed to snapshot frame");

		// Static-scene shortcut: talking heads barely change frame to
		// frame — reuse the last AI output instead of re-inferring.
		//
		// Safe under concurrency because the cache is only ever installed by
		// the newest completing frame (see the `frame` guard below), so it
		// always describes the most recent inference result. A stale entry
		// can cost one extra inference, never a wrong image.
		const cached = this.staticCacheHit({ snapshot, target, frame });
		if (cached) {
			console.info("[upscale] static frame — reusing last AI output");
			return cached;
		}

		const doubled = await upscaleService.upscaleFrame(snapshot);
		const merged = attachBilinearAlpha({ rgb: doubled, source });
		const out =
			merged.width === target.width && merged.height === target.height
				? merged
				: await this.shader.upscale(merged, target);
		// Out-of-order completion is normal in the pipeline: only the newest
		// frame may install the cache, or a slow earlier frame would make the
		// next comparison run against a signature from the future/past.
		if (frame >= this.latestIssuedFrame) {
			this.lastSignature = {
				width: sw,
				height: sh,
				gray: this.computeFrameSignature(snapshot),
			};
			this.lastOutput = { canvas: out, targetWidth: target.width, targetHeight: target.height };
			this.cachedFrameCount = 0;
		}
		return out;
	}

	private staticCacheHit({
		snapshot,
		target,
		frame,
	}: {
		snapshot: OffscreenCanvas;
		target: UpscaleTarget;
		frame: number;
	}): OffscreenCanvas | null {
		if (!this.lastSignature || !this.lastOutput) return null;
		if (
			this.lastSignature.width !== snapshot.width ||
			this.lastSignature.height !== snapshot.height ||
			this.lastOutput.targetWidth !== target.width ||
			this.lastOutput.targetHeight !== target.height
		) {
			return null;
		}
		const current = this.computeFrameSignature(snapshot);
		const prev = this.lastSignature.gray;
		if (current.length !== prev.length) return null;
		let sum = 0;
		let changed = 0;
		for (let i = 0; i < current.length; i++) {
			const d = Math.abs((current[i] ?? 0) - (prev[i] ?? 0));
			sum += d;
			if (d > 2) changed++;
		}
		const mad = sum / current.length;
		// A global mean alone is blind to small localized edits: a subtitle
		// swap or a blinking cursor moves only a few of the 64xN signature
		// cells, so the average stays far under any sane MAD threshold and
		// the frame is wrongly cached — the change freezes for a second or
		// two. Require BOTH a small mean AND a small fraction of changed
		// cells, so "static" really means static.
		const changedRatio = changed / current.length;
		const hit = mad < 1.5 && changedRatio < 0.002;
		if (hit) {
			this.cachedFrameCount++;
		} else {
			// Reset the streak on motion so a re-entering static shot
			// (same scene, different take) can't hit a stale frame.
			this.cachedFrameCount = 0;
		}
		// The cached canvas is handed to the caller and drawn from each time;
		// never hand the same buffer out indefinitely.
		if (this.cachedFrameCount > MAX_CACHED_FRAMES) return null;
		return hit ? this.lastOutput.canvas : null;
	}
}

function attachBilinearAlpha({
	rgb,
	source,
}: {
	rgb: OffscreenCanvas;
	source: CanvasImageSource;
}): OffscreenCanvas {
	const alpha = resize2d(source, { width: rgb.width, height: rgb.height });
	if (!alpha) return rgb;
	const ctx = rgb.getContext("2d");
	if (!ctx) return rgb;
	ctx.globalCompositeOperation = "destination-in";
	ctx.drawImage(alpha, 0, 0);
	ctx.globalCompositeOperation = "source-over";
	return rgb;
}

function sourceWidthOf(source: CanvasImageSource): number {
	const w = (source as { width?: unknown }).width;
	if (typeof w === "number" && w > 0) return w;
	const vw = (source as { videoWidth?: unknown }).videoWidth;
	return typeof vw === "number" && vw > 0 ? vw : 0;
}

function sourceHeightOf(source: CanvasImageSource): number {
	const h = (source as { height?: unknown }).height;
	if (typeof h === "number" && h > 0) return h;
	const vh = (source as { videoHeight?: unknown }).videoHeight;
	return typeof vh === "number" && vh > 0 ? vh : 0;
}

registerAiUpscaler(() => new AiUpscaler());
