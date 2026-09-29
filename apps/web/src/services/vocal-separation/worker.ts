/// <reference lib="webworker" />

import * as ort from "onnxruntime-web";
import { MDXProcessor } from "./dsp/mdx-processor";
import {
	VOCAL_MODEL_CONFIG,
	fetchModelWithCache,
} from "./model/config";
import type {
	SeparationMode,
	WorkerInboundMessage,
	WorkerOutboundMessage,
} from "./types";

declare const self: DedicatedWorkerGlobalScope;

let session: ort.InferenceSession | null = null;
let isCancelled = false;

// Configure ONNX Runtime WebAssembly environment
const origin = typeof self !== "undefined" && self.location?.origin ? self.location.origin : "";
ort.env.wasm.wasmPaths = origin ? `${origin}/onnx/` : "/onnx/";
ort.env.wasm.numThreads = 1; // Safe for all browser contexts without requiring COOP/COEP headers
ort.env.wasm.proxy = false;

function post(message: WorkerOutboundMessage, transfer?: Transferable[]) {
	self.postMessage(message, transfer ?? []);
}

self.onmessage = async (event: MessageEvent<WorkerInboundMessage>) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			await handleInit(message.modelUrl);
			break;

		case "process":
			await handleProcess(
				message.leftChannel,
				message.rightChannel,
				message.sampleRate,
				message.mode,
			);
			break;

		case "cancel":
			isCancelled = true;
			post({ type: "cancelled" });
			break;
	}
};

async function handleInit(modelUrl?: string): Promise<void> {
	isCancelled = false;

	const config = {
		...VOCAL_MODEL_CONFIG,
		...(modelUrl ? { url: modelUrl } : {}),
	};

	let buffer: ArrayBuffer | null = null;
	try {
		buffer = await fetchModelWithCache(config, (loaded, total) => {
			const percentage = total > 0 ? Math.round((loaded / total) * 100) : 0;
			post({
				type: "init_progress",
				loaded,
				total,
				percentage,
			});
		});
	} catch (downloadErr) {
		console.warn("Model download failed or offline, falling back to DSP engine:", downloadErr);
	}

	let executionProvider = "dsp";
	if (buffer && buffer.byteLength > 1000) {
		try {
			// 1. Try WebGPU first for GPU acceleration
			session = await ort.InferenceSession.create(buffer, {
				executionProviders: ["webgpu"],
				graphOptimizationLevel: "all",
			});
			executionProvider = "webgpu";
			console.log("MDX-Net session successfully created with WebGPU backend");
		} catch (webgpuErr) {
			console.warn("WebGPU initialization failed, trying WASM fallback:", webgpuErr);
			try {
				// 2. Try WASM fallback
				session = await ort.InferenceSession.create(buffer, {
					executionProviders: ["wasm"],
					graphOptimizationLevel: "all",
				});
				executionProvider = "wasm";
				console.log("MDX-Net session successfully created with WASM backend");
			} catch (wasmErr) {
				console.warn(
					"Both WebGPU and WASM backends unavailable, falling back to DSP Isolation:",
					wasmErr,
				);
				executionProvider = "dsp";
				session = null;
			}
		}
	} else {
		executionProvider = "dsp";
		session = null;
	}

	post({
		type: "init_complete",
		executionProvider,
	});
}

async function handleProcess(
	left: Float32Array,
	right: Float32Array,
	sampleRate: number,
	mode: SeparationMode,
): Promise<void> {
	try {
		isCancelled = false;
		const totalSamples = Math.min(left.length, right.length);
		if (totalSamples === 0) {
			throw new Error("Input audio channels are empty");
		}

		const mdx = new MDXProcessor({
			nFft: VOCAL_MODEL_CONFIG.nFft,
			hop: VOCAL_MODEL_CONFIG.hopSize,
			dimF: VOCAL_MODEL_CONFIG.dimF,
			dimT: VOCAL_MODEL_CONFIG.dimT,
		});

		const segmentSamples = mdx.chunkSize; // 261,120 samples (~5.92s at 44.1kHz)
		const overlapSamples = segmentSamples >> 1; // 50% overlap = 130,560 samples
		const stepSamples = segmentSamples - overlapSamples;

		// Precompute Hann crossfade window for chunk overlap-add
		const crossfadeWindow = new Float32Array(segmentSamples);
		for (let i = 0; i < segmentSamples; i++) {
			crossfadeWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / segmentSamples));
		}

		// Allocate output accumulation buffers
		const vocalsLeft = new Float32Array(totalSamples);
		const vocalsRight = new Float32Array(totalSamples);
		const instLeft = new Float32Array(totalSamples);
		const instRight = new Float32Array(totalSamples);
		const weightBuffer = new Float32Array(totalSamples);

		// Calculate total chunks for progress tracking
		const totalChunks = Math.max(
			1,
			Math.ceil((totalSamples - overlapSamples) / stepSamples),
		);

		let currentChunk = 0;
		const compensate = VOCAL_MODEL_CONFIG.compensate ?? 1.035;

		for (let start = 0; start < totalSamples; start += stepSamples) {
			if (isCancelled) {
				post({ type: "cancelled" });
				return;
			}

			const end = Math.min(start + segmentSamples, totalSamples);
			const chunkLen = end - start;

			// Extract chunk with zero-padding to segmentSamples
			const chunkL = new Float32Array(segmentSamples);
			const chunkR = new Float32Array(segmentSamples);
			chunkL.set(left.subarray(start, end));
			chunkR.set(right.subarray(start, end));

			let chunkVocalL: Float32Array;
			let chunkVocalR: Float32Array;
			let chunkInstL: Float32Array;
			let chunkInstR: Float32Array;

			if (session) {
				try {
					// 1. Forward STFT into [1, 4, 3072, 256] tensor
					const tensorData = mdx.stft(chunkL, chunkR);
					const inputTensor = new ort.Tensor("float32", tensorData, [
						1,
						4,
						mdx.dimF,
						mdx.dimT,
					]);

					const feeds: Record<string, ort.Tensor> = {};
					feeds[session.inputNames[0] ?? "input"] = inputTensor;

					// 2. Run ONNX Inference
					const results = await session.run(feeds);
					const outputName = session.outputNames[0] ?? "output";
					const outData = results[outputName].data as Float32Array;

					// 3. Inverse STFT synthesis of isolated vocals
					const synth = mdx.istft(outData);

					// 4. Apply volume compensation (UVR standard 1.035)
					for (let i = 0; i < segmentSamples; i++) {
						synth.left[i] *= compensate;
						synth.right[i] *= compensate;
					}

					chunkVocalL = synth.left;
					chunkVocalR = synth.right;

					// 5. Phase cancellation for Instrumental: Original - Vocals
					chunkInstL = new Float32Array(segmentSamples);
					chunkInstR = new Float32Array(segmentSamples);
					for (let i = 0; i < segmentSamples; i++) {
						chunkInstL[i] = chunkL[i] - chunkVocalL[i];
						chunkInstR[i] = chunkR[i] - chunkVocalR[i];
					}
				} catch (inferErr) {
					console.warn("AI inference failed on chunk, using DSP fallback:", inferErr);
					const dspResult = processChunkWithDsp(chunkL, chunkR);
					chunkVocalL = dspResult.vocalL;
					chunkVocalR = dspResult.vocalR;
					chunkInstL = dspResult.instL;
					chunkInstR = dspResult.instR;
				}
			} else {
				// Fallback DSP Vocal Isolation
				const dspResult = processChunkWithDsp(chunkL, chunkR);
				chunkVocalL = dspResult.vocalL;
				chunkVocalR = dspResult.vocalR;
				chunkInstL = dspResult.instL;
				chunkInstR = dspResult.instR;
			}

			// Crossfade windowing and accumulate into master buffers
			const validSamples = Math.min(chunkLen, segmentSamples);
			for (let i = 0; i < validSamples; i++) {
				const outIdx = start + i;
				if (outIdx < totalSamples) {
					const w = crossfadeWindow[i];
					vocalsLeft[outIdx] += chunkVocalL[i] * w;
					vocalsRight[outIdx] += chunkVocalR[i] * w;
					instLeft[outIdx] += chunkInstL[i] * w;
					instRight[outIdx] += chunkInstR[i] * w;
					weightBuffer[outIdx] += w;
				}
			}

			currentChunk++;
			const percentage = Math.min(
				99,
				Math.round((currentChunk / totalChunks) * 100),
			);
			post({
				type: "process_progress",
				currentChunk,
				totalChunks,
				percentage,
			});
		}

		// Normalize master buffers by accumulated crossfade weights
		for (let i = 0; i < totalSamples; i++) {
			const w = weightBuffer[i];
			if (w > 1e-4) {
				vocalsLeft[i] /= w;
				vocalsRight[i] /= w;
				instLeft[i] /= w;
				instRight[i] /= w;
			}
		}

		// Prepare results according to mode
		const transferables: Transferable[] = [];
		let resVocalsL: Float32Array | undefined;
		let resVocalsR: Float32Array | undefined;
		let resInstL: Float32Array | undefined;
		let resInstR: Float32Array | undefined;

		if (mode === "both" || mode === "vocals_only") {
			resVocalsL = vocalsLeft;
			resVocalsR = vocalsRight;
			transferables.push(vocalsLeft.buffer, vocalsRight.buffer);
		}
		if (mode === "both" || mode === "instrumental_only") {
			resInstL = instLeft;
			resInstR = instRight;
			transferables.push(instLeft.buffer, instRight.buffer);
		}

		post(
			{
				type: "process_complete",
				vocalsLeft: resVocalsL,
				vocalsRight: resVocalsR,
				instrumentalLeft: resInstL,
				instrumentalRight: resInstR,
				sampleRate,
				length: totalSamples,
			},
			transferables,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		post({ type: "error", message });
	}
}

/**
 * Mid-Side Harmonic Spectral Panning Vocal Isolation Fallback
 * Used only when offline or model is compiling/unavailable.
 */
function processChunkWithDsp(
	chunkL: Float32Array,
	chunkR: Float32Array,
): {
	vocalL: Float32Array;
	vocalR: Float32Array;
	instL: Float32Array;
	instR: Float32Array;
} {
	const len = chunkL.length;
	const vocalL = new Float32Array(len);
	const vocalR = new Float32Array(len);
	const instL = new Float32Array(len);
	const instR = new Float32Array(len);

	for (let i = 0; i < len; i++) {
		const l = chunkL[i];
		const r = chunkR[i];
		const mid = (l + r) * 0.5;
		const side = (l - r) * 0.5;

		// Mid contains center vocal, side contains stereo instrumental
		vocalL[i] = mid;
		vocalR[i] = mid;
		instL[i] = side;
		instR[i] = -side;
	}

	return { vocalL, vocalR, instL, instR };
}
