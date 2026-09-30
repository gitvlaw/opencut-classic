import { describe, expect, it } from "bun:test";
import { curvePreset, identityCurve } from "../definitions/curves";
import {
	buildFilterPasses,
	buildFilterSnapshot,
	filterParamsToData,
} from "../definitions/filter";
import {
	deleteGradePreset,
	listGradePresets,
	pickGradeParams,
	renameGradePreset,
	saveGradePreset,
	type GradePresetStorage,
} from "../user-presets";

function fakeStore(): GradePresetStorage {
	const map = new Map<string, string>();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		removeItem: (k) => void map.delete(k),
	};
}

describe("curvePreset additions", () => {
	it("returns valid 16-point channels for every new preset", () => {
		for (const name of ["portrait", "landscape", "matte", "xprocess"]) {
			const p = curvePreset(name);
			for (const ch of [p.master, p.red, p.green, p.blue] as const) {
				expect(ch.length).toBe(16);
				expect(ch.every((v) => v >= 0 && v <= 1)).toBe(true);
			}
		}
	});

	it("portrait warms shadows (red lifted, blue dipped)", () => {
		const p = curvePreset("portrait");
		const id = identityCurve();
		// index 2 avoids the 0-clamp at the exact black point
		expect(p.red[2]!).toBeGreaterThan(id[2]!);
		expect(p.blue[2]!).toBeLessThan(id[2]!);
	});

	it("xprocess pushes green shadows and dips blue highlights", () => {
		const p = curvePreset("xprocess");
		expect(p.green[0]!).toBeGreaterThan(identityCurve()[0]!);
		expect(p.blue[15]!).toBeLessThan(identityCurve()[15]!);
	});

	it("presets are distinct from each other", () => {
		const names = ["s-curve", "portrait", "landscape", "matte", "xprocess", "fade-film"];
		const seen = new Set(names.map((n) => JSON.stringify(curvePreset(n))));
		expect(seen.size).toBe(names.length);
	});
});

describe("user grade presets", () => {
	it("saves, lists, renames and deletes", () => {
		const store = fakeStore();
		expect(listGradePresets(store)).toEqual([]);
		const entry = saveGradePreset("  Golden hour  ", { exposure: 0.5, contrast: 20, junk: 1 }, store);
		expect(entry?.name).toBe("Golden hour");
		// only numeric Adjust keys survive
		expect(entry?.params).toEqual({ exposure: 0.5, contrast: 20 });
		expect(listGradePresets(store).length).toBe(1);
		expect(renameGradePreset(entry!.id, "Dusk", store)).toBe(true);
		expect(listGradePresets(store)[0]!.name).toBe("Dusk");
		deleteGradePreset(entry!.id, store);
		expect(listGradePresets(store)).toEqual([]);
	});

	it("rejects empty names and caps the list", () => {
		const store = fakeStore();
		expect(saveGradePreset("   ", { exposure: 1 }, store)).toBeNull();
		for (let i = 0; i < 30; i++) saveGradePreset(`p${i}`, { exposure: i }, store);
		expect(listGradePresets(store).length).toBeLessThanOrEqual(24);
		// newest first
		expect(listGradePresets(store)[0]!.name).toBe("p29");
	});

	it("pickGradeParams drops non-numeric and unknown keys", () => {
		expect(pickGradeParams({ exposure: 1, hue: "x", foo: 2 })).toEqual({ exposure: 1 });
	});
});

describe("filter snapshot versioning", () => {
	it("snapshot round-trips the sunset look", () => {
		const snap = buildFilterSnapshot("sunset");
		const viaSnapshot = buildFilterPasses(
			{ preset: "sunset", intensity: 100, snapshot: snap },
			0,
		);
		const viaLibrary = buildFilterPasses({ preset: "sunset", intensity: 100 }, 0);
		expect(viaSnapshot).toEqual(viaLibrary);
	});

	it("snapshot wins over a changed library definition", () => {
		const snap = buildFilterSnapshot("sunset");
		const data = (
			buildFilterPasses({ preset: "sunset", intensity: 100, snapshot: snap }, 0)[0]!
				.uniforms.u_data as number[]
		);
		// sunset gain baked at snapshot time, independent of future edits
		expect(data[20]).toBeCloseTo(1.03, 5);
		expect(data[22]).toBeCloseTo(0.94, 5);
	});

	it("corrupt snapshots fall back to the live definition", () => {
		const passes = buildFilterPasses(
			{ preset: "sunset", intensity: 100, snapshot: "{broken" },
			0,
		);
		expect(passes.length).toBe(1);
		expect(
			(passes[0]!.uniforms.u_data as number[]).slice(0, 23),
		).toEqual(filterParamsToData({ preset: "sunset", intensity: 100 }).slice(0, 23));
	});
});
