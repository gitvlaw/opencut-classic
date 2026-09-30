/**
 * NCHW <-> HWC conversions for RGB float32 image tensors.
 *
 * ONNX image models (including Real-CUGAN) use NCHW planar layout:
 * [batch, channel, height, width]. Reading it as interleaved HWC
 * silently yields gray, spatially-shifted mosaics — hence this module
 * exists with strict dims validation (fail loud, never mosaic).
 */

export function packHwcToNchw(src: Float32Array, width: number, height: number): Float32Array {
	if (src.length !== width * height * 3) {
		throw new Error(`Bad HWC buffer: ${src.length} for ${width}x${height}x3`);
	}
	const plane = width * height;
	const out = new Float32Array(3 * plane);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const s = (y * width + x) * 3;
			const p = y * width + x;
			out[p] = src[s] ?? 0;
			out[plane + p] = src[s + 1] ?? 0;
			out[2 * plane + p] = src[s + 2] ?? 0;
		}
	}
	return out;
}

export function assertNchwDims(
	dims: readonly number[],
	width: number,
	height: number,
	what: string,
): void {
	if (
		dims.length !== 4 ||
		dims[0] !== 1 ||
		dims[1] !== 3 ||
		dims[2] !== height ||
		dims[3] !== width
	) {
		throw new Error(
			`${what}: expected NCHW [1,3,${height},${width}], got [${dims.join(",")}]. ` +
				"This model export has an unexpected layout.",
		);
	}
}

/** Planar NCHW [1,3,h,w] -> interleaved HWC RGB, values passed through. */
export function unpackNchwToHwc(
	out: Float32Array,
	width: number,
	height: number,
	dims: readonly number[],
): Float32Array {
	assertNchwDims(dims, width, height, "upscale output");
	const plane = width * height;
	if (out.length < 3 * plane) {
		throw new Error(`Short model output: ${out.length} < ${3 * plane}`);
	}
	const hwc = new Float32Array(3 * plane);
	for (let p = 0; p < plane; p++) {
		hwc[p * 3] = out[p] ?? 0;
		hwc[p * 3 + 1] = out[plane + p] ?? 0;
		hwc[p * 3 + 2] = out[2 * plane + p] ?? 0;
	}
	return hwc;
}
