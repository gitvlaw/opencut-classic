import { describe, expect, it } from "bun:test";
import { resampleControls } from "../curve-editor";

describe("resampleControls", () => {
	it("reproduces identity through diagonal controls", () => {
		const controls = [0, 0.25, 0.5, 0.75, 1].map((x) => ({ x, y: x }));
		const pts = resampleControls(controls);
		expect(pts.length).toBe(16);
		pts.forEach((y, i) => expect(y).toBeCloseTo(i / 15, 2));
	});

	it("outputs 16 clamped values for an S-curve", () => {
		const controls = [
			{ x: 0, y: 0 },
			{ x: 0.25, y: 0.2 },
			{ x: 0.5, y: 0.5 },
			{ x: 0.75, y: 0.8 },
			{ x: 1, y: 1 },
		];
		const pts = resampleControls(controls);
		expect(pts.length).toBe(16);
		expect(pts[0]).toBeCloseTo(0, 3);
		expect(pts[15]).toBeCloseTo(1, 3);
		expect(pts.every((v) => v >= 0 && v <= 1)).toBe(true);
		// monotonic for a monotonic control set
		for (let i = 1; i < pts.length; i++) expect(pts[i]! >= pts[i - 1]! - 1e-6).toBe(true);
	});
});
