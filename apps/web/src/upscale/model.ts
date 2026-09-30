import {
	fetchModelWithCache,
	type ModelConfig,
} from "@/services/vocal-separation/model/config";

/**
 * Real-CUGAN 2x weights (FP32 ONNX, ~5MB). Swap `url` for another 2x
 * no-denoise CUGAN export — the worker only assumes RGB 0..1 NCHW in
 * and 2x RGB out. Audio fields below are unused dummies required by
 * the shared ModelConfig shape.
 */
export const UPSCALE_MODEL_CONFIG: ModelConfig = {
	id: "cugan2x-general",
	name: "Real-CUGAN 2x (general photo)",
	url: "/models/cugan2x-general.onnx",
	cacheKey: "opencut-upscale-cugan2x-v1",
	approxSizeMb: 5,
	sampleRate: 0,
	nFft: 0,
	hopSize: 0,
	dimF: 0,
	dimT: 0,
	compensate: 1,
	segmentSamples: 0,
};

export { fetchModelWithCache };
