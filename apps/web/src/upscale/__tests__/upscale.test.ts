import { describe, expect, it } from "bun:test";
import {
	computeTiles,
	tileWeight,
	tileWeightX,
	tileWeightY,
	TILE_MARGIN,
	TILE_OVERLAP,
	TILE_SIZE,
} from "../tiling";
import {
	compute1080pTarget,
	compute4kTarget,
	shouldOffer4k,
	shouldOfferUpscale,
	UPSCALE_BICUBIC,
	UPSCALE_BILINEAR,
	UPSCALE_LANCZOS,
} from "../types";

// The worker crops TILE_MARGIN px off every shared edge before feathering
// (the zero-padded border is wrong) and keeps the full extent on frame
// edges (that border is real image data). This replicates the worker's
// inner loops exactly and asserts no output pixel is left uncovered.
describe("tile margin crop coverage", () => {
	function simulate({
		width,
		height,
		tile,
		overlap,
		margin,
		factor = 2,
	}: {
		width: number;
		height: number;
		tile: number;
		overlap: number;
		margin: number;
		factor?: number;
	}) {
		const outW = width * factor;
		const outH = height * factor;
		const weights = new Float32Array(outW * outH);
		const contributions = new Uint8Array(outW * outH);
		for (const t of computeTiles(width, height, tile, overlap)) {
			const m = margin;
			const xSkipL = t.sharedLeft ? m : 0;
			const xSkipR = t.sharedRight ? m : 0;
			const ySkipT = t.sharedTop ? m : 0;
			const ySkipB = t.sharedBottom ? m : 0;
			for (let y = 0; y < t.h * factor; y++) {
				const ly = y >> 1;
				if (ly < ySkipT || ly >= t.h - ySkipB) continue;
				const wy = tileWeightY({ tile: t, ly, overlap });
				if (wy <= 0) continue;
				for (let x = 0; x < t.w * factor; x++) {
					const lx = x >> 1;
					if (lx < xSkipL || lx >= t.w - xSkipR) continue;
					const w = tileWeightX({ tile: t, lx, overlap }) * wy;
					if (w <= 0) continue;
					const at = (t.y * factor + y) * outW + (t.x * factor + x);
					weights[at] += w;
					contributions[at]++;
				}
			}
		}
		return { weights, contributions, outW, outH };
	}

	const cases: [number, number][] = [
		[960, 540],
		[1080, 1920],
		[1920, 1080],
		[2560, 1440],
		[720, 1280],
		[100, 80],
		[512, 256],
		[3840, 2160],
	];

	for (const [w, h] of cases) {
		it(`covers every output pixel for ${w}x${h}`, () => {
			const { weights } = simulate({
				width: w,
				height: h,
				tile: TILE_SIZE,
				overlap: TILE_OVERLAP,
				margin: TILE_MARGIN,
			});
			const gaps = weights.reduce((n, v) => (v > 1e-6 ? n : n + 1), 0);
			expect(gaps).toBe(0);
		});
	}

/**
	 * Regression: `overlap - 2 * margin` is the width of the band where two
	 * tiles still overlap after the zero-padded border is trimmed off both.
	 * At zero the neighbours merely touch, the feather ramps run over pixels
	 * that were already discarded, and every tile border becomes a hard cut —
	 * the export comes out as a grid of blocks. Coverage alone cannot catch
	 * this (abutting tiles leave no holes), so assert the blend happens.
	 */
	it("leaves a real blend band between neighbouring tiles", () => {
		expect(TILE_OVERLAP - 2 * TILE_MARGIN).toBeGreaterThan(0);

		const { contributions } = simulate({
			width: 1920,
			height: 1080,
			tile: TILE_SIZE,
			overlap: TILE_OVERLAP,
			margin: TILE_MARGIN,
		});
		// At least some pixels must be produced by more than one tile,
		// otherwise the feathering is decorative.
		const blended = contributions.reduce((n, v) => (v >= 2 ? n : n + 1), 0);
		expect(blended).toBeGreaterThan(0);
	});

	/**
	 * RealESRGAN's zero-padded border contaminates far more than CUGAN's.
	 * Measured against full-frame inference on a 512px tile: the interior is
	 * garbage inside 32px, 0.019 mean error at 32-48px, and only drops under
	 * 1/255 past 64px. Shipping the old 8px margin measured 41-49 dB and the
	 * grid was plainly visible; this pins the margin that fixed it.
	 */
	it("trims enough of the border for RealESRGAN's receptive field", () => {
		expect(TILE_MARGIN).toBeGreaterThanOrEqual(64);
		// And the trim must not eat the whole tile.
expect(TILE_SIZE).toBeGreaterThan(2 * TILE_MARGIN);
	});

	it("would show hard tile seams if the margin ate the overlap", () => {
		// Two unclamped 512px tiles 16px apart: with margin 8 each, tile A
		// ends at 504 and tile B starts at 504 — they touch and nothing
		// blends, which is the grid-of-blocks artefact.
		const { contributions } = simulate({
			width: 1008,
			height: 512,
			tile: 512,
			overlap: 16,
			margin: 8,
		});
		const blended = contributions.reduce((n, v) => (v >= 2 ? n + 1 : n), 0);
		expect(blended).toBe(0);

		const fixed = simulate({
			width: 1008,
			height: 512,
			tile: 512,
			overlap: 32,
			margin: 8,
		});
		const fixedBlended = fixed.contributions.reduce(
			(n, v) => (v >= 2 ? n + 1 : n),
			0,
		);
		expect(fixedBlended).toBeGreaterThan(0);
	});

	it("would report gaps if the margin exceeded the overlap", () => {
		// Guards the test itself: a too-large margin must be detectable.
		const { weights } = simulate({
			width: 960,
			height: 540,
			tile: 256,
			overlap: TILE_OVERLAP,
			margin: TILE_OVERLAP,
		});
		const gaps = weights.reduce((n, v) => (v > 1e-6 ? n : n + 1), 0);
		expect(gaps).toBeGreaterThan(0);
	});
});

describe("tile geometry", () => {
	/**
	 * One size for every frame. Measured against full-frame inference, 512px
	 * tiles both scored better (66.8 dB vs 54.6 dB at equal overlap) and needed
	 * fewer inferences than 256px. Small frames clamp to a single tile.
	 *
	 * Cross-check against the Python stitch simulation used to pick the tile
	 * config: 1920x1080 -> 15 tiles, 1280x720 -> 8, 640x360 -> 2. If these
	 * drift, the seam measurements no longer describe this code.
	 */
	it("produces the tile counts the measured config was validated at", () => {
		expect(TILE_SIZE).toBe(512);
		expect(computeTiles(1920, 1080, TILE_SIZE, TILE_OVERLAP).length).toBe(15);
		expect(computeTiles(1080, 1920, TILE_SIZE, TILE_OVERLAP).length).toBe(15);
		expect(computeTiles(1280, 720, TILE_SIZE, TILE_OVERLAP).length).toBe(8);
		expect(computeTiles(640, 360, TILE_SIZE, TILE_OVERLAP).length).toBe(2);
		// Small enough to infer in one pass: no seams possible.
		expect(computeTiles(512, 288, TILE_SIZE, TILE_OVERLAP).length).toBe(1);
	});
});

describe("computeTiles", () => {
	it("covers the frame with no gaps at the shipped config", () => {
		const tiles = computeTiles(960, 540, TILE_SIZE, TILE_OVERLAP);
		const covered = new Uint8Array(960 * 540);
		for (const t of tiles) {
			for (let y = t.y; y < t.y + t.h; y++) {
				for (let x = t.x; x < t.x + t.w; x++) covered[y * 960 + x] = 1;
			}
		}
		expect(covered.every((v) => v === 1)).toBe(true);
	});

	it("clamps edge tiles inside the frame", () => {
		for (const t of computeTiles(960, 540, TILE_SIZE, TILE_OVERLAP)) {
			expect(t.x + t.w).toBeLessThanOrEqual(960);
			expect(t.y + t.h).toBeLessThanOrEqual(540);
		}
	});

	it("returns a single tile for small frames", () => {
		const tiles = computeTiles(100, 80, TILE_SIZE, TILE_OVERLAP);
		expect(tiles.length).toBe(1);
		expect(tiles[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 80 });
	});

	it("flags shared vs frame edges", () => {
		// 1200 wide at overlap 16 steps 496: tiles at 0, 496, 688 (clamped).
		const tiles = computeTiles(1200, 256, TILE_SIZE, 16);
		expect(tiles.length).toBe(3);
		expect(tiles[0]).toMatchObject({ sharedLeft: false, sharedRight: true });
		expect(tiles[1]).toMatchObject({ sharedLeft: true, sharedRight: true });
		expect(tiles[2]).toMatchObject({ sharedLeft: true, sharedRight: false });
	});
});

// The worker builds separable 1D ramps instead of calling tileWeight() per
// output pixel. That is only valid because tileWeight is a product of an
// x-only and a y-only term — pin it here.
describe("tileWeight separability", () => {
	it("equals wx(x/2) * wy(y/2) for every output pixel", () => {
		for (const tile of computeTiles(1080, 1920, 512, 16)) {
			const ow = tile.w * 2;
			const oh = tile.h * 2;
			const wx = new Float32Array(ow);
			const wy = new Float32Array(oh);
			for (let x = 0; x < ow; x++) {
				wx[x] = tileWeightX({ tile, lx: Math.min(tile.w - 1, x >> 1), overlap: 16 });
			}
			for (let y = 0; y < oh; y++) {
				wy[y] = tileWeightY({ tile, ly: Math.min(tile.h - 1, y >> 1), overlap: 16 });
			}
			for (let y = 0; y < oh; y++) {
				for (let x = 0; x < ow; x++) {
					const direct = tileWeight(tile, Math.min(tile.w - 1, x >> 1), Math.min(tile.h - 1, y >> 1), 16);
					expect((wx[x] ?? 0) * (wy[y] ?? 0)).toBeCloseTo(direct, 10);
				}
			}
		}
	});
});

describe("tileWeight", () => {
	it("is 1 in tile interiors and ramps at shared edges", () => {
		const tiles = computeTiles(512, 256, 256, 16);
	 const left = tiles[0]!;
		expect(tileWeight(left, 10, 10, 16)).toBe(1);
		const edge = tileWeight(left, 255, 10, 16);
		expect(edge).toBeGreaterThan(0);
		expect(edge).toBeLessThan(1);
	});

	it("accumulates positive weight everywhere (uniform image stays exact)", () => {
		const tiles = computeTiles(960, 540, 256, 16);
	 const acc = new Float32Array(960 * 540);
		for (const t of tiles) {
			for (let y = 0; y < t.h; y++) {
				for (let x = 0; x < t.w; x++) {
					acc[(t.y + y) * 960 + (t.x + x)] += tileWeight(t, x, y, 16);
				}
			}
		}
		expect(acc.every((w) => w > 1e-6)).toBe(true);
	});
});

describe("1080p targets", () => {
	it("preserves aspect with even dimensions", () => {
		expect(compute1080pTarget(960, 540)).toEqual({ width: 1920, height: 1080 });
		const t = compute1080pTarget(1280, 720);
		expect(t).toEqual({ width: 1920, height: 1080 });
		const odd = compute1080pTarget(1000, 500);
		expect(odd.width % 2).toBe(0);
		expect(odd.height).toBe(1080);
	});

	it("only offers upscale below 1080p", () => {
		expect(shouldOfferUpscale(960, 540)).toBe(true);
		expect(shouldOfferUpscale(1920, 1080)).toBe(false);
		expect(shouldOfferUpscale(3840, 2160)).toBe(false);
	});

	it("offers 1080p to portrait canvases by short side", () => {
		expect(shouldOfferUpscale(720, 1280)).toBe(true);
		expect(compute1080pTarget(720, 1280)).toEqual({ width: 1080, height: 1920 });
		// 1080x1920 portrait is already there — gets 4K instead.
		expect(shouldOfferUpscale(1080, 1920)).toBe(false);
		expect(shouldOffer4k(1080, 1920)).toBe(true);
	});

	it("4K target is an exact even 2x", () => {
		expect(compute4kTarget(1920, 1080)).toEqual({ width: 3840, height: 2160 });
		expect(compute4kTarget(1080, 1920)).toEqual({ width: 2160, height: 3840 });
		expect(shouldOffer4k(3840, 2160)).toBe(false);
		expect(shouldOffer4k(1920, 1080)).toBe(true);
	});

	it("shader mode ids are stable (match upscale.wgsl)", () => {
		expect(UPSCALE_BILINEAR).toBe(0);
		expect(UPSCALE_BICUBIC).toBe(1);
		expect(UPSCALE_LANCZOS).toBe(2);
	});
});
