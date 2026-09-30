import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const COLOR_FILTER_SHADER = "color-filter";

export interface FilterPreset {
	id: string;
	name: string;
	/** warmth, tint, contrast, saturation, fade, grain, vignette */
	look: [number, number, number, number, number, number, number];
	/** 3x3 row-major matrix + lift(3) + gain(3) */
	matrix: number[];
	lift: [number, number, number];
	gain: [number, number, number];
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const FILTER_PRESETS: FilterPreset[] = [
	{
		id: "none",
		name: "None",
		look: [0, 0, 0, 0, 0, 0, 0],
		matrix: IDENTITY_MATRIX,
		lift: [0, 0, 0],
		gain: [1, 1, 1],
	},
	{
		id: "clear",
		name: "Clear",
		look: [0.05, 0, 0.12, 0.15, 0, 0, 0],
		matrix: IDENTITY_MATRIX,
		lift: [0, 0, 0],
		gain: [1.02, 1, 0.98],
	},
	{
		id: "memory",
		name: "Memory",
		look: [0.25, 0.05, 0.05, -0.1, 0.25, 0.05, 0.15],
		matrix: [1.05, 0.02, 0, 0.03, 1, 0, 0, 0.02, 0.95],
		lift: [0.02, 0.01, 0],
		gain: [1, 0.98, 0.95],
	},
	{
		id: "sunset",
		name: "Sunset",
		look: [0.45, 0.1, 0.1, 0.2, 0.1, 0, 0.2],
		matrix: [1.1, 0.05, 0, 0.02, 1, 0, 0, 0, 0.9],
		lift: [0.03, 0.01, 0],
		gain: [1.03, 0.99, 0.94],
	},
	{
		id: "ocean",
		name: "Ocean",
		look: [-0.3, 0.05, 0.08, 0.15, 0, 0, 0],
		matrix: [0.95, 0, 0.02, 0, 1, 0.03, 0.02, 0.03, 1.05],
		lift: [0, 0.01, 0.02],
		gain: [0.98, 1, 1.03],
	},
	{
		id: "noir",
		name: "Noir",
		look: [0, 0, 0.35, -0.85, 0.1, 0.1, 0.35],
		// BT.709 luma rows — true monochrome (equal weights would skew green).
		matrix: [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722],
		lift: [0, 0, 0],
		gain: [1.05, 1.05, 1.05],
	},
	{
		id: "vintage",
		name: "Vintage",
		look: [0.2, -0.05, -0.1, -0.2, 0.4, 0.08, 0.3],
		matrix: [1.02, 0.04, 0, 0.02, 0.98, 0, 0, 0.03, 0.92],
		lift: [0.04, 0.03, 0.02],
		gain: [1, 0.99, 0.96],
	},
	{
		id: "cyber",
		name: "Cyber",
		look: [-0.15, 0.15, 0.15, 0.3, 0, 0.05, 0.1],
		matrix: [0.95, 0.05, 0.05, 0.05, 1.05, 0.1, 0.1, 0.05, 1.1],
		lift: [0, 0, 0.01],
		gain: [0.99, 1.01, 1.04],
	},
	{
		id: "warm-film",
		name: "Warm Film",
		look: [0.3, 0, 0, 0.05, 0.3, 0.06, 0.2],
		matrix: IDENTITY_MATRIX,
		lift: [0.03, 0.02, 0.01],
		gain: [1.02, 1, 0.97],
	},
	{
		id: "cold-film",
		name: "Cold Film",
		look: [-0.3, 0, 0, 0.05, 0.3, 0.06, 0.2],
		matrix: IDENTITY_MATRIX,
		lift: [0.01, 0.02, 0.03],
		gain: [0.97, 1, 1.02],
	},
	{
		id: "golden",
		name: "Golden",
		look: [0.5, 0.08, 0.05, 0.1, 0.15, 0, 0.1],
		matrix: [1.08, 0.04, 0, 0.02, 1.0, 0, 0, 0.01, 0.92],
		lift: [0.02, 0.01, 0],
		gain: [1.02, 1, 0.96],
	},
	{
		id: "forest",
		name: "Forest",
		look: [-0.1, -0.05, 0.12, 0.2, 0.05, 0, 0.15],
		matrix: [0.98, 0, 0, 0.03, 1.05, 0.02, 0, 0.02, 0.98],
		lift: [0, 0.01, 0],
		gain: [0.99, 1.02, 0.99],
	},
	{
		id: "rose",
		name: "Rosé",
		look: [0.1, 0.2, 0, 0.15, 0.2, 0, 0.1],
		matrix: [1.05, 0.02, 0.02, 0.01, 0.98, 0.02, 0.02, 0.01, 1.0],
		lift: [0.02, 0, 0.01],
		gain: [1.02, 0.99, 1.0],
	},
	{
		id: "teal-orange",
		name: "Teal & Orange",
		look: [0.3, 0.02, 0.15, 0.12, 0.05, 0.04, 0.15],
		matrix: [1.03, 0.02, -0.01, 0.01, 1.0, 0.02, -0.01, 0.02, 0.99],
		lift: [0.0, 0.015, 0.035],
		gain: [1.04, 1.0, 0.93],
	},
	{
		id: "moody",
		name: "Moody",
		look: [-0.1, 0, 0.2, -0.35, 0.15, 0.08, 0.3],
		matrix: [0.98, 0.01, 0.01, 0.01, 0.99, 0.01, 0.02, 0.02, 1.02],
		lift: [-0.02, -0.02, -0.01],
		gain: [1.0, 1.0, 1.02],
	},
];

export function getFilterPreset(id: string): FilterPreset {
	return FILTER_PRESETS.find((p) => p.id === id) ?? FILTER_PRESETS[0]!;
}

export interface FilterSnapshot {
	v: 1;
	preset: string;
	look: [number, number, number, number, number, number, number];
	matrix: number[];
	lift: [number, number, number];
	gain: [number, number, number];
}

/**
 * Freeze a preset's look data as JSON. Stored on the effect instance so
 * later library edits never change already-graded projects (versioning).
 */
export function buildFilterSnapshot(presetId: string): string {
	const p = getFilterPreset(presetId);
	const snapshot: FilterSnapshot = {
		v: 1,
		preset: p.id,
		look: [...p.look] as FilterSnapshot["look"],
		matrix: [...p.matrix],
		lift: [...p.lift] as FilterSnapshot["lift"],
		gain: [...p.gain] as FilterSnapshot["gain"],
	};
	return JSON.stringify(snapshot);
}

function readFilterSnapshot(params: ParamValues): FilterSnapshot | null {
	const raw = params.snapshot;
	if (typeof raw !== "string" || !raw) return null;
	try {
		const s = JSON.parse(raw) as Partial<FilterSnapshot>;
		if (
			s?.v === 1 &&
			Array.isArray(s.look) && s.look.length === 7 &&
			Array.isArray(s.matrix) && s.matrix.length === 9 &&
			Array.isArray(s.lift) && s.lift.length === 3 &&
			Array.isArray(s.gain) && s.gain.length === 3
		) {
			return s as FilterSnapshot;
		}
	} catch {
		// corrupt snapshot — fall back to the live definition
	}
	return null;
}

function snapshotToData(snapshot: FilterSnapshot, timeSeconds: number): number[] {
	const data = new Array(64).fill(0);
	data[0] = 1; // intensity applied by caller via params
	const [warmth, tint, contrast, saturation, fade, grain, vignette] = snapshot.look;
	data[1] = warmth!;
	data[2] = tint!;
	data[3] = contrast!;
	data[4] = saturation!;
	data[5] = fade!;
	data[6] = grain!;
	data[7] = vignette!;
	for (let i = 0; i < 9; i++) data[8 + i] = snapshot.matrix[i] ?? (i % 4 === 0 ? 1 : 0);
	data[17] = snapshot.lift[0]!;
	data[18] = snapshot.lift[1]!;
	data[19] = snapshot.lift[2]!;
	data[20] = snapshot.gain[0]!;
	data[21] = snapshot.gain[1]!;
	data[22] = snapshot.gain[2]!;
	data[23] = timeSeconds;
	return data;
}

function num(params: ParamValues, key: string, fallback = 0): number {
	const v = params[key];
	const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? fallback));
	return Number.isFinite(n) ? n : fallback;
}

export function filterParamsToData(effectParams: ParamValues, timeSeconds = 0): number[] {
	const presetId = String(effectParams.preset ?? "none");
	const preset = getFilterPreset(presetId);
	const intensity = Math.min(1, Math.max(0, num(effectParams, "intensity", 100) / 100));
	const [warmth, tint, contrast, saturation, fade, grain, vignette] = preset.look;
	const data = new Array(64).fill(0);
	data[0] = intensity;
	data[1] = warmth;
	data[2] = tint;
	data[3] = contrast;
	data[4] = saturation;
	data[5] = fade;
	data[6] = grain;
	data[7] = vignette;
	for (let i = 0; i < 9; i++) data[8 + i] = preset.matrix[i] ?? (i % 4 === 0 ? 1 : 0);
	data[17] = preset.lift[0]!;
	data[18] = preset.lift[1]!;
	data[19] = preset.lift[2]!;
	data[20] = preset.gain[0]!;
	data[21] = preset.gain[1]!;
	data[22] = preset.gain[2]!;
	// Grain time seed — animates the film grain so it doesn't freeze on stills.
	data[23] = timeSeconds;
	return data;
}

export function buildFilterPasses(effectParams: ParamValues, timeSeconds = 0): EffectPass[] {
	if (String(effectParams.preset ?? "none") === "none") return [];
	const intensity = Math.min(
		1,
		Math.max(0, num(effectParams, "intensity", 100) / 100),
	);
	if (intensity <= 0.001) return [];
	// Prefer the frozen snapshot (project stability); fall back to the
	// live library definition for legacy effects without one.
	const snapshot = readFilterSnapshot(effectParams);
	const data = snapshot
		? snapshotToData(snapshot, timeSeconds)
		: filterParamsToData(effectParams, timeSeconds);
	data[0] = intensity;
	return [{ shader: COLOR_FILTER_SHADER, uniforms: { u_data: data } }];
}

export const filterEffectDefinition: EffectDefinition = {
	type: "filter",
	name: "Filter",
	keywords: ["filter", "lut", "preset", "look", "film", "vintage", "color"],
	params: [
		{
			key: "preset",
			label: "Preset",
			type: "select",
			default: "none",
			keyframable: false,
			options: FILTER_PRESETS.map((p) => ({ value: p.id, label: p.name })),
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
				shader: COLOR_FILTER_SHADER,
				uniforms: ({ effectParams, timeSeconds }) => ({
					u_data: filterParamsToData(effectParams, timeSeconds),
				}),
			},
		],
		buildPasses: ({ effectParams, timeSeconds }) =>
			buildFilterPasses(effectParams, timeSeconds),
	},
};
