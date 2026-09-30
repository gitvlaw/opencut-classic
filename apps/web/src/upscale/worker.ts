/// <reference lib="webworker" />

import * as ort from "onnxruntime-web";
import { computeTiles, tileWeightX, tileWeightY } from "./tiling";
import { assertNchwDims, packHwcToNchwInto } from "./tensor";
import type {
	UpscaleInboundMessage,
	UpscaleOutboundMessage,
} from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const UPSCALE_FACTOR = 2;
const DEFAULT_TILE_SIZE = 256;
const TILE_OVERLAP = 16;
/** ~48M output pixels (8192x5760). Beyond this the accumulator alone would
 * need ~600MB and the tab dies instead of exporting. */
const MAX_OUTPUT_PIXELS = 48_000_000;

let session: ort.InferenceSession | null = null;
let isCancelled = false;

/** Reused across frames — a fresh 100MB accumulator per frame thrashes GC. */
let accumulators: { acc: Float32Array; weights: Float32Array; w: number; h: number } | null =
	null;
let scratch: { cropped: Float32Array; nchw: Float32Array; size: number } | null = null;

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
			await handleUpscaleImage(
				message.id,
				message.width,
				message.height,
				message.data,
				message.tileSize,
			);
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
	tileSize: number,
): Promise<void> {
	try {
		isCancelled = false;
		if (!session) throw new Error("Upscale session is not initialized");
		if (data.length !== width * height * 3) {
			throw new Error(`Bad frame buffer: ${data.length} for ${width}x${height}`);
		}
		const tile = Math.max(64, Math.min(1024, Math.floor(tileSize) || DEFAULT_TILE_SIZE));

		const outW = width * UPSCALE_FACTOR;
		const outH = height * UPSCALE_FACTOR;
		if (outW * outH > MAX_OUTPUT_PIXELS) {
			throw new Error(
				`Upscale target ${outW}x${outH} is too large for the AI path. ` +
					"Pick a smaller resolution, or export without AI enhance.",
			);
		}
		if (!accumulators || accumulators.w !== outW || accumulators.h !== outH) {
			accumulators = {
				acc: new Float32Array(outW * outH * 3),
				weights: new Float32Array(outW * outH),
				w: outW,
				h: outH,
			};
		}
		const { acc, weights } = accumulators;
		acc.fill(0);
		weights.fill(0);

		const tiles = computeTiles(width, height, tile, TILE_OVERLAP);
		const inputName = session.inputNames[0] ?? "input";
		const outputName = session.outputNames[0] ?? "output";

		let done = 0;
		let inferMsTotal = 0;
		// Per-tile feather ramps. tileWeight is separable, so build the two
		// 1D tables once per tile instead of calling it per output pixel.
		// MUST be rebuilt per tile: the ramps depend on the shared edges.
		const wxRamp = new Float32Array(tile * UPSCALE_FACTOR);
		const wyRamp = new Float32Array(tile * UPSCALE_FACTOR);
		for (const t of tiles) {
			if (isCancelled) {
				post({ type: "cancelled" });
				return;
			}

			const tw = t.w;
			const th = t.h;
			const needed = tw * th * 3;
			if (!scratch || scratch.size < needed) {
				scratch = { cropped: new Float32Array(needed), nchw: new Float32Array(needed), size: needed };
			}
			const { cropped, nchw } = scratch;

			// Row-wise crop of the HWC float frame into the tile buffer.
			for (let y = 0; y < th; y++) {
				const srcStart = ((t.y + y) * width + t.x) * 3;
				cropped.set(data.subarray(srcStart, srcStart + tw * 3), y * tw * 3);
			}
			packHwcToNchwInto({ src: cropped, width: tw, height: th, dst: nchw });

			const feeds: Record<string, ort.Tensor> = {};
			feeds[inputName] = new ort.Tensor("float32", nchw.subarray(0, tw * th * 3), [1, 3, th, tw]);
			const inferStart = performance.now();
			const results = await session.run(feeds);
			inferMsTotal += performance.now() - inferStart;
			const outputTensor = results[outputName];
			const out = outputTensor?.data as ArrayLike<number> | undefined;
			if (!out) throw new Error("Upscale model returned no output");
			const oh = th * UPSCALE_FACTOR;
			const ow = tw * UPSCALE_FACTOR;
			// NCHW planar output, dims-validated (never silently mosaiced).
			const dims = outputTensor?.dims as readonly number[] | undefined;
			if (!dims) throw new Error("Upscale model returned output without dims");
			assertNchwDims(dims, ow, oh, "upscale output");
			const plane = ow * oh;

			for (let x = 0; x < ow; x++) {
				wxRamp[x] = tileWeightX({ tile: t, lx: Math.min(tw - 1, x >> 1), overlap: TILE_OVERLAP });
			}
			for (let y = 0; y < oh; y++) {
				wyRamp[y] = tileWeightY({ tile: t, ly: Math.min(th - 1, y >> 1), overlap: TILE_OVERLAP });
			}

			const tileOriginX = t.x * UPSCALE_FACTOR;
			const tileOriginY = t.y * UPSCALE_FACTOR;
			for (let y = 0; y < oh; y++) {
				const wy = wyRamp[y] ?? 0;
				if (wy <= 0) continue;
				const dstRow = (tileOriginY + y) * outW;
				const srcRow = y * ow;
				for (let x = 0; x < ow; x++) {
					const w = (wxRamp[x] ?? 0) * wy;
					if (w <= 0) continue;
					const gx = dstRow + tileOriginX + x;
					const o = (srcRow + x) * 3;
					const gi = gx * 3;
					acc[gi] = (acc[gi] ?? 0) + (out[o] ?? 0) * w;
					acc[gi + 1] = (acc[gi + 1] ?? 0) + (out[plane + o] ?? 0) * w;
					acc[gi + 2] = (acc[gi + 2] ?? 0) + (out[2 * plane + o] ?? 0) * w;
					weights[gx] = (weights[gx] ?? 0) + w;
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
			{
				type: "image_complete",
				id,
				width: outW,
				height: outH,
				data: acc,
				avgTileMs: tiles.length > 0 ? inferMsTotal / tiles.length : 0,
			},
			[acc.buffer as Transferable],
		);
		// The transfer detached the buffer — drop the cache so the next frame
		// allocates instead of writing into a detached view.
		accumulators = null;
	} catch (error) {
		post({ type: "error", message: error instanceof Error ? error.message : String(error) });
	}
}