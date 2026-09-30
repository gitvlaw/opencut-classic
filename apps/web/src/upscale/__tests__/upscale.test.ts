import { describe, expect, it } from "bun:test";
import { computeTiles, tileWeight } from "../tiling";
import {
	compute1080pTarget,
	compute4kTarget,
	shouldOffer4k,
	shouldOfferUpscale,
	UPSCALE_BICUBIC,
	UPSCALE_BILINEAR,
	UPSCALE_LANCZOS,
} from "../types";

describe("computeTiles", () => {
	it("covers 960x540 with 256/16 with no gaps", () => {
		const tiles = computeTiles(960, 540, 256, 16);
		expect(tiles.length).toBe(12);
		const covered = new Uint8Array(960 * 540);
		for (const t of tiles) {
			for (let y = t.y; y < t.y + t.h; y++) {
				for (let x = t.x; x < t.x + t.w; x++) covered[y * 960 + x] = 1;
			}
		}
		expect(covered.every((v) => v === 1)).toBe(true);
	});

	it("clamps edge tiles inside the frame", () => {
		for (const t of computeTiles(960, 540, 256, 16)) {
			expect(t.x + t.w).toBeLessThanOrEqual(960);
			expect(t.y + t.h).toBeLessThanOrEqual(540);
		}
	});

	it("returns a single tile for small frames", () => {
		const tiles = computeTiles(100, 80, 256, 16);
		expect(tiles.length).toBe(1);
		expect(tiles[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 80 });
	});

	it("flags shared vs frame edges", () => {
		const tiles = computeTiles(512, 256, 256, 16);
		expect(tiles.length).toBe(3);
		expect(tiles[0]).toMatchObject({ sharedLeft: false, sharedRight: true });
		expect(tiles[1]).toMatchObject({ sharedLeft: true, sharedRight: true });
		expect(tiles[2]).toMatchObject({ sharedLeft: true, sharedRight: false });
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
