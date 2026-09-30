import {
	fetchModelWithCache,
	type ModelConfig,
} from "@/services/vocal-separation/model/config";

/**
 * Real-CUGAN 2x photo/video weights (FP32). The worker feeds float32 NCHW
 * and reads float32 NCHW back, 2x spatial — the only model shape it
 * supports. FP16 exports need a float16 tensor in AND out (ORT rejects a
 * float32 feed outright), so they are not drop-in replacements here.
 */
export const UPSCALE_MODEL_CONFIG: ModelConfig = {
	id: "cugan2x-general",
	name: "Real-CUGAN 2x (general photo)",
	url: "/models/cugan2x-general.onnx",
	cacheKey: "opencut-upscale-cugan2x-v1",
	approxSizeMb: 5,
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
