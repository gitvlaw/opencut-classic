import { describe, expect, it } from "bun:test";
import { assertNchwDims, packHwcToNchw, unpackNchwToHwc } from "../tensor";

describe("packHwcToNchw", () => {
	it("round-trips through unpack", () => {
		const hwc = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 0, 0.5]);
		const nchw = packHwcToNchw(hwc, 2, 2);
		const r5 = (a: ArrayLike<number>) => Array.from(a, (v) => +v.toFixed(5));
		expect(r5(nchw)).toEqual(r5([0.1, 0.4, 0.7, 1, 0.2, 0.5, 0.8, 0, 0.3, 0.6, 0.9, 0.5]));
		const back = unpackNchwToHwc(nchw, 2, 2, [1, 3, 2, 2]);
		expect(r5(back)).toEqual(r5(hwc));
	});

	it("rejects bad buffer sizes", () => {
		expect(() => packHwcToNchw(new Float32Array(5), 2, 2)).toThrow();
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

	it("rejects wrong rank, batch, channels and spatial size", () => {
		expect(() => assertNchwDims([1, 3, 4], 4, 4, "test")).toThrow();
		expect(() => assertNchwDims([2, 3, 4, 4], 4, 4, "test")).toThrow();
		expect(() => assertNchwDims([1, 1, 4, 4], 4, 4, "test")).toThrow();
		expect(() => assertNchwDims([1, 3, 8, 8], 4, 4, "test")).toThrow();
	});
});
