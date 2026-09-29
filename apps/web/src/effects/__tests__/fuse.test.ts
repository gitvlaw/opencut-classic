import { describe, expect, it } from "bun:test";
import { FUSED_GRADE_HSL_SHADER, fuseGradeHslGroups } from "../fuse";

const grade = (v: number) => ({ shader: "color-grade", uniforms: { u_data: new Array(14).fill(v) } });
const hsl = (v: number) => ({ shader: "hsl-shift", uniforms: { u_data: new Array(24).fill(v) } });
const blur = { shader: "gaussian-blur", uniforms: { u_sigma: 2, u_step: 1, u_direction: [1, 0] } };

describe("fuseGradeHslGroups", () => {
	it("fuses adjacent adjust→hsl into one pass", () => {
		const out = fuseGradeHslGroups([[grade(1)], [hsl(2)]]);
		expect(out.length).toBe(1);
		expect(out[0]!.length).toBe(1);
		expect(out[0]![0]!.shader).toBe(FUSED_GRADE_HSL_SHADER);
		const data = out[0]![0]!.uniforms.u_data as number[];
		expect(data.length).toBe(64);
		expect(data.slice(0, 14).every((v) => v === 1)).toBe(true);
		expect(data.slice(16, 40).every((v) => v === 2)).toBe(true);
	});

	it("does not fuse reversed or separated pairs", () => {
		expect(fuseGradeHslGroups([[hsl(1)], [grade(1)]]).length).toBe(2);
		expect(fuseGradeHslGroups([[grade(1)], [blur], [hsl(1)]]).length).toBe(3);
	});

	it("leaves multi-pass groups alone", () => {
		const two = [grade(1), grade(1)];
		expect(fuseGradeHslGroups([two, [hsl(1)]]).length).toBe(2);
	});

	it("handles empty input", () => {
		expect(fuseGradeHslGroups([])).toEqual([]);
	});
});
