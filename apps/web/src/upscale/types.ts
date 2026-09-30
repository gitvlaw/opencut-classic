export type UpscaleMethod = "shader" | "ai";

/** WGSL upscale filter modes (must match upscale.wgsl data[0]). */
export const UPSCALE_BILINEAR = 0;
export const UPSCALE_BICUBIC = 1;
export const UPSCALE_LANCZOS = 2;

export interface UpscaleTarget {
	width: number;
	height: number;
}

export interface UpscaleRequest extends UpscaleTarget {
	method: UpscaleMethod;
}

/**
 * Resolution-change backend. Shader = realtime WGSL (Lanczos3); AI =
 * Real-CUGAN worker (slow, export-time). Both sides of the boundary speak
 * plain canvases so the export loop doesn't care which one runs.
 */
export interface Upscaler {
	readonly method: UpscaleMethod;
	upscale(
		source: CanvasImageSource,
		target: UpscaleTarget,
	): Promise<OffscreenCanvas>;
	dispose?(): void;
}

/** 1080p target preserving canvas aspect, even dimensions for encoders. */
export function compute1080pTarget(canvasWidth: number, canvasHeight: number): UpscaleTarget {
	if (canvasWidth <= 0 || canvasHeight <= 0) {
		return { width: 1920, height: 1080 };
	}
	const height = 1080;
	const width = Math.max(2, Math.round(((1080 * canvasWidth) / canvasHeight) / 2) * 2);
	return { width, height };
}

/** Only offer upscale when the canvas is actually smaller than 1080p. */
export function shouldOfferUpscale(canvasWidth: number, canvasHeight: number): boolean {
	return canvasWidth > 0 && canvasHeight > 0 && canvasHeight < 1080;
}

/** Snapshot any canvas source into an OffscreenCanvas (2D copy). */
export function snapshotToOffscreen(
	source: CanvasImageSource,
	width: number,
	height: number,
): OffscreenCanvas | null {
	try {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(source, 0, 0, width, height);
		return canvas;
	} catch {
		return null;
	}
}

/** High-quality 2D resize fallback (also used when WebGPU is missing). */
export function resize2d(
	source: CanvasImageSource,
	target: UpscaleTarget,
): OffscreenCanvas | null {
	try {
		const canvas = new OffscreenCanvas(target.width, target.height);
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		const w = (source as { width?: unknown }).width;
		const h = (source as { height?: unknown }).height;
		const sw = typeof w === "number" && w > 0 ? w : target.width;
		const sh = typeof h === "number" && h > 0 ? h : target.height;
		ctx.clearRect(0, 0, target.width, target.height);
		ctx.drawImage(source, 0, 0, sw, sh, 0, 0, target.width, target.height);
		return canvas;
	} catch {
		return null;
	}
}
