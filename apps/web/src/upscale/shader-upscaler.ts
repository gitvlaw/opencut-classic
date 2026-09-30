import * as wasm from "opencut-wasm";
import { initializeGpuRenderer, isGpuAvailable } from "@/services/renderer/gpu-renderer";
import {
	resize2d,
	snapshotToOffscreen,
	UPSCALE_LANCZOS,
	type Upscaler,
	type UpscaleTarget,
} from "./types";

type WasmUpscaleApi = {
	upscaleImage?: (options: {
		source: OffscreenCanvas;
		srcWidth: number;
		srcHeight: number;
		dstWidth: number;
		dstHeight: number;
		mode: number;
	}) => OffscreenCanvas;
};

/**
 * Realtime WGSL resampler (Lanczos-3). Falls back to 2D canvas smoothing
 * when the deployed wasm bundle predates the upscale shader.
 */
export class ShaderUpscaler implements Upscaler {
	readonly method = "shader" as const;

	async upscale(
		source: CanvasImageSource,
		target: UpscaleTarget,
	): Promise<OffscreenCanvas> {
		const sw = sourceWidthOf(source);
		const sh = sourceHeightOf(source);
		await initializeGpuRenderer();
		try {
			const fn = (wasm as unknown as WasmUpscaleApi).upscaleImage;
			if (isGpuAvailable() && typeof fn === "function" && sw > 0 && sh > 0) {
				const snapshot = snapshotToOffscreen(source, sw, sh);
				if (snapshot) {
					return fn({
						source: snapshot,
						srcWidth: sw,
						srcHeight: sh,
						dstWidth: target.width,
						dstHeight: target.height,
						mode: UPSCALE_LANCZOS,
					});
				}
			}
		} catch (error) {
			console.warn("GPU upscale failed, falling back to 2D resize:", error);
		}
		const fallback = resize2d(source, target);
		if (!fallback) throw new Error("Failed to upscale frame");
		return fallback;
	}
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
