import { filterParamsToData } from "../definitions/filter";

export type RGB = [number, number, number];

export const PROBES = {
	skin: [0.72, 0.52, 0.4] as RGB,
	sky: [0.35, 0.55, 0.85] as RGB,
	leaf: [0.25, 0.5, 0.2] as RGB,
	gray: [0.5, 0.5, 0.5] as RGB,
	white: [0.9, 0.9, 0.9] as RGB,
	black: [0.08, 0.08, 0.08] as RGB,
	red: [0.8, 0.15, 0.1] as RGB,
};

/**
 * JS replica of color_filter.wgsl (deterministic parts: grain zeroed,
 * vignette sampled at frame center where it equals 1). Lets tests assert
 * the *direction* of each preset on probe colors without a GPU.
 */
export function simulateFilter(presetId: string, src: RGB): RGB {
	const data = filterParamsToData({ preset: "none", intensity: 0 }, 0);
	const real = filterParamsToData({ preset: presetId, intensity: 100 }, 0);
	for (let i = 0; i < real.length; i++) data[i] = real[i]!;
	data[6] = 0; // grain: time-seeded noise, excluded from assertions

	let r = src[0] * data[20]! + data[17]!;
	let g = src[1] * data[21]! + data[18]!;
	let b = src[2] * data[22]! + data[19]!;
	r *= 1 + data[1]! * 0.1;
	b *= 1 - data[1]! * 0.1;
	g *= 1 + data[2]! * 0.05;
	const nr = data[8]! * r + data[9]! * g + data[10]! * b;
	const ng = data[11]! * r + data[12]! * g + data[13]! * b;
	const nb = data[14]! * r + data[15]! * g + data[16]! * b;
	r = nr; g = ng; b = nb;
	r = (r - 0.5) * (1 + data[3]!) + 0.5;
	g = (g - 0.5) * (1 + data[3]!) + 0.5;
	b = (b - 0.5) * (1 + data[3]!) + 0.5;
	const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	const s = 1 + data[4]!;
	r = l + (r - l) * s;
	g = l + (g - l) * s;
	b = l + (b - l) * s;
	const f = Math.min(1, Math.max(0, data[5]!)) * 0.5;
	const t = l * 0.5 + 0.25;
	r = r + (t - r) * f;
	g = g + (t - g) * f;
	b = b + (t - b) * f;
	const cl = (v: number) => Math.min(1, Math.max(0, v));
	// intensity is 100%: output = graded
	return [cl(r), cl(g), cl(b)];
}

export function saturation([r, g, b]: RGB): number {
	return Math.max(r, g, b) - Math.min(r, g, b);
}

export function luma([r, g, b]: RGB): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
