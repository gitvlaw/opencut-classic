import { registerAiUpscaler } from "./index";
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

	async upscale(
		source: CanvasImageSource,
		target: UpscaleTarget,
	): Promise<OffscreenCanvas> {
		try {
			return await this.upscaleAi(source, target);
		} catch (error) {
			console.warn("AI upscale failed, falling back to shader:", error);
			return this.shader.upscale(source, target);
		}
	}

	dispose(): void {
		upscaleService.dispose();
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

		const doubled = await upscaleService.upscaleFrame(snapshot);
		const merged = attachBilinearAlpha({ rgb: doubled, source });
		// Exact target size (2x output rarely matches, e.g. 720p -> 1080p).
		if (merged.width === target.width && merged.height === target.height) {
			return merged;
		}
		return this.shader.upscale(merged, target);
	}
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
