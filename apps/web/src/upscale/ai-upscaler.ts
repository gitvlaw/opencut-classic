import { registerAiUpscaler } from "./registry";
import { upscaleService } from "./service";
import { ShaderUpscaler } from "./shader-upscaler";
import { resize2d, snapshotToOffscreen } from "./types";
import type { Upscaler, UpscaleTarget } from "./types";

/**
 * AI upscaler: CUGAN 2x worker, then an exact Lanczos resize to the
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

	async upscale(
		source: CanvasImageSource,
		target: UpscaleTarget,
	): Promise<OffscreenCanvas> {
		try {
			return await this.upscaleAi(source, target);
		} catch (error) {
			console.warn("AI upscale failed, falling back to shader:", error);
			this.lastSignature = null;
			this.lastOutput = null;
			return this.shader.upscale(source, target);
		}
	}

	dispose(): void {
		upscaleService.dispose();
		this.lastSignature = null;
		this.lastOutput = null;
	}

	private async upscaleAi(
		source: CanvasImageSource,
		target: UpscaleTarget,
	): Promise<OffscreenCanvas> {
		const sw = sourceWidthOf(source);
		const sh = sourceHeightOf(source);
		if (sw <= 0 || sh <= 0) throw new Error("Bad upscale source size");
		const snapshot = snapshotToOffscreen(source, sw, sh);
		if (!snapshot) throw new Error("Failed to snapshot frame");

		// Static-scene shortcut: talking heads barely change frame to
		// frame — reuse the last AI output instead of re-inferring.
		const cached = this.staticCacheHit(snapshot, target);
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
		this.lastSignature = { width: sw, height: sh, gray: frameSignature(snapshot) };
		this.lastOutput = { canvas: out, targetWidth: target.width, targetHeight: target.height };
		return out;
	}

	private staticCacheHit(
		snapshot: OffscreenCanvas,
		target: UpscaleTarget,
	): OffscreenCanvas | null {
		if (!this.lastSignature || !this.lastOutput) return null;
		if (
			this.lastSignature.width !== snapshot.width ||
			this.lastSignature.height !== snapshot.height ||
			this.lastOutput.targetWidth !== target.width ||
			this.lastOutput.targetHeight !== target.height
		) {
			return null;
		}
		const current = frameSignature(snapshot);
		const prev = this.lastSignature.gray;
		if (current.length !== prev.length) return null;
		let mad = 0;
		for (let i = 0; i < current.length; i++) mad += Math.abs((current[i] ?? 0) - (prev[i] ?? 0));
		mad /= current.length;
		// ~1.5 gray levels average change: below human-noticeable motion.
		return mad < 1.5 ? this.lastOutput.canvas : null;
	}
}

/** Tiny 64px grayscale signature for static-frame detection. */
function frameSignature(source: OffscreenCanvas): Float32Array {
	const w = 64;
	const h = Math.max(1, Math.round((64 * source.height) / Math.max(1, source.width)));
	const small = new OffscreenCanvas(w, h);
	const ctx = small.getContext("2d", { willReadFrequently: true });
	if (!ctx) return new Float32Array(0);
	ctx.drawImage(source, 0, 0, w, h);
	const img = ctx.getImageData(0, 0, w, h);
	const out = new Float32Array(w * h);
	for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
		out[j] = 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
	}
	return out;
}

/** Re-attach alpha: bilinear-upscaled source alpha over AI RGB. */
function attachBilinearAlpha({
	rgb,
	source,
}: {
	rgb: OffscreenCanvas;
	source: CanvasImageSource;
}): OffscreenCanvas {
	const alpha = resize2d(source, { width: rgb.width, height: rgb.height });
	const rgbCtx = rgb.getContext("2d", { willReadFrequently: true });
	const alphaCtx = alpha?.getContext("2d", { willReadFrequently: true });
	if (!rgbCtx || !alphaCtx) return rgb;
	let rgbImg: ImageData;
	let alphaImg: ImageData;
	try {
		rgbImg = rgbCtx.getImageData(0, 0, rgb.width, rgb.height);
		alphaImg = alphaCtx.getImageData(0, 0, rgb.width, rgb.height);
	} catch {
		return rgb;
	}
	const rp = rgbImg.data;
	const ap = alphaImg.data;
	for (let i = 0; i < rp.length; i += 4) {
		rp[i + 3] = ap[i + 3] ?? 255;
	}
	rgbCtx.putImageData(rgbImg, 0, 0);
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
