import {
	fetchModelWithCache,
	type ModelConfig,
} from "@/services/vocal-separation/model/config";

/**
 * Real-ESRGAN x2plus (FP32), the RRDBNet used by Real-ESRGAN's compact
 * "shuffle" models. The worker feeds float32 NCHW and reads float32 NCHW
 * back, 2x spatial.
 *
 * The shipped graph is the INNER network only: it takes a 2x pixel-unshuffled
 * tensor `[1, 12, h, w]` and returns `[1, 3, 4h, 4w]`, so the caller's
 * reflect-pad to even dimensions, pixel-unshuffle, and crop back to 2x
 * together reproduce spandrel's ESRGAN wrapper. Exporting the wrapper itself
 * is not an option — its `if pad_h or pad_w` padding branch is Python
 * control flow that torch's tracer constant-folds, yielding a graph that
 * only accepts the exact size traced at export time.
 *
 * FP16 exports need a float16 tensor in AND out (ORT rejects a float32 feed
 * outright), so they are not drop-in replacements here.
 */
export const UPSCALE_MODEL_CONFIG: ModelConfig = {
	id: "real-esrgan-x2plus",
	name: "Real-ESRGAN 2x (photo/video)",
	// Absolute URL: the worker has no Next.js basePath, so a root-relative
	// path 404s under any non-root deployment. Ship the file at /public root.
	url: "/models/real-esrgan-x2plus.onnx",
	cacheKey: "opencut-upscale-real-esrgan-x2plus-v1",
	approxSizeMb: 64,
	// Unused by the image path (audio-only fields of the shared config).
	sampleRate: 0,
	nFft: 0,
	hopSize: 0,
	dimF: 0,
	dimT: 0,
	compensate: 1,
	segmentSamples: 0,
};

export { fetchModelWithCache };
