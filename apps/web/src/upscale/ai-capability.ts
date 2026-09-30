/**
 * AI upscale needs a WebGPU-capable browser (the CUGAN worker tries the
 * `webgpu` execution provider first, `wasm` second). This is a cheap
 * synchronous gate for the export dialog — the worker itself re-verifies
 * at session creation and falls back to the shader path on failure.
 */
export function isAiUpscaleSupported(): boolean {
	try {
		return typeof navigator !== "undefined" && "gpu" in navigator && !!navigator.gpu;
	} catch {
		return false;
	}
}
