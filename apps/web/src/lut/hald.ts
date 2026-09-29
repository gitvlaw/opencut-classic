import type { ParsedCube } from "./parse-cube";

export interface HaldStrip {
	canvas: OffscreenCanvas;
	/** Strip width = N*N, height = N. Pixel (b*N + r, g) = entry (r,g,b). */
	width: number;
	height: number;
}

/**
 * Encode a parsed .cube table as a 2D Hald-style strip canvas matching
 * `rust/crates/effects/src/shaders/lut_3d.wgsl`.
 */
export function buildHaldStrip(parsed: ParsedCube): HaldStrip {
	const n = parsed.size;
	const width = n * n;
	const height = n;
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Failed to get 2d context for Hald strip.");
	const img = ctx.createImageData(width, height);
	const { table } = parsed;
	for (let b = 0; b < n; b++) {
		for (let g = 0; g < n; g++) {
			for (let r = 0; r < n; r++) {
				const src = ((b * n + g) * n + r) * 3;
				const dst = (g * width + (b * n + r)) * 4;
				img.data[dst] = Math.round(table[src]! * 255);
				img.data[dst + 1] = Math.round(table[src + 1]! * 255);
				img.data[dst + 2] = Math.round(table[src + 2]! * 255);
				img.data[dst + 3] = 255;
			}
		}
	}
	ctx.putImageData(img, 0, 0);
	return { canvas, width, height };
}
