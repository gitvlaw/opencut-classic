import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const CURVES_SHADER = "curves";
export const CURVE_POINTS = 16;

export const CURVE_CHANNELS = ["master", "red", "green", "blue"] as const;
export type CurveChannel = (typeof CURVE_CHANNELS)[number];

/** Identity curve: y[i] = i/15. */
export function identityCurve(): number[] {
	return Array.from({ length: CURVE_POINTS }, (_, i) => i / (CURVE_POINTS - 1));
}

/**
 * Curves are stored as JSON text params (ParamValues only allows
 * number|string|boolean). The dedicated curve editor tab reads/writes
 * these keys; keyframing is discrete (hold) per channel.
 */
/**
 * Read one channel's 16 control values from effect params (JSON text).
 * Exported for the curve editor UI.
 */
export function parseCurvePoints(params: ParamValues, channel: CurveChannel): number[] {
	return parseCurve(params, channel);
}

function parseCurve(params: ParamValues, channel: CurveChannel): number[] {	const raw = params[`curves.${channel}`];
	if (typeof raw === "string") {
		try {
			const arr = JSON.parse(raw) as unknown;
			if (Array.isArray(arr) && arr.length === CURVE_POINTS) {
				const nums = arr.map((n) => {
					const f = typeof n === "number" ? n : Number.parseFloat(String(n));
					return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
				});
				if (nums.every((n) => Number.isFinite(n))) return nums;
			}
		} catch {
			// fall through to identity
		}
	}
	return identityCurve();
}

export function encodeCurve(points: number[]): string {
	return JSON.stringify(
		points.map((n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0))),
	);
}

function isIdentity(values: number[]): boolean {
	return values.every((y, i) => Math.abs(y - i / (CURVE_POINTS - 1)) < 1e-4);
}

export function curvesParamsToData(effectParams: ParamValues): number[] {
	const preset = String(effectParams.preset ?? "custom");
	const channels = CURVE_CHANNELS.map((c) => parseCurve(effectParams, c));
	if (channels.every(isIdentity) && preset !== "custom") {
		const p = curvePreset(preset);
		return [...p.master, ...p.red, ...p.green, ...p.blue];
	}
	return channels.flat();
}

export function buildCurvesPasses(effectParams: ParamValues): EffectPass[] {
	const preset = String(effectParams.preset ?? "custom");
	let channels = CURVE_CHANNELS.map((c) => parseCurve(effectParams, c));
	if (channels.every(isIdentity) && preset !== "custom") {
		const p = curvePreset(preset);
		channels = [p.master, p.red, p.green, p.blue];
	}
	if (channels.every(isIdentity)) return [];
	return [{ shader: CURVES_SHADER, uniforms: { u_data: channels.flat() } }];
}

const channelParam = (channel: CurveChannel, label: string) => ({
	key: `curves.${channel}`,
	label,
	type: "text" as const,
	default: encodeCurve(identityCurve()),
	keyframable: false,
});

export const curvesEffectDefinition: EffectDefinition = {
	type: "curves",
	name: "Curves",
	keywords: ["curves", "rgb", "tone", "levels", "contrast", "grade"],
	params: [
		channelParam("master", "Master curve"),
		channelParam("red", "Red curve"),
		channelParam("green", "Green curve"),
		channelParam("blue", "Blue curve"),
		{
			key: "preset",
			label: "Preset",
			type: "select",
			default: "custom",
			keyframable: false,
			options: [
				{ value: "custom", label: "Custom" },
				{ value: "s-curve", label: "S-Curve (contrast)" },
				{ value: "portrait", label: "Portrait (soft + warm)" },
				{ value: "landscape", label: "Landscape (punchy)" },
				{ value: "lift-shadows", label: "Lift shadows" },
				{ value: "fade-film", label: "Film fade" },
				{ value: "matte", label: "Matte (strong fade)" },
				{ value: "xprocess", label: "Cross process" },
			],
		},
	],
	renderer: {
		passes: [
			{
				shader: CURVES_SHADER,
				uniforms: ({ effectParams }) => ({ u_data: curvesParamsToData(effectParams) }),
			},
		],
		buildPasses: ({ effectParams }) => buildCurvesPasses(effectParams),
	},
};

/** Named 16-point presets (y values, clamped 0..1). */
export function curvePreset(name: string): Record<CurveChannel, number[]> {
	const id = identityCurve();
	const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
	const at = (i: number) => i / (CURVE_POINTS - 1);
	const sCurve = (strength: number) =>
		id.map((_, i) => clamp01(at(i) + Math.sin((at(i) - 0.5) * Math.PI) * strength));
	switch (name) {
		case "s-curve": {
			return { master: sCurve(0.08), red: id, green: id, blue: id };
		}
		case "portrait": {
			// Soft contrast + warm shadows (red lifted, blue dipped low).
			const red = id.map((_, i) => clamp01(at(i) + 0.03 * (1 - at(i)) ** 2));
			const blue = id.map((_, i) => clamp01(at(i) - 0.02 * (1 - at(i)) ** 2));
			return { master: sCurve(0.05), red, green: id, blue };
		}
		case "landscape": {
			// Punchy contrast + cool open shadows.
			const blue = id.map((_, i) => clamp01(at(i) + 0.03 * (1 - at(i))));
			const red = id.map((_, i) => clamp01(at(i) + 0.02 * at(i) ** 2));
			return { master: sCurve(0.11), red, green: id, blue };
		}
		case "lift-shadows": {
			const m = id.map((_, i) => Math.min(1, i / 15 + 0.08 * (1 - i / 15)));
			return { master: m, red: id, green: id, blue: id };
		}
		case "fade-film": {
			const m = id.map((_, i) => 0.08 + (i / 15) * 0.84);
			return { master: m, red: id, green: id, blue: id };
		}
		case "matte": {
			const m = id.map((_, i) => 0.12 + (i / 15) * 0.76);
			return { master: m, red: id, green: id, blue: id };
		}
		case "xprocess": {
			// Cross-processed film: green shadows, blue highlight dip.
			const green = id.map((_, i) => clamp01(at(i) + 0.05 * (1 - at(i)) ** 2));
			const blue = id.map((_, i) => clamp01(at(i) - 0.05 * at(i) ** 2));
			return { master: sCurve(0.03), red: id, green, blue };
		}
		default:
			return { master: id, red: id, green: id, blue: id };
	}
}
