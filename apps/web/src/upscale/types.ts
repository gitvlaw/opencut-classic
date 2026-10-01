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
 * Real-ESRGAN worker (slow, export-time). Both sides of the boundary speak
 * plain canvases so the export loop doesn't care which one runs.
 */
export interface Upscaler {
	readonly method: UpscaleMethod;
	upscale(
		source: CanvasImageSource,
		target: UpscaleTarget,
	): Promise<OffscreenCanvas>;
	/** Abort the in-flight frame. Must settle the pending `upscale` call. */
	cancel?(): void;
	dispose?(): void;
}

/** 1080p target preserving canvas aspect, even dimensions for encoders. */
export function compute1080pTarget(canvasWidth: number, canvasHeight: number): UpscaleTarget {
	if (canvasWidth <= 0 || canvasHeight <= 0) {
		return { width: 1920, height: 1080 };
	}
	if (canvasHeight >= canvasWidth) {
		// Portrait: 1080 wide, height scaled.
		const width = 1080;
		const height = Math.max(2, Math.round(((1080 * canvasHeight) / canvasWidth) / 2) * 2);
		return { width, height };
	}
	const height = 1080;
	const width = Math.max(2, Math.round(((1080 * canvasWidth) / canvasHeight) / 2) * 2);
	return { width, height };
}

/** 4K UHD target: exact 2x of canvas (even dims), ideal for the AI 2x model. */
export function compute4kTarget(canvasWidth: number, canvasHeight: number): UpscaleTarget {
	if (canvasWidth <= 0 || canvasHeight <= 0) {
		return { width: 3840, height: 2160 };
	}
	const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
	return { width: even(canvasWidth * 2), height: even(canvasHeight * 2) };
}

/**
 * Offer the 1080p family when the canvas is below it on its short side
 * (landscape height / portrait width). A 1080x1920 portrait is already
 * there — it gets the 4K option instead.
 */
export function shouldOfferUpscale(canvasWidth: number, canvasHeight: number): boolean {
	if (canvasWidth <= 0 || canvasHeight <= 0) return false;
	return Math.min(canvasWidth, canvasHeight) < 1080;
}

/** Offer 4K UHD while the long side is below it. */
export function shouldOffer4k(canvasWidth: number, canvasHeight: number): boolean {
	if (canvasWidth <= 0 || canvasHeight <= 0) return false;
	return Math.max(canvasWidth, canvasHeight) < 3840;
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
