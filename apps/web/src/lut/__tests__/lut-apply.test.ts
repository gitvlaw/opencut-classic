import { describe, expect, it } from "bun:test";
import { applyLutToImageData, sampleLutTrilinear } from "../lut-apply";

function identityTable(size: number): Float32Array {
	const table = new Float32Array(size ** 3 * 3);
	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				const o = ((b * size + g) * size + r) * 3;
				table[o] = r / (size - 1);
				table[o + 1] = g / (size - 1);
				table[o + 2] = b / (size - 1);
			}
		}
	}
	return table;
}

describe("sampleLutTrilinear", () => {
	it("is identity on an identity table", () => {
		const table = identityTable(4);
		const [r, g, b] = sampleLutTrilinear({ table, size: 4, r: 0.3, g: 0.7, b: 0.5 });
		expect(r).toBeCloseTo(0.3, 5);
		expect(g).toBeCloseTo(0.7, 5);
		expect(b).toBeCloseTo(0.5, 5);
	});

	it("clamps out-of-range inputs", () => {
		const table = identityTable(2);
		const [r, g, b] = sampleLutTrilinear({ table, size: 2, r: -1, g: 2, b: 0.5 });
		expect(r).toBe(0);
		expect(g).toBe(1);
		expect(b).toBeCloseTo(0.5, 5);
	});

	it("interpolates a swap LUT", () => {
		// swap red and blue: out = (b, g, r)
		const table = new Float32Array(2 ** 3 * 3);
		for (let i = 0; i < 8; i++) {
			const r = i % 2;
			const g = Math.floor(i / 2) % 2;
			const b = Math.floor(i / 4) % 2;
			table[i * 3] = b;
			table[i * 3 + 1] = g;
			table[i * 3 + 2] = r;
		}
		const [r, g, b] = sampleLutTrilinear({ table, size: 2, r: 1, g: 0, b: 0 });
		expect(r).toBeCloseTo(0, 5);
		expect(g).toBeCloseTo(0, 5);
		expect(b).toBeCloseTo(1, 5);
	});
});

describe("applyLutToImageData", () => {
	it("leaves pixels unchanged at zero intensity", () => {
		const img = {
			data: new Uint8ClampedArray([10, 20, 30, 255]),
			width: 1,
			height: 1,
		} as unknown as ImageData;
		applyLutToImageData({ img, table: identityTable(2), size: 2, intensity: 0 });
		expect([...img.data]).toEqual([10, 20, 30, 255]);
	});

	it("applies full intensity", () => {
		const img = {
			data: new Uint8ClampedArray([255, 0, 0, 255]),
			width: 1,
			height: 1,
		} as unknown as ImageData;
		// invert LUT
		const table = new Float32Array(2 ** 3 * 3);
		for (let i = 0; i < 8; i++) {
			const r = (i % 2) / 1;
			const g = (Math.floor(i / 2) % 2) / 1;
			const b = (Math.floor(i / 4) % 2) / 1;
			table[i * 3] = 1 - r;
			table[i * 3 + 1] = 1 - g;
			table[i * 3 + 2] = 1 - b;
		}
		applyLutToImageData({ img, table, size: 2, intensity: 1 });
		expect([...img.data]).toEqual([0, 255, 255, 255]);
	});
});
