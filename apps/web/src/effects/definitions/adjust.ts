import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const COLOR_GRADE_SHADER = "color-grade";

/** Order must match color_grade.wgsl data[] layout. */
const GRADE_KEYS = [
	"exposure",
	"brightness",
	"contrast",
	"saturation",
	"vibrance",
	"temperature",
	"tint",
	"highlights",
	"shadows",
	"whites",
	"blacks",
	"hue",
	"fade",
	"sharpness",
] as const;

type GradeKey = (typeof GRADE_KEYS)[number];

function num(params: ParamValues, key: string, fallback = 0): number {
	const v = params[key];
	return typeof v === "number" ? v : Number.parseFloat(String(v ?? fallback)) || 0;
}

function clamp01(v: number): number {
	return Math.min(1, Math.max(-1, v));
}

/** Map UI ranges to shader ranges. */
export function gradeParamsToData(effectParams: ParamValues): number[] {
	const exposure = num(effectParams, "exposure");
	const brightness = num(effectParams, "brightness") / 100;
	const contrast = num(effectParams, "contrast") / 100;
	const saturation = num(effectParams, "saturation") / 100;
	const vibrance = num(effectParams, "vibrance") / 100;
	const temperature = num(effectParams, "temperature") / 100;
	const tint = num(effectParams, "tint") / 100;
	const highlights = num(effectParams, "highlights") / 100;
	const shadows = num(effectParams, "shadows") / 100;
	const whites = num(effectParams, "whites") / 100;
	const blacks = num(effectParams, "blacks") / 100;
	const hue = num(effectParams, "hue");
	const fade = num(effectParams, "fade") / 100;
	const sharpness = num(effectParams, "sharpness") / 100;
	return [
		exposure,
		clamp01(brightness),
		clamp01(contrast),
		clamp01(saturation),
		clamp01(vibrance),
		clamp01(temperature),
		clamp01(tint),
		clamp01(highlights),
		clamp01(shadows),
		clamp01(whites),
		clamp01(blacks),
		Math.max(-180, Math.min(180, hue)),
		Math.min(1, Math.max(0, fade)),
		Math.min(1, Math.max(0, sharpness)),
	];
}

export function buildColorGradePasses(effectParams: ParamValues): EffectPass[] {
	const data = gradeParamsToData(effectParams);
	const isIdentity = data.every((v, i) => (i === 0 ? v === 0 : v === 0));
	if (isIdentity) return [];
	return [{ shader: COLOR_GRADE_SHADER, uniforms: { u_data: data } }];
}

const hundred = (label: string, def = 0) => ({
	key: label,
	label: label.charAt(0).toUpperCase() + label.slice(1),
	type: "number" as const,
	default: def,
	min: -100,
	max: 100,
	step: 1,
});

export const adjustEffectDefinition: EffectDefinition = {
	type: "adjust",
	name: "Adjust",
	keywords: ["adjust", "color", "exposure", "contrast", "saturation", "temperature", "tint", "grade", "brightness"],
	params: [
		{ key: "exposure", label: "Exposure", type: "number", default: 0, min: -3, max: 3, step: 0.1 },
		hundred("brightness"),
		hundred("contrast"),
		hundred("saturation"),
		hundred("vibrance"),
		hundred("temperature"),
		hundred("tint"),
		hundred("highlights"),
		hundred("shadows"),
		hundred("whites"),
		hundred("blacks"),
		{ key: "hue", label: "Hue", type: "number", default: 0, min: -180, max: 180, step: 1 },
		{ key: "fade", label: "Fade", type: "number", default: 0, min: 0, max: 100, step: 1 },
		{ key: "sharpness", label: "Sharpness", type: "number", default: 0, min: 0, max: 100, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: COLOR_GRADE_SHADER,
				uniforms: ({ effectParams }) => ({ u_data: gradeParamsToData(effectParams) }),
			},
		],
		buildPasses: ({ effectParams }) => buildColorGradePasses(effectParams),
	},
};

export const GRADE_PARAM_KEYS: readonly GradeKey[] = GRADE_KEYS;
