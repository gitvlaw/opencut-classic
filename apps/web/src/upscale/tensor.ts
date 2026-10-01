/**
 * NCHW <-> HWC conversions for RGB float32 image tensors.
 *
 * ONNX image models use NCHW planar layout: [batch, channel, height,
 * width]. Reading it as interleaved HWC silently yields gray,
 * spatially-shifted mosaics — hence this module exists with strict dims
 * validation (fail loud, never mosaic).
 */

/**
 * Python `reflect` padding index mapping (numpy semantics: the edge row is
 * NOT repeated). Matches the padding the exported model was validated
 * against, so an odd-sized tile lands on identical pixels.
 */
function reflectIndex(i: number, n: number): number {
	if (n <= 1) return 0;
	const period = 2 * (n - 1);
	let m = i % period;
	if (m < 0) m += period;
	return m < n ? m : period - m;
}

/**
 * Reflect-pad an HWC tile on its right/bottom edge into `dst`.
 *
 * RealESRGAN's exported graph consumes pixel-unshuffled input, whose group
 * size forces even tile dimensions. Rather than export spandrel's padding
 * wrapper (torch constant-folds its `if pad_h or pad_w` branch, producing a
 * graph that only accepts the exact size traced — verified: a 255px input
 * fails with a Reshape error), the padding lives here where it is explicit.
 */
export function padHwcReflectInto({
	src,
	width,
	height,
	dst,
	outWidth,
	outHeight,
}: {
	src: Float32Array;
	width: number;
	height: number;
	dst: Float32Array;
	outWidth: number;
	outHeight: number;
}): void {
	if (outWidth < width || outHeight < height) {
		throw new Error(
			`padHwcReflectInto: target ${outWidth}x${outHeight} smaller than source ${width}x${height}`,
		);
	}
	if (src.length < width * height * 3) {
		throw new Error(`Bad HWC buffer: ${src.length} < ${width * height * 3}`);
	}
	if (dst.length < outWidth * outHeight * 3) {
		throw new Error(`Bad padded buffer: ${dst.length} < ${outWidth * outHeight * 3}`);
	}
	// Fast path: nothing to pad, so the tile is already the target size.
	if (outWidth === width && outHeight === height) {
		dst.set(src.subarray(0, width * height * 3));
		return;
	}
	for (let y = 0; y < outHeight; y++) {
		const sy = reflectIndex(y, height);
		const srcRow = sy * width * 3;
		const dstRow = y * outWidth * 3;
		for (let x = 0; x < outWidth; x++) {
			const s = srcRow + reflectIndex(x, width) * 3;
			const d = dstRow + x * 3;
			dst[d] = src[s] ?? 0;
			dst[d + 1] = src[s + 1] ?? 0;
			dst[d + 2] = src[s + 2] ?? 0;
		}
	}
}

/**
 * Pack an HWC RGB tile into the 12-channel NCHW layout RealESRGAN expects:
 * `3 * shuffle^2` planes at `height/shuffle` x `width/shuffle`, with the
 * sub-pixel offset folded into the channel index as `c*s^2 + dy*s + dx`
 * (torch's pixel_unshuffle ordering).
 *
 * `width` and `height` must already be multiples of `shuffle`; the caller
 * pads first. Returns the resulting tensor dims so the caller does not have
 * to recompute them.
 */
export function packHwcToPixelUnshuffleInto({
	src,
	width,
	height,
	dst,
	shuffle = 2,
}: {
	src: Float32Array;
	width: number;
	height: number;
	dst: Float32Array;
	shuffle?: number;
}): { channels: number; width: number; height: number } {
	if (width % shuffle !== 0 || height % shuffle !== 0) {
		throw new Error(
			`packHwcToPixelUnshuffleInto: ${width}x${height} is not a multiple of ${shuffle}. ` +
				"Pad the tile first.",
		);
	}
	const channels = 3 * shuffle * shuffle;
	const ow = width / shuffle;
	const oh = height / shuffle;
	if (src.length < width * height * 3) {
		throw new Error(`Bad HWC buffer: ${src.length} < ${width * height * 3}`);
	}
	if (dst.length < channels * ow * oh) {
		throw new Error(`Bad NCHW buffer: ${dst.length} < ${channels * ow * oh}`);
	}
	for (let c = 0; c < 3; c++) {
		for (let dy = 0; dy < shuffle; dy++) {
			for (let dx = 0; dx < shuffle; dx++) {
				const plane = (c * shuffle + dy) * shuffle + dx;
				const base = plane * oh * ow;
				for (let oy = 0; oy < oh; oy++) {
					let s = ((oy * shuffle + dy) * width + dx) * 3 + c;
					let d = base + oy * ow;
					for (let ox = 0; ox < ow; ox++) {
						dst[d++] = src[s] ?? 0;
						s += shuffle * 3;
					}
				}
			}
		}
	}
	return { channels, width: ow, height: oh };
}

export function assertNchwDims(
	dims: readonly number[],
	width: number,
	height: number,
	what: string,
	channels = 3,
): void {
	if (
		dims.length !== 4 ||
		dims[0] !== 1 ||
		dims[1] !== channels ||
		dims[2] !== height ||
		dims[3] !== width
	) {
		throw new Error(
			`${what}: expected NCHW [1,${channels},${height},${width}], got [${dims.join(",")}]. ` +
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
