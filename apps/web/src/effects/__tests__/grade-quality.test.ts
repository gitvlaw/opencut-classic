import { describe, expect, it } from "bun:test";
import { buildColorGradePasses, gradeParamsToData } from "../definitions/adjust";
import { buildFilterPasses, filterParamsToData } from "../definitions/filter";

const identity = {
	exposure: 0,
	brightness: 0,
	contrast: 0,
	saturation: 0,
	vibrance: 0,
	temperature: 0,
	tint: 0,
	highlights: 0,
	shadows: 0,
	whites: 0,
	blacks: 0,
	hue: 0,
	fade: 0,
	sharpness: 0,
};

describe("buildColorGradePasses", () => {
	it("returns no passes for full identity", () => {
		expect(buildColorGradePasses(identity)).toEqual([]);
		expect(buildColorGradePasses({})).toEqual([]);
	});

	it("appends a sharpen pass after grade", () => {
		const passes = buildColorGradePasses({ ...identity, contrast: 20, sharpness: 50 });
		expect(passes.length).toBe(2);
		expect(passes[0]!.shader).toBe("color-grade");
		expect(passes[1]!.shader).toBe("sharpen");
		expect((passes[1]!.uniforms.u_data as number[])[0]).toBeCloseTo(0.5, 5);
	});

	it("emits sharpen alone when grade is identity", () => {
		const passes = buildColorGradePasses({ ...identity, sharpness: 30 });
		expect(passes.length).toBe(1);
		expect(passes[0]!.shader).toBe("sharpen");
	});

	it("keeps 14 grade floats with sharpness at index 13", () => {
		const data = gradeParamsToData({ ...identity, sharpness: 80 });
		expect(data.length).toBe(14);
		expect(data[13]).toBeCloseTo(0.8, 5);
	});
});

describe("filter grain time seed", () => {
	it("writes timeSeconds to data[23]", () => {
		const a = filterParamsToData({ preset: "memory", intensity: 100 }, 1.5);
		const b = filterParamsToData({ preset: "memory", intensity: 100 }, 2.5);
		expect(a[23]).toBeCloseTo(1.5, 5);
		expect(b[23]).toBeCloseTo(2.5, 5);
		expect(a.slice(0, 23)).toEqual(b.slice(0, 23));
	});

	it("buildFilterPasses forwards time", () => {
		const passes = buildFilterPasses({ preset: "memory", intensity: 100 }, 7.25);
		expect(passes.length).toBe(1);
		expect((passes[0]!.uniforms.u_data as number[])[23]).toBeCloseTo(7.25, 5);
	});
});
