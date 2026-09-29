import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";
import { getLut } from "@/lut/lut-registry";

export const LUT_3D_SHADER = "lut-3d";

function num(params: ParamValues, key: string, fallback = 0): number {
	const v = params[key];
	const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? fallback));
	return Number.isFinite(n) ? n : fallback;
}

export function lutParamsToData(effectParams: ParamValues): number[] | null {
	const key = String(effectParams.lutKey ?? "none");
	const entry = getLut(key);
	if (!entry) return null;
	const intensity = Math.min(1, Math.max(0, num(effectParams, "intensity", 100) / 100));
	if (intensity <= 0.001) return null;
	return [intensity, entry.size, entry.id];
}

export function buildLutPasses(effectParams: ParamValues): EffectPass[] {
	const data = lutParamsToData(effectParams);
	if (!data) return [];
	// Pad to the shared 64-float uniform layout (Rust reads indices 0..2).
	const padded = [...data, ...new Array(64 - data.length).fill(0)];
	return [{ shader: LUT_3D_SHADER, uniforms: { u_data: padded } }];
}

export const lutEffectDefinition: EffectDefinition = {
	type: "lut",
	name: "LUT",
	keywords: ["lut", "cube", "3d", "color", "film", "import", "look"],
	params: [
		{
			key: "lutKey",
			label: "LUT file",
			type: "text",
			default: "none",
			keyframable: false,
		},
		{
			key: "lutName",
			label: "LUT name",
			type: "text",
			default: "None",
			keyframable: false,
		},
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 100,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: LUT_3D_SHADER,
				uniforms: ({ effectParams }) => ({
					u_data: lutParamsToData(effectParams) ?? [0, 0, 0],
				}),
			},
		],
		buildPasses: ({ effectParams }) => buildLutPasses(effectParams),
	},
};
