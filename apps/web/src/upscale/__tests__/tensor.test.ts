import { describe, expect, it } from "bun:test";
import {
	assertNchwDims,
	padHwcReflectInto,
	packHwcToPixelUnshuffleInto,
	unpackNchwToHwc,
} from "../tensor";

describe("padHwcReflectInto", () => {
	/**
	 * Fixture from `np.pad(img, ((0,1),(0,1),(0,0)), mode="reflect")` on a
	 * 3x3 tile whose red plane is 0..8 row-major:
	 *   0 1 2 1
	 *   3 4 5 4
	 *   6 7 8 7
	 *   3 4 5 4
	 * numpy "reflect" mirrors WITHOUT repeating the edge, so the new row/column
	 * is the second row/column, not the last. Getting this wrong shifts every
	 * odd-sized tile by one pixel.
	 */
	it("mirrors without repeating the edge, matching numpy", () => {
		const w = 3;
		const h = 3;
		const src = new Float32Array(w * h * 3);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = (y * w + x) * 3;
				src[i] = y * w + x;
				src[i + 1] = src[i] + 0.5;
				src[i + 2] = src[i] + 0.25;
			}
		}
		const dst = new Float32Array(4 * 4 * 3);
		padHwcReflectInto({ src, width: w, height: h, dst, outWidth: 4, outHeight: 4 });
		const red: number[] = [];
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 4; x++) red.push(dst[(y * 4 + x) * 3] ?? -1);
		}
		expect(red).toEqual([0, 1, 2, 1, 3, 4, 5, 4, 6, 7, 8, 7, 3, 4, 5, 4]);
		// Green/blue ride along on the same pixels: dst[4] is the green of
		// pixel (0,1) (= 1 + 0.5), dst[37] the green of padded (3,0), which
		// mirrors source row 1 (= 3 + 0.5).
		expect(dst[4]).toBeCloseTo(1.5, 6);
		expect(dst[5]).toBeCloseTo(1.25, 6);
		expect(dst[37]).toBeCloseTo(3.5, 6);
	});

	it("copies straight through when no padding is needed", () => {
		const src = Float32Array.from({ length: 4 * 2 * 3 }, (_, i) => i / 10);
		const dst = new Float32Array(4 * 2 * 3);
		padHwcReflectInto({ src, width: 4, height: 2, dst, outWidth: 4, outHeight: 2 });
		expect(Array.from(dst)).toEqual(Array.from(src));
	});

	it("pads a single column only", () => {
		const src = Float32Array.from({ length: 3 * 2 * 3 }, (_, i) => i);
		const dst = new Float32Array(4 * 2 * 3);
		padHwcReflectInto({ src, width: 3, height: 2, dst, outWidth: 4, outHeight: 2 });
		// Row 0 red plane: 0 3 6 3 (col 3 mirrors col 1)
		expect([dst[0], dst[3], dst[6], dst[9]]).toEqual([0, 3, 6, 3]);
	});

	it("rejects a target smaller than the source", () => {
		const src = new Float32Array(12);
		expect(() =>
			padHwcReflectInto({ src, width: 4, height: 4, dst: new Float32Array(12), outWidth: 2, outHeight: 4 }),
		).toThrow();
	});

	it("rejects short buffers", () => {
		expect(() =>
			padHwcReflectInto({ src: new Float32Array(3), width: 2, height: 2, dst: new Float32Array(12), outWidth: 2, outHeight: 2 }),
		).toThrow();
		expect(() =>
			padHwcReflectInto({ src: new Float32Array(12), width: 2, height: 2, dst: new Float32Array(3), outWidth: 2, outHeight: 2 }),
		).toThrow();
	});

	/**
	 * The worker pads into a different buffer than it crops into. Padding in
	 * place would overwrite rows the same pass has not read yet once the tile
	 * is wider than its source, so guard the aliasing assumption.
	 */
	it("does not corrupt when src and dst are the same buffer", () => {
		const w = 3;
		const h = 3;
		const buf = new Float32Array(4 * 4 * 3);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) buf[(y * w + x) * 3] = y * w + x;
		}
		const expected = Float32Array.from(buf);
		// Copy the 3x3 source into the top-left of a 4x4 buffer, then pad.
		const work = new Float32Array(4 * 4 * 3);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) work[(y * w + x) * 3] = expected[(y * w + x) * 3] ?? 0;
		}
		padHwcReflectInto({ src: work, width: w, height: h, dst: buf, outWidth: 4, outHeight: 4 });
		const red: number[] = [];
		for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) red.push(buf[(y * 4 + x) * 3] ?? -1);
		expect(red).toEqual([0, 1, 2, 1, 3, 4, 5, 4, 6, 7, 8, 7, 3, 4, 5, 4]);
	});
});

describe("packHwcToPixelUnshuffleInto", () => {
	/**
	 * Expected layout generated with numpy:
	 *   hwc (2x2) -> transpose to NCHW -> pixel_unshuffle(2) -> [1,12,1,1]
	 * giving [0.1,0.4,0.7,1.0, 0.2,0.5,0.8,0.0, 0.3,0.6,0.9,0.5].
	 * The channel index is `c*s^2 + dy*s + dx`, i.e. within each colour the
	 * sub-pixel offsets run row-major. Transposing those two axes yields a
	 * plausible-looking but silently wrong tensor.
	 */
	it("matches numpy pixel_unshuffle ordering", () => {
		const hwc = new Float32Array([
			0.1, 0.2, 0.3, 0.4, 0.5, 0.6,
			0.7, 0.8, 0.9, 1.0, 0.0, 0.5,
		]);
		const dst = new Float32Array(12);
		const packed = packHwcToPixelUnshuffleInto({
			src: hwc,
			width: 2,
			height: 2,
			dst,
			shuffle: 2,
		});
		expect(packed).toEqual({ channels: 12, width: 1, height: 1 });
		const r5 = (a: ArrayLike<number>) => Array.from(a, (v) => +v.toFixed(5));
		expect(r5(dst)).toEqual(r5([0.1, 0.4, 0.7, 1.0, 0.2, 0.5, 0.8, 0.0, 0.3, 0.6, 0.9, 0.5]));
	});

	it("halves each spatial axis and interleaves the offset into channels", () => {
		// 4x4 unique values, so any plane/index mix-up is visible.
		const w = 4;
		const h = 4;
		const hwc = new Float32Array(w * h * 3);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = (y * w + x) * 3;
				hwc[i] = y * w + x;
				hwc[i + 1] = hwc[i] + 100;
				hwc[i + 2] = hwc[i] + 200;
			}
		}
		const dst = new Float32Array(12 * 4);
		const packed = packHwcToPixelUnshuffleInto({ src: hwc, width: w, height: h, dst });
		expect(packed).toEqual({ channels: 12, width: 2, height: 2 });

		const at = (plane: number, oy: number, ox: number) => dst[plane * 4 + oy * 2 + ox] ?? -1;
		// Expected planes from numpy pixel_unshuffle(2): within a colour, the
		// four sub-pixel planes hold the even/odd row x even/odd column
		// samples, and the spatial axis keeps the 2x2 grid order.
		expect([at(0, 0, 0), at(0, 0, 1), at(0, 1, 0), at(0, 1, 1)]).toEqual([0, 2, 8, 10]);
		expect([at(1, 0, 0), at(1, 0, 1), at(1, 1, 0), at(1, 1, 1)]).toEqual([1, 3, 9, 11]);
		expect([at(2, 0, 0), at(2, 0, 1), at(2, 1, 0), at(2, 1, 1)]).toEqual([4, 6, 12, 14]);
		expect([at(3, 0, 0), at(3, 0, 1), at(3, 1, 0), at(3, 1, 1)]).toEqual([5, 7, 13, 15]);
		// Green occupies planes 4..7, blue 8..11.
		expect([at(4, 0, 0), at(4, 1, 1)]).toEqual([100, 110]);
		expect([at(8, 0, 0), at(8, 1, 1)]).toEqual([200, 210]);
		expect([at(11, 0, 0), at(11, 1, 1)]).toEqual([205, 215]);
	});

	it("rejects dimensions that are not a multiple of the shuffle factor", () => {
		expect(() =>
			packHwcToPixelUnshuffleInto({ src: new Float32Array(3 * 3 * 3), width: 3, height: 3, dst: new Float32Array(36) }),
		).toThrow();
	});

	it("rejects short buffers", () => {
		expect(() =>
			packHwcToPixelUnshuffleInto({ src: new Float32Array(3), width: 2, height: 2, dst: new Float32Array(12) }),
		).toThrow();
		expect(() =>
			packHwcToPixelUnshuffleInto({ src: new Float32Array(12), width: 2, height: 2, dst: new Float32Array(3) }),
		).toThrow();
	});
});

/**
 * Reproduces the worker's accumulation read against a real model output.
 *
 * The loop used to compute `o = (y * W + x) * 3`, i.e. it read a planar
 * NCHW tensor as if it were interleaved. Verified against the shipped
 * CUGAN graph: 33.3% of all channel reads fell off the end of the buffer,
 * `?? 0` silently turned those black, and the frame came out banded with a
 * black bottom third (mean RGB [0.53, 0.21, 0.14] instead of
 * [0.95, 0.21, 0.42]).
 */
describe("planar accumulation read", () => {
	const fullW = 64;
	const fullH = 64;
	const plane = fullW * fullH;

	/** Fill a [1,3,fullH,fullW] buffer with values that identify their origin. */
	function makeOutput() {
		const out = new Float32Array(3 * plane);
		for (let c = 0; c < 3; c++) {
			for (let y = 0; y < fullH; y++) {
				for (let x = 0; x < fullW; x++) {
					out[c * plane + y * fullW + x] = c * 100 + y;
				}
			}
		}
		return out;
	}

	function readAll(out: Float32Array, stride: number, width: number, height: number) {
		const px: number[][] = [];
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const o = y * stride + x;
				px.push([out[o] ?? NaN, out[plane + o] ?? NaN, out[2 * plane + o] ?? NaN]);
			}
		}
		return px;
	}

	it("reads each pixel's own channels with no factor of 3", () => {
		const out = makeOutput();
		const got = readAll(out, fullW, fullW, fullH);
		for (let y = 0; y < fullH; y++) {
			for (let x = 0; x < fullW; x++) {
				expect(got[y * fullW + x]).toEqual([0 * 100 + y, 1 * 100 + y, 2 * 100 + y]);
			}
		}
	});

	it("the old interleaved formula both misreads and runs off the buffer", () => {
		const out = makeOutput();
		const buggy: number[][] = [];
		let pastEnd = 0;
		for (let y = 0; y < fullH; y++) {
			for (let x = 0; x < fullW; x++) {
				const o = (y * fullW + x) * 3;
				for (let k = 0; k < 3; k++) {
					if (k * plane + o >= out.length) pastEnd++;
				}
				buggy.push([
					out[o] ?? 0,
					out[plane + o] ?? 0,
					out[2 * plane + o] ?? 0,
				]);
			}
		}
		// A third of every channel read is out of bounds: the red plane never
		// overruns, green overruns for 1365 pixels and blue for 2730.
		expect(pastEnd).toBe(1365 + 2730);
		// Pixel (0,0) happened to be right; a mid pixel is not.
		expect(buggy[0]).toEqual([0, 100, 200]);
		expect(buggy[16 * fullW + 16]).not.toEqual([16, 116, 216]);
	});

	it("uses the full row stride, not the cropped window width", () => {
		// A tile needing padding produces output wider than the window the
		// worker keeps. Reading with the window width as the stride skews
		// every row past the first.
		const out = makeOutput();
		const windowW = 56; // 2x an unpadded 28px tile
		const correct = readAll(out, fullW, windowW, fullH);
		const skewed = readAll(out, windowW, windowW, fullH);
		expect(correct[0]).toEqual([0, 100, 200]);
		expect(skewed[0]).toEqual([0, 100, 200]);
		// Row 1 already diverges.
		expect(correct[fullW]).toEqual([1, 101, 201]);
		expect(skewed[windowW]).not.toEqual([1, 101, 201]);
	});
});

describe("unpackNchwToHwc", () => {
	it("reads planar channels (not interleaved)", () => {
		// R plane = 1s, G plane = 0.5s, B plane = 0s
		const out = new Float32Array([...new Array(4).fill(1), ...new Array(4).fill(0.5), ...new Array(4).fill(0)]);
		const hwc = unpackNchwToHwc(out, 2, 2, [1, 3, 2, 2]);
		for (let p = 0; p < 4; p++) {
			expect(hwc[p * 3]).toBe(1);
			expect(hwc[p * 3 + 1]).toBe(0.5);
			expect(hwc[p * 3 + 2]).toBe(0);
		}
	});

	it("an interleaved misread would NOT produce these colors (regression)", () => {
		// Pure red pixel in planar layout: R=1 at index 0 only.
		const out = new Float32Array(12);
		out[0] = 1;
		const hwc = unpackNchwToHwc(out, 2, 2, [1, 3, 2, 2]);
		expect([hwc[0], hwc[1], hwc[2]]).toEqual([1, 0, 0]);
		// The old buggy interleaved read would have shown gray-ish (1,0,0)-> pixel (0,0) reads
		// out[0..2] = (1,0,0) by accident here, but pixel (1,0) differs:
		expect([hwc[3], hwc[4], hwc[5]]).toEqual([0, 0, 0]);
	});
});

describe("assertNchwDims", () => {
	it("accepts [1,3,h,w]", () => {
		expect(() => assertNchwDims([1, 3, 4, 4], 4, 4, "test")).not.toThrow();
	});

	it("accepts a non-RGB channel count (pixel-unshuffled input)", () => {
		// The RealESRGAN graph is fed [1, 12, h/2, w/2].
		expect(() => assertNchwDims([1, 12, 8, 8], 8, 8, "test", 12)).not.toThrow();
		expect(() => assertNchwDims([1, 3, 8, 8], 8, 8, "test", 12)).toThrow();
	});

	it("rejects wrong rank, batch, channels and spatial size", () => {
		expect(() => assertNchwDims([1, 3, 4], 4, 4, "test")).toThrow();
		expect(() => assertNchwDims([2, 3, 4, 4], 4, 4, "test")).toThrow();
		expect(() => assertNchwDims([1, 1, 4, 4], 4, 4, "test")).toThrow();
		expect(() => assertNchwDims([1, 3, 8, 8], 4, 4, "test")).toThrow();
	});
});
