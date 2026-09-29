import type { EffectPass } from "@/effects/types";
import { COLOR_GRADE_SHADER } from "./definitions/adjust";
import { HSL_SHIFT_SHADER } from "./definitions/hsl";

/** Fused Adjust+HSL shader id (rust/crates/effects/src/shaders/color_grade_hsl.wgsl). */
export const FUSED_GRADE_HSL_SHADER = "color-grade-hsl";

/** Grade data occupies [0..13], HSL occupies [16..39] (see fused WGSL). */
const FUSED_DATA_LEN = 64;
const HSL_BASE = 16;

function uData(pass: EffectPass): number[] | null {
	const v = pass.uniforms.u_data;
	if (typeof v === "number") return [v];
	if (Array.isArray(v)) return v as number[];
	return null;
}

function isSinglePass(
	group: EffectPass[],
	shader: string,
): { data: number[] } | null {
	if (group.length !== 1) return null;
	const pass = group[0]!;
	if (pass.shader !== shader) return null;
	const data = uData(pass);
	return data ? { data } : null;
}

/**
 * Merge an adjacent Adjust → HSL group pair into one fused pass.
 * Call AFTER per-effect animation resolution (values are static floats
 * at this point, so fusion is always valid) and BEFORE support filtering
 * drops anything — the caller decides support via getSupportedEffectShaders.
 */
export function fuseGradeHslGroups(groups: EffectPass[][]): EffectPass[][] {
	const out: EffectPass[][] = [];
	let i = 0;
	while (i < groups.length) {
		const grade = isSinglePass(groups[i]!, COLOR_GRADE_SHADER);
		const hsl = i + 1 < groups.length ? isSinglePass(groups[i + 1]!, HSL_SHIFT_SHADER) : null;
		if (grade && hsl) {
			const data = new Array(FUSED_DATA_LEN).fill(0);
			for (let k = 0; k < Math.min(14, grade.data.length); k++) data[k] = grade.data[k];
			for (let k = 0; k < Math.min(24, hsl.data.length); k++) {
				data[HSL_BASE + k] = hsl.data[k];
			}
			out.push([{ shader: FUSED_GRADE_HSL_SHADER, uniforms: { u_data: data } }]);
			i += 2;
		} else {
			out.push(groups[i]!);
			i += 1;
		}
	}
	return out;
}
