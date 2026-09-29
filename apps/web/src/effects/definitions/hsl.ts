import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const HSL_SHIFT_SHADER = "hsl-shift";

export const HSL_BANDS = [
	"red",
	"orange",
	"yellow",
	"green",
	"cyan",
	"blue",
	"purple",
	"magenta",
] as const;

export type HslBand = (typeof HSL_BANDS)[number];

function num(params: ParamValues, key: string): number {
	const v = params[key];
	const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? 0));
	return Number.isFinite(n) ? Math.max(-100, Math.min(100, n)) / 100 : 0;
}

export function hslParamsToData(effectParams: ParamValues): number[] {
	const data: number[] = [];
	for (const band of HSL_BANDS) {
		data.push(
			num(effectParams, `hsl.${band}.hue`),
			num(effectParams, `hsl.${band}.sat`),
			num(effectParams, `hsl.${band}.lum`),
		);
	}
	return data;
}

export function buildHslPasses(effectParams: ParamValues): EffectPass[] {
	const data = hslParamsToData(effectParams);
	if (data.every((v) => v === 0)) return [];
	return [{ shader: HSL_SHIFT_SHADER, uniforms: { u_data: data } }];
}

function bandParams(band: HslBand) {
	const label = band.charAt(0).toUpperCase() + band.slice(1);
	return [
		{ key: `hsl.${band}.hue`, label: `${label} hue`, type: "number" as const, default: 0, min: -100, max: 100, step: 1 },
		{ key: `hsl.${band}.sat`, label: `${label} sat`, type: "number" as const, default: 0, min: -100, max: 100, step: 1 },
		{ key: `hsl.${band}.lum`, label: `${label} lum`, type: "number" as const, default: 0, min: -100, max: 100, step: 1 },
	];
}

export const hslEffectDefinition: EffectDefinition = {
	type: "hsl",
	name: "HSL",
	keywords: ["hsl", "hue", "saturation", "color", "selective", "skin"],
	params: HSL_BANDS.flatMap(bandParams),
	renderer: {
		passes: [
			{
				shader: HSL_SHIFT_SHADER,
				uniforms: ({ effectParams }) => ({ u_data: hslParamsToData(effectParams) }),
			},
		],
		buildPasses: ({ effectParams }) => buildHslPasses(effectParams),
	},
};
