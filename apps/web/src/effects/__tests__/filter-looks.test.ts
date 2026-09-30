import { describe, expect, it } from "bun:test";
import { FILTER_PRESETS, filterParamsToData } from "../definitions/filter";
import { PROBES, luma, saturation, simulateFilter } from "./filter-sim";

describe("preset library health", () => {
	it("every preset renders differently on a probe set", () => {
		const probes = [PROBES.skin, PROBES.sky, PROBES.leaf, PROBES.gray, PROBES.red];
		const seen = new Map<string, string>();
		for (const p of FILTER_PRESETS) {
			if (p.id === "none") continue;
			const key = JSON.stringify(
				probes.map((probe) =>
					simulateFilter(p.id, probe).map((v) => v.toFixed(3)),
				),
			);
			expect(seen.has(key)).toBe(false);
			seen.set(key, p.id);
		}
	});

	it("matrix row sums stay within clipping-safe bounds", () => {
		for (const p of FILTER_PRESETS) {
			for (let row = 0; row < 3; row++) {
				const sum =
					(p.matrix[row * 3] ?? 0) + (p.matrix[row * 3 + 1] ?? 0) + (p.matrix[row * 3 + 2] ?? 0);
				expect(sum).toBeLessThanOrEqual(1.08);
			}
		}
	});
});

describe("sepia (1/12)", () => {
	it("is registered", () => {
		expect(FILTER_PRESETS.some((p) => p.id === "sepia")).toBe(true);
	});

	it("turns gray warm with R>G>B", () => {
		const [r, g, b] = simulateFilter("sepia", PROBES.gray);
		expect(r).toBeGreaterThan(g);
		expect(g).toBeGreaterThan(b);
	});

	it("desaturates strong colors", () => {
		expect(saturation(simulateFilter("sepia", PROBES.red))).toBeLessThan(
			saturation(PROBES.red),
		);
	});

	it("keeps black dark and white bright-but-warm", () => {
		const [br, bg, bb] = simulateFilter("sepia", PROBES.black);
		expect(luma([br, bg, bb])).toBeLessThan(0.25);
		const [wr, wg, wb] = simulateFilter("sepia", PROBES.white);
		expect(wr).toBeGreaterThan(wg);
		expect(wg).toBeGreaterThan(wb);
		expect(wr).toBeLessThanOrEqual(1);
	});
});

describe("hc-bw (2/12)", () => {
	it("is neutral gray (R≈G≈B)", () => {
		for (const probe of [PROBES.gray, PROBES.skin, PROBES.sky, PROBES.red] as const) {
			const [r, g, b] = simulateFilter("hc-bw", probe);
			expect(Math.abs(r - g)).toBeLessThan(0.02);
			expect(Math.abs(g - b)).toBeLessThan(0.02);
		}
	});

	it("crushes blacks and pushes whites past noir", () => {
		const hcBlack = luma(simulateFilter("hc-bw", PROBES.black));
		const noirBlack = luma(simulateFilter("noir", PROBES.black));
		expect(hcBlack).toBeLessThanOrEqual(noirBlack);
		const hcWhite = luma(simulateFilter("hc-bw", PROBES.white));
		expect(hcWhite).toBeGreaterThan(0.95);
	});

	it("kills saturation completely", () => {
		expect(saturation(simulateFilter("hc-bw", PROBES.red))).toBeLessThan(0.03);
	});
});

describe("blockbuster (3/12)", () => {
	it("warms skin (R/B ratio up) and cools sky (B/R ratio up)", () => {
		const [sr, , sb] = simulateFilter("blockbuster", PROBES.skin);
		expect(sr / sb).toBeGreaterThan(0.72 / 0.4 * 1.1);
		const [kr, , kb] = simulateFilter("blockbuster", PROBES.sky);
		expect(kb / kr).toBeGreaterThan(0.85 / 0.35);
	});

	it("does not clip white", () => {
		const [r, g, b] = simulateFilter("blockbuster", PROBES.white);
		expect(Math.max(r, g, b)).toBeLessThanOrEqual(1);
	});

	it("warms skin clearly vs source (R/B up 30%+)", () => {
		const [br, , bb] = simulateFilter("blockbuster", PROBES.skin);
		expect(br / bb).toBeGreaterThan((0.72 / 0.4) * 1.3);
	});

	it("pushes shadows teal harder than sunset", () => {
		const [, , ebb] = simulateFilter("blockbuster", PROBES.black);
		const [ebr] = simulateFilter("blockbuster", PROBES.black);
		const [, , sbb] = simulateFilter("sunset", PROBES.black);
		const [sbr] = simulateFilter("sunset", PROBES.black);
		expect(ebb / Math.max(ebr, 1e-3)).toBeGreaterThan(sbb / Math.max(sbr, 1e-3));
	});
});

describe("bright-airy (4/12)", () => {
	it("lifts blacks and brightens mids vs source", () => {
		expect(luma(simulateFilter("bright-airy", PROBES.black))).toBeGreaterThan(0.12);
		expect(luma(simulateFilter("bright-airy", PROBES.gray))).toBeGreaterThan(0.5);
	});

	it("lifts blacks harder than clear (its closest sibling)", () => {
		const airy = luma(simulateFilter("bright-airy", PROBES.black));
		const clear = luma(simulateFilter("clear", PROBES.black));
		expect(airy).toBeGreaterThan(clear + 0.03);
	});

	it("keeps white from hard clipping", () => {
		const [r, g, b] = simulateFilter("bright-airy", PROBES.white);
		expect(Math.max(r, g, b)).toBeLessThan(1);
	});
});

describe("kodachrome (5/12)", () => {
	it("boosts saturation of already-saturated colors", () => {
		expect(saturation(simulateFilter("kodachrome", PROBES.red))).toBeGreaterThan(
			saturation(PROBES.red),
		);
		expect(saturation(simulateFilter("kodachrome", PROBES.leaf))).toBeGreaterThan(
			saturation(PROBES.leaf),
		);
	});

	it("punches harder than golden (closest warm sibling)", () => {
		const k = saturation(simulateFilter("kodachrome", PROBES.red));
		const g = saturation(simulateFilter("golden", PROBES.red));
		expect(k).toBeGreaterThan(g);
	});
});

describe("fuji (6/12)", () => {
	it("pushes foliage green (G/R up vs source)", () => {
		const [r, g] = simulateFilter("fuji", PROBES.leaf);
		expect(g / Math.max(r, 1e-3)).toBeGreaterThan(0.5 / 0.25);
	});

	it("stays cleaner than forest (less saturation, less vignette baked)", () => {
		const fuji = saturation(simulateFilter("fuji", PROBES.leaf));
		const forest = saturation(simulateFilter("forest", PROBES.leaf));
		expect(fuji).toBeLessThan(forest);
	});
});

describe("autumn (7/12)", () => {
	const olive: [number, number, number] = [0.45, 0.45, 0.15];
	const orange: [number, number, number] = [0.75, 0.4, 0.1];

	it("warms olive foliage (R/G up vs source)", () => {
		const [r, g] = simulateFilter("autumn", olive);
		expect(r / Math.max(g, 1e-3)).toBeGreaterThan(1.0);
	});

	it("pops orange foliage harder than golden and sunset", () => {
		const a = saturation(simulateFilter("autumn", orange));
		expect(a).toBeGreaterThan(saturation(simulateFilter("golden", orange)));
		expect(a).toBeGreaterThan(saturation(simulateFilter("sunset", orange)));
	});

	it("never clips skin (punch must spare midtones)", () => {
		const [r] = simulateFilter("autumn", PROBES.skin);
		expect(r).toBeLessThan(0.99);
	});
});

describe("winter (8/12)", () => {
	it("casts neutrals cool (gray B>R)", () => {
		const [, g, b] = simulateFilter("winter", PROBES.gray);
		const [r] = simulateFilter("winter", PROBES.gray);
		expect(b).toBeGreaterThan(r);
		expect(g).toBeGreaterThan(r * 0.9);
	});

	it("lifts blacks with a blue toe", () => {
		const [r, , b] = simulateFilter("winter", PROBES.black);
		expect(b - r).toBeGreaterThan(0.02);
		expect(luma(simulateFilter("winter", PROBES.black))).toBeGreaterThan(0.08);
	});

	it("keeps whites unclipped unlike punchy looks", () => {
		const w = simulateFilter("winter", PROBES.white);
		expect(Math.max(...w)).toBeLessThan(1);
	});

	it("holds darker blacks than cold-film (less fade)", () => {
		const winter = luma(simulateFilter("winter", PROBES.black));
		const cold = luma(simulateFilter("cold-film", PROBES.black));
		expect(winter).toBeLessThan(cold);
	});
});

describe("midnight (9/12)", () => {
	it("casts deep blue shadows (black B-R beats ocean and moody)", () => {
		const [r, , b] = simulateFilter("midnight", PROBES.black);
		const [, , ob] = simulateFilter("ocean", PROBES.black);
		const [or] = simulateFilter("ocean", PROBES.black);
		const [, , mb] = simulateFilter("moody", PROBES.black);
		const [mr] = simulateFilter("moody", PROBES.black);
		expect(b - r).toBeGreaterThan(0.05);
		expect(b - r).toBeGreaterThan(ob - or);
		expect(b - r).toBeGreaterThan(mb - mr);
	});

	it("keeps sky saturated unlike moody", () => {
		const mid = saturation(simulateFilter("midnight", PROBES.sky));
		const mod = saturation(simulateFilter("moody", PROBES.sky));
		expect(mid).toBeGreaterThan(mod + 0.05);
	});
});

describe("horror (10/12)", () => {
	it("sickens shadows green (dark-gray G leads R)", () => {
		// Pure black crushes to 0 by design — probe dark gray instead.
		const dark: [number, number, number] = [0.18, 0.18, 0.18];
		const [r, g] = simulateFilter("horror", dark);
		expect(g - r).toBeGreaterThan(0.005);
	});

	it("desaturates skin vs source", () => {
		expect(saturation(simulateFilter("horror", PROBES.skin))).toBeLessThan(
			saturation(PROBES.skin),
		);
	});

	it("is grainier than moody", () => {
		const h = filterParamsToData({ preset: "horror", intensity: 100 });
		const m = filterParamsToData({ preset: "moody", intensity: 100 });
		expect(h[6]).toBeGreaterThan(m[6]!);
	});
});

describe("creamy (11/12)", () => {
	it("warms neutrals while bright-airy stays neutral", () => {
		const [cr, , cb] = simulateFilter("creamy", PROBES.gray);
		const [ar, , ab] = simulateFilter("bright-airy", PROBES.gray);
		expect(cr / cb).toBeGreaterThan(1.02);
		expect(Math.abs(ar / ab - 1)).toBeLessThan(0.05);
	});

	it("lifts blacks softly — less than bright-airy", () => {
		const creamy = luma(simulateFilter("creamy", PROBES.black));
		const airy = luma(simulateFilter("bright-airy", PROBES.black));
		expect(creamy).toBeGreaterThan(0.08);
		expect(creamy).toBeLessThan(airy);
	});
});

describe("cinestill (12/12)", () => {
	it("cools shadow toes vs warm-film", () => {
		const [cr, , cb] = simulateFilter("cinestill", PROBES.black);
		const [wr, , wb] = simulateFilter("warm-film", PROBES.black);
		expect(cb - cr).toBeGreaterThan(wb - wr);
	});

	it("glows highlights warmer than warm-film", () => {
		const [cr, , cb] = simulateFilter("cinestill", PROBES.white);
		const [wr, , wb] = simulateFilter("warm-film", PROBES.white);
		expect(cr / Math.max(cb, 1e-3)).toBeGreaterThan(wr / Math.max(wb, 1e-3));
	});
});
