import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const COLOR_WHEELS_SHADER = "color-wheels";

export const WHEEL_ZONES = ["shadow", "mid", "high"] as const;
export type WheelZone = (typeof WHEEL_ZONES)[number];

export const WHEEL_ZONE_LABELS: Record<WheelZone, string> = {
	shadow: "Shadows",
	mid: "Midtones",
	high: "Highlights",
};

function num(params: ParamValues, key: string): number {
	const v = params[key];
	const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? 0));
	return Number.isFinite(n) ? n : 0;
}

/**
 * data[] layout: per zone hueDeg [-180,180], sat [0,1], lum [-1,1].
 * Stored params use UI ranges: hue -180..180, sat 0..100, lum -100..100.
 */
export function wheelsParamsToData(effectParams: ParamValues): number[] {
	const data: number[] = [];
	for (const zone of WHEEL_ZONES) {
		const hue = Math.max(-180, Math.min(180, num(effectParams, `wheels.${zone}.hue`)));
		const sat = Math.min(1, Math.max(0, num(effectParams, `wheels.${zone}.sat`) / 100));
		const lum = Math.min(1, Math.max(-1, num(effectParams, `wheels.${zone}.lum`) / 100));
		data.push(hue, sat, lum);
	}
	return data;
}

export function buildWheelsPasses(effectParams: ParamValues): EffectPass[] {
	const data = wheelsParamsToData(effectParams);
	if (data.every((v) => v === 0)) return [];
	return [{ shader: COLOR_WHEELS_SHADER, uniforms: { u_data: data } }];
}

function zoneParams(zone: WheelZone) {
	const label = WHEEL_ZONE_LABELS[zone];
	return [
		{ key: `wheels.${zone}.hue`, label: `${label} hue`, type: "number" as const, default: 0, min: -180, max: 180, step: 1 },
		{ key: `wheels.${zone}.sat`, label: `${label} saturation`, type: "number" as const, default: 0, min: 0, max: 100, step: 1 },
		{ key: `wheels.${zone}.lum`, label: `${label} luminance`, type: "number" as const, default: 0, min: -100, max: 100, step: 1 },
	];
}

export const wheelsEffectDefinition: EffectDefinition = {
	type: "wheels",
	name: "Color Wheels",
	keywords: ["wheels", "shadows", "midtones", "highlights", "lift", "gamma", "gain", "color", "grade"],
	params: WHEEL_ZONES.flatMap(zoneParams),
	renderer: {
		passes: [
			{
				shader: COLOR_WHEELS_SHADER,
				uniforms: ({ effectParams }) => ({ u_data: wheelsParamsToData(effectParams) }),
			},
		],
		buildPasses: ({ effectParams }) => buildWheelsPasses(effectParams),
	},
};
