/**
 * NCHW <-> HWC conversions for RGB float32 image tensors.
 *
 * ONNX image models (including Real-CUGAN) use NCHW planar layout:
 * [batch, channel, height, width]. Reading it as interleaved HWC
 * silently yields gray, spatially-shifted mosaics — hence this module
 * exists with strict dims validation (fail loud, never mosaic).
 */

export function packHwcToNchw(
	src: Float32Array,
	width: number,
	height: number,
): Float32Array {
	const out = new Float32Array(3 * width * height);
	packHwcToNchwInto({ src, width, height, dst: out });
	return out;
}

/** Allocation-free variant: write NCHW planes into a caller-owned buffer. */
export function packHwcToNchwInto({
	src,
	width,
	height,
	dst,
}: {
	src: Float32Array;
	width: number;
	height: number;
	dst: Float32Array;
}): void {
	const need = width * height * 3;
	if (src.length < need) {
		throw new Error(`Bad HWC buffer: ${src.length} < ${need} for ${width}x${height}x3`);
	}
	if (dst.length < need) {
		throw new Error(`Bad NCHW buffer: ${dst.length} < ${need} for ${width}x${height}x3`);
	}
	const plane = width * height;
	// Plane 0 and 1 interleave cleanly; plane 2 is the strided one.
	for (let i = 0, s = 0; i < plane; i++, s += 3) {
		dst[i] = src[s] ?? 0;
		dst[plane + i] = src[s + 1] ?? 0;
	}
	for (let i = 0, s = 2; i < plane; i++, s += 3) {
		dst[2 * plane + i] = src[s] ?? 0;
	}
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
	out: ArrayLike<number>,
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
