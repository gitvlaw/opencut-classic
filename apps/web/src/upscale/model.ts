import {
	fetchModelWithCache,
	type ModelConfig,
} from "@/services/vocal-separation/model/config";

function audioDummy(): Pick<
	ModelConfig,
	"sampleRate" | "nFft" | "hopSize" | "dimF" | "dimT" | "compensate" | "segmentSamples"
> {
	// Unused by the image path (audio-only fields of the shared config).
	return {
		sampleRate: 0,
		nFft: 0,
		hopSize: 0,
		dimF: 0,
		dimT: 0,
		compensate: 1,
		segmentSamples: 0,
	};
}

/**
 * Real-CUGAN 2x weights (HFA2k photo model, ONNX opset17). FP16 is tried
 * first on WebGPU (half bandwidth + faster math on RTX); FP32 is the
 * universal fallback (also what the WASM EP runs). Swap `url` for another
 * 2x no-denoise CUGAN export — the worker only assumes RGB 0..1 NCHW in
 * and 2x RGB out.
 */
export const UPSCALE_MODEL_FP16: ModelConfig = {
	id: "cugan2x-fp16",
	name: "Real-CUGAN 2x FP16",
	url: "/models/cugan2x-fp16.onnx",
	cacheKey: "opencut-upscale-cugan2x-fp16-v1",
	approxSizeMb: 3,
	...audioDummy(),
};

export const UPSCALE_MODEL_FP32: ModelConfig = {
	id: "cugan2x-general",
	name: "Real-CUGAN 2x (general photo)",
	url: "/models/cugan2x-general.onnx",
	cacheKey: "opencut-upscale-cugan2x-v1",
	approxSizeMb: 5,
	...audioDummy(),
};

export { fetchModelWithCache };
