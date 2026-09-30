/// <reference lib="webworker" />

import * as ort from "onnxruntime-web";
import { computeTiles, tileWeight } from "./tiling";
import type {
	UpscaleInboundMessage,
	UpscaleOutboundMessage,
} from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const UPSCALE_FACTOR = 2;
const TILE_SIZE = 256;
const TILE_OVERLAP = 16;

let session: ort.InferenceSession | null = null;
let isCancelled = false;

const origin = typeof self !== "undefined" && self.location?.origin ? self.location.origin : "";
ort.env.wasm.wasmPaths = origin ? `${origin}/onnx/` : "/onnx/";
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

function post(message: UpscaleOutboundMessage, transfer?: Transferable[]) {
	self.postMessage(message, transfer ?? []);
}

self.onmessage = async (event: MessageEvent<UpscaleInboundMessage>) => {
	const message = event.data;
	switch (message.type) {
		case "init":
			await handleInit(message.model);
			break;
		case "upscale-image":
			await handleUpscaleImage(message.id, message.width, message.height, message.data);
			break;
		case "cancel":
			isCancelled = true;
			post({ type: "cancelled" });
			break;
	}
};

async function handleInit(model: ArrayBuffer): Promise<void> {
	isCancelled = false;
	if (!model || model.byteLength < 1000) {
		post({ type: "error", message: "Upscale model buffer is empty" });
		return;
	}

	try {
		session = await ort.InferenceSession.create(model, {
			executionProviders: ["webgpu"],
			graphOptimizationLevel: "all",
		});
		post({ type: "init_complete", executionProvider: "webgpu" });
	} catch (webgpuErr) {
		console.warn("Upscale WebGPU failed, trying WASM:", webgpuErr);
		try {
			session = await ort.InferenceSession.create(model, {
				executionProviders: ["wasm"],
				graphOptimizationLevel: "all",
			});
			post({ type: "init_complete", executionProvider: "wasm" });
		} catch (wasmErr) {
			post({ type: "error", message: `No inference backend: ${String(wasmErr)}` });
		}
	}
}

async function handleUpscaleImage(
	id: number,
	width: number,
	height: number,
	data: Float32Array,
): Promise<void> {
	try {
		isCancelled = false;
		if (!session) throw new Error("Upscale session is not initialized");
		if (data.length !== width * height * 3) {
			throw new Error(`Bad frame buffer: ${data.length} for ${width}x${height}`);
		}

		const outW = width * UPSCALE_FACTOR;
		const outH = height * UPSCALE_FACTOR;
		const acc = new Float32Array(outW * outH * 3);
		const weights = new Float32Array(outW * outH);

		const tiles = computeTiles(width, height, TILE_SIZE, TILE_OVERLAP);
		const inputName = session.inputNames[0] ?? "input";
		const outputName = session.outputNames[0] ?? "output";

		let done = 0;
		for (const tile of tiles) {
			if (isCancelled) {
				post({ type: "cancelled" });
				return;
			}

			// Crop HWC float tile -> NCHW tensor.
			const plane = tile.w * tile.h;
			const nchw = new Float32Array(3 * plane);
			for (let y = 0; y < tile.h; y++) {
				for (let x = 0; x < tile.w; x++) {
					const src = ((tile.y + y) * width + (tile.x + x)) * 3;
					const px = y * tile.w + x;
					nchw[px] = data[src] ?? 0;
					nchw[plane + px] = data[src + 1] ?? 0;
					nchw[2 * plane + px] = data[src + 2] ?? 0;
				}
			}

			const feeds: Record<string, ort.Tensor> = {};
			feeds[inputName] = new ort.Tensor("float32", nchw, [1, 3, tile.h, tile.w]);
			const results = await session.run(feeds);
			const out = results[outputName]?.data as Float32Array | undefined;
			if (!out) throw new Error("Upscale model returned no output");

			const oh = tile.h * UPSCALE_FACTOR;
			const ow = tile.w * UPSCALE_FACTOR;
			for (let y = 0; y < oh; y++) {
				for (let x = 0; x < ow; x++) {
					const sx = Math.min(tile.w - 1, Math.floor(x / UPSCALE_FACTOR));
					const sy = Math.min(tile.h - 1, Math.floor(y / UPSCALE_FACTOR));
					const w = tileWeight(tile, sx, sy, TILE_OVERLAP);
					if (w <= 0) continue;
					const gx = (tile.y * UPSCALE_FACTOR + y) * outW + (tile.x * UPSCALE_FACTOR + x);
					const o = (y * ow + x) * 3;
					acc[gx * 3] += (out[o] ?? 0) * w;
					acc[gx * 3 + 1] += (out[o + 1] ?? 0) * w;
					acc[gx * 3 + 2] += (out[o + 2] ?? 0) * w;
					weights[gx] += w;
				}
			}

			done++;
			post({
				type: "tile_progress",
				id,
				done,
				total: tiles.length,
				percentage: Math.min(99, Math.round((done / tiles.length) * 100)),
			});
		}

		for (let i = 0; i < weights.length; i++) {
			const w = weights[i] ?? 0;
			if (w > 1e-6) {
				acc[i * 3] = Math.min(1, Math.max(0, (acc[i * 3] ?? 0) / w));
				acc[i * 3 + 1] = Math.min(1, Math.max(0, (acc[i * 3 + 1] ?? 0) / w));
				acc[i * 3 + 2] = Math.min(1, Math.max(0, (acc[i * 3 + 2] ?? 0) / w));
			}
		}

		post(
			{ type: "image_complete", id, width: outW, height: outH, data: acc },
			[acc.buffer as Transferable],
		);
	} catch (error) {
		post({ type: "error", message: error instanceof Error ? error.message : String(error) });
	}
}
