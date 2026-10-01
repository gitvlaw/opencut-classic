/// <reference lib="webworker" />

import * as ort from "onnxruntime-web";
import {
	computeTiles,
	tileWeightX,
	tileWeightY,
	TILE_MARGIN as TILE_MARGIN_PX,
	TILE_OVERLAP as TILE_OVERLAP_PX,
	TILE_SIZE as DEFAULT_TILE_SIZE,
} from "./tiling";
import {
	assertNchwDims,
	padHwcReflectInto,
	packHwcToPixelUnshuffleInto,
} from "./tensor";
import type {
	UpscaleInboundMessage,
	UpscaleOutboundMessage,
} from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

const UPSCALE_FACTOR = 2;
/**
 * Pixel-unshuffle factor baked into the exported graph. The net consumes
 * `3 * SHUFFLE^2` channels at 1/SHUFFLE resolution and upscales 2^SHUFFLE
 * times, so input tile dimensions must be multiples of SHUFFLE.
 */
const SHUFFLE = 2;
const TILE_OVERLAP = TILE_OVERLAP_PX;
/** RealESRGAN's receptive field is wide, so a shared edge loses far more
 * than a few px to zero padding. Crop that margin off every shared edge and
 * feather only the reliable core. Must be >= the model's practical
 * receptive-field radius. */
const TILE_MARGIN = TILE_MARGIN_PX;
// Guard the invariant the feather depends on: trimming TILE_MARGIN off BOTH
// sides of a shared edge leaves a usable blend band of
// (TILE_OVERLAP - 2 * TILE_MARGIN). At zero or below, neighbours only touch,
// the ramps run over already-discarded pixels, and the export comes out as a
// grid of blocks. Fail loudly rather than silently ship seams.
if (TILE_OVERLAP - 2 * TILE_MARGIN <= 0) {
	throw new Error(
		`Tile config would produce hard seams: overlap ${TILE_OVERLAP} must exceed ` +
			`2 * margin ${TILE_MARGIN} (needs > ${2 * TILE_MARGIN}).`,
	);
}
/** A tile smaller than 2 * TILE_MARGIN can lose its whole interior to the
 * margin crop and leave a hole. The shipped tile size clears this easily;
 * clamp defensively so a bad caller value cannot corrupt a frame. */
const MIN_TILE_SIZE = 2 * TILE_MARGIN + 64;
/** ~48M output pixels (8192x5760). Beyond this the accumulator alone would
 * need ~600MB and the tab dies instead of exporting. */
const MAX_OUTPUT_PIXELS = 48_000_000;

let session: ort.InferenceSession | null = null;
/**
 * Cancellation generation. A plain boolean is not enough: every job resets
 * `isCancelled = false` when it starts, so after a cancel the *next queued
 * frame* would clear the flag and burn a full inference anyway. Comparing
 * the generation captured when the job was enqueued against the current one
 * aborts every frame that was already in the pipeline, which is the point.
 */
let cancelGeneration = 0;

let accumulators: { acc: Float32Array; weights: Float32Array; w: number; h: number } | null =
	null;
// Accumulator is reused across frames (only reallocated when output size changes).

let scratch: {
	cropped: Float32Array;
	padded: Float32Array;
	nchw: Float32Array;
	wxRamp: Float32Array;
	wyRamp: Float32Array;
	size: number;
} | null = null;

/** Reused read canvas + float frame. Both are per-frame-sized allocations
 * (4K: 33MB ImageData + 33MB Float32Array), so they are pooled, not
 * re-created on every frame. */
let readCanvas: OffscreenCanvas | null = null;
let readCtx: OffscreenCanvasRenderingContext2D | null = null;
let frameData: Float32Array | null = null;
/** Reused output canvas; only the ImageData is reallocated per frame. */
let resultCanvas: OffscreenCanvas | null = null;
let resultCtx: OffscreenCanvasRenderingContext2D | null = null;

const origin = typeof self !== "undefined" && self.location?.origin ? self.location.origin : "";
ort.env.wasm.wasmPaths = origin ? `${origin}/onnx/` : "/onnx/";
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

function post(message: UpscaleOutboundMessage, transfer?: Transferable[]) {
	self.postMessage(message, transfer ?? []);
}

/**
 * Jobs run strictly one at a time. `onmessage` is an async function, so two
 * frames arriving close together would otherwise both enter the tile loop and
 * interleave at `await session.run()` — interleaved writes into the shared
 * accumulator and scratch buffers corrupt the output. The main thread
 * pipelines by keeping several frames in flight, so the queue, not the
 * worker, absorbs the concurrency.
 */
let jobQueue: Promise<void> = Promise.resolve();

function enqueue(job: () => Promise<void>): void {
	jobQueue = jobQueue.then(job, job);
}

self.onmessage = (event: MessageEvent<UpscaleInboundMessage>) => {
	const message = event.data;
	switch (message.type) {
		case "init":
			enqueue(() => handleInit(message.model));
			break;
		case "upscale-image":
			// Snapshot the generation at enqueue time: if a cancel lands while
			// this frame sits in the queue, the job must abort instead of
			// starting fresh.
			enqueue(() =>
				handleUpscaleImage({
					id: message.id,
					width: message.width,
					height: message.height,
					imageBitmap: message.imageBitmap,
					tileSize: message.tileSize,
					generation: cancelGeneration,
				}),
			);
			break;
		case "cancel":
			// Bump the generation so every in-flight and queued frame aborts.
			// The main thread has already rejected the promises, so there is
			// nobody left to notify.
			cancelGeneration++;
			break;
	}
};

async function handleInit(model: ArrayBuffer): Promise<void> {
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
		// CPU WASM would take minutes PER FRAME (hours for a short clip), and
		// an FP32 64MB graph is what blew the wasm heap before. Refuse it —
		// the caller degrades to the Lanczos shader, which is instant.
		// the caller degrades to the Lanczos shader, which is instant.
		console.warn("Upscale WebGPU unavailable, refusing WASM CPU fallback:", webgpuErr);
		post({
			type: "error",
			message:
				"AI upscale needs WebGPU in this browser. " +
				"Export with the Fast (Lanczos) method instead.",
		});
	}
}

async function handleUpscaleImage({
	id,
	width,
	height,
	imageBitmap,
	tileSize,
	generation,
}: {
	id: number;
	width: number;
	height: number;
	imageBitmap: ImageBitmap;
	tileSize: number;
	generation: number;
}): Promise<void> {
	try {
		if (cancelGeneration !== generation) {
			imageBitmap.close();
			return;
		}
		if (!session) throw new Error("Upscale session is not initialized");

		const tile = Math.max(
			MIN_TILE_SIZE,
			Math.min(1024, Math.floor(tileSize) || DEFAULT_TILE_SIZE),
		);

		const outW = width * UPSCALE_FACTOR;
		const outH = height * UPSCALE_FACTOR;
		if (outW * outH > MAX_OUTPUT_PIXELS) {
			throw new Error(
				`Upscale target ${outW}x${outH} is too large for the AI path. ` +
					"Pick a smaller resolution, or export without AI enhance.",
			);
		}

		if (!readCanvas || readCanvas.width !== width || readCanvas.height !== height) {
			readCanvas = new OffscreenCanvas(width, height);
			readCtx = readCanvas.getContext("2d", { willReadFrequently: true });
		}
		if (!readCtx) throw new Error("Failed to create read canvas");
		readCtx.drawImage(imageBitmap, 0, 0);
		const img = readCtx.getImageData(0, 0, width, height);
		imageBitmap.close();

		// Reused across frames: a fresh 4K float frame is 33MB, and one
		// allocation per frame is what drives the tab into OOM.
		if (!frameData || frameData.length < width * height * 3) {
			frameData = new Float32Array(width * height * 3);
		}
		const data = frameData;
		const px = img.data;
		for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
			data[j] = px[i]! / 255;
			data[j + 1] = px[i + 1]! / 255;
			data[j + 2] = px[i + 2]! / 255;
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

		// Any output pixel with no weight came from a tile region that was
		// discarded by the margin crop. That is a bug (gaps in the frame),
		// so report the coordinate instead of encoding a hole.
		let uncovered = 0;
		let firstUncovered = -1;

		let done = 0;
		let inferMsTotal = 0;

		// Per-tile feather ramps. tileWeight is separable, so build the two
		// 1D tables once per tile instead of calling it per output pixel.
		// MUST be rebuilt per tile: the ramps depend on the shared edges.
		for (const t of tiles) {
			if (cancelGeneration !== generation) {
				post({ type: "cancelled", id });
				return;
			}

			const tw = t.w;
			const th = t.h;
			// The graph's unshuffle factor forces even tile dimensions. Edge
			// tiles are clamped to the frame, so a frame with an odd side can
			// hand us an odd tile; pad by at most one row/column.
			const tw2 = tw + (tw % SHUFFLE);
			const th2 = th + (th % SHUFFLE);
			const needed = tw2 * th2 * 3;
			if (!scratch || scratch.size < needed) {
				scratch = {
					cropped: new Float32Array(needed),
					padded: new Float32Array(needed),
					nchw: new Float32Array(needed),
					wxRamp: new Float32Array(tw * UPSCALE_FACTOR),
					wyRamp: new Float32Array(th * UPSCALE_FACTOR),
					size: needed,
				};
			}
			const { cropped, padded, nchw } = scratch;

			// Row-wise crop of the HWC float frame into the tile buffer.
			for (let y = 0; y < th; y++) {
				const srcStart = ((t.y + y) * width + t.x) * 3;
				cropped.set(data.subarray(srcStart, srcStart + tw * 3), y * tw * 3);
			}
			// Distinct buffers: padding in place would overwrite rows this
			// pass has not read yet.
			padHwcReflectInto({
				src: cropped,
				width: tw,
				height: th,
				dst: padded,
				outWidth: tw2,
				outHeight: th2,
			});
			const packed = packHwcToPixelUnshuffleInto({
				src: padded,
				width: tw2,
				height: th2,
				dst: nchw,
				shuffle: SHUFFLE,
			});

			const feeds: Record<string, ort.Tensor> = {};
			feeds[inputName] = new ort.Tensor(
				"float32",
				nchw.subarray(0, packed.channels * packed.width * packed.height),
				[1, packed.channels, packed.height, packed.width],
			);
			const inferStart = performance.now();
			const results = await session!.run(feeds);
			inferMsTotal += performance.now() - inferStart;
			const outputTensor = results[outputName];
			const out = outputTensor?.data as ArrayLike<number> | undefined;
			if (!out) throw new Error("Upscale model returned no output");
			// The net upscales 2^SHUFFLE, but it consumes a tile that is already
			// 1/SHUFFLE the size, so the net spatial factor is
			// 2^SHUFFLE / SHUFFLE (= 2). Derive the expected size from the
			// packed dims rather than multiplying by SHUFFLE: the padded tile
			// is wider than the tile we keep, so output width and the width we
			// read are different numbers.
			const fullH = packed.height * 2 ** SHUFFLE;
			const fullW = packed.width * 2 ** SHUFFLE;
			// spandrel's wrapper crops back to 2x of the ORIGINAL (pre-pad)
			// tile, which is what drops the padding we just added.
			const oh = th * UPSCALE_FACTOR;
			const ow = tw * UPSCALE_FACTOR;
			if (fullH < oh || fullW < ow) {
				throw new Error(
					`Upscale model returned ${fullW}x${fullH}, too small for the ` +
						`${ow}x${oh} window expected from a ${tw}x${th} tile.`,
				);
			}
			const dims = outputTensor?.dims as readonly number[] | undefined;
			if (!dims) throw new Error("Upscale model returned output without dims");
			assertNchwDims(dims, fullW, fullH, "upscale output");
			// Row stride is the FULL output width. When the tile needed padding
			// this differs from `ow`, and using `ow` here would skew every row
			// by a growing offset.
			const plane = fullW * fullH;

			// Discard the padding-corrupted border before feathering. On a
			// shared edge that means skipping TILE_MARGIN source pixels on
			// each side; on a frame edge the border is real image data and
			// must be kept, otherwise the outer frame loses 64px.
			const m = TILE_MARGIN;
			const xSkipL = t.sharedLeft ? m : 0;
			const xSkipR = t.sharedRight ? m : 0;
			const ySkipT = t.sharedTop ? m : 0;
			const ySkipB = t.sharedBottom ? m : 0;

			for (let x = 0; x < ow; x++) {
				scratch.wxRamp[x] = tileWeightX({ tile: t, lx: Math.min(tw - 1, x >> 1), overlap: TILE_OVERLAP });
			}
			for (let y = 0; y < oh; y++) {
				scratch.wyRamp[y] = tileWeightY({ tile: t, ly: Math.min(th - 1, y >> 1), overlap: TILE_OVERLAP });
			}

			const tileOriginX = t.x * UPSCALE_FACTOR;
			const tileOriginY = t.y * UPSCALE_FACTOR;
			for (let y = 0; y < oh; y++) {
				const ly = y >> 1;
				if (ly < ySkipT || ly >= th - ySkipB) continue;
				const wy = scratch.wyRamp[y] ?? 0;
				if (wy <= 0) continue;
				const dstRow = (tileOriginY + y) * outW;
				const srcRow = y * fullW;
				for (let x = 0; x < ow; x++) {
					const lx = x >> 1;
					if (lx < xSkipL || lx >= tw - xSkipR) continue;
					const w = (scratch.wxRamp[x] ?? 0) * wy;
					if (w <= 0) continue;
					const gx = dstRow + tileOriginX + x;
					// Planar NCHW: element (c,y,x) sits at c*plane + y*W + x.
					// There is NO factor of 3 here — one channel plane holds
					// fullW*fullH values, one per pixel. Multiplying by 3 made
					// this read interleaved, walked 2*plane + o past the end of
					// the buffer for a third of all reads, and `?? 0` turned
					// those into black.
					const o = srcRow + x;
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
			} else if (uncovered === 0) {
				firstUncovered = i;
				uncovered = 1;
			}
		}
		if (uncovered) {
			const gx = firstUncovered % outW;
			const gy = Math.floor(firstUncovered / outW);
			throw new Error(
				`Tile margin left output pixel (${gx}, ${gy}) with no weight — ` +
					"tiling and margin are inconsistent.",
			);
		}

		if (!resultCanvas || resultCanvas.width !== outW || resultCanvas.height !== outH) {
			resultCanvas = new OffscreenCanvas(outW, outH);
			resultCtx = resultCanvas.getContext("2d", { willReadFrequently: false });
		}
		if (!resultCtx) throw new Error("Failed to create result canvas");
		const resultImg = resultCtx.createImageData(outW, outH);
		const resultPx = resultImg.data;
		for (let i = 0, j = 0; i < resultPx.length; i += 4, j += 3) {
			resultPx[i] = Math.round(Math.min(1, Math.max(0, acc[j] ?? 0)) * 255);
			resultPx[i + 1] = Math.round(Math.min(1, Math.max(0, acc[j + 1] ?? 0)) * 255);
			resultPx[i + 2] = Math.round(Math.min(1, Math.max(0, acc[j + 2] ?? 0)) * 255);
			resultPx[i + 3] = 255;
		}
		resultCtx.putImageData(resultImg, 0, 0);
		const resultBitmap = await createImageBitmap(resultCanvas);

		post(
			{
				type: "image_complete",
				id,
				width: outW,
				height: outH,
				imageBitmap: resultBitmap,
				avgTileMs: tiles.length > 0 ? inferMsTotal / tiles.length : 0,
			},
			[resultBitmap as Transferable],
		);
	} catch (error) {
		post({
			type: "error",
			id,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}