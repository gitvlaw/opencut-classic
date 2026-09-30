import { describe, expect, it } from "bun:test";
import { buildWheelsPasses, wheelsParamsToData } from "../definitions/wheels";

const identity = {
	"wheels.shadow.hue": 0,
	"wheels.shadow.sat": 0,
	"wheels.shadow.lum": 0,
	"wheels.mid.hue": 0,
	"wheels.mid.sat": 0,
	"wheels.mid.lum": 0,
	"wheels.high.hue": 0,
	"wheels.high.sat": 0,
	"wheels.high.lum": 0,
};

describe("wheelsParamsToData", () => {
	it("maps UI ranges to shader ranges", () => {
		const data = wheelsParamsToData({
			...identity,
			"wheels.shadow.hue": 90,
			"wheels.shadow.sat": 50,
			"wheels.shadow.lum": -40,
		});
		expect(data.length).toBe(9);
		expect(data[0]).toBe(90);
		expect(data[1]).toBeCloseTo(0.5, 5);
		expect(data[2]).toBeCloseTo(-0.4, 5);
		expect(data.slice(3).every((v) => v === 0)).toBe(true);
	});

	it("clamps out-of-range values", () => {
		const data = wheelsParamsToData({
			...identity,
			"wheels.high.hue": 999,
			"wheels.high.sat": 500,
			"wheels.high.lum": -500,
		});
		expect(data[6]).toBe(180);
		expect(data[7]).toBe(1);
		expect(data[8]).toBe(-1);
	});
});

describe("buildWheelsPasses", () => {
	it("returns no passes for identity", () => {
		expect(buildWheelsPasses(identity)).toEqual([]);
		expect(buildWheelsPasses({})).toEqual([]);
	});

	it("emits one color-wheels pass otherwise", () => {
		const passes = buildWheelsPasses({ ...identity, "wheels.mid.lum": 20 });
		expect(passes.length).toBe(1);
		expect(passes[0]!.shader).toBe("color-wheels");
	});
});
