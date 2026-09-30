import { describe, expect, it } from "bun:test";
import {
	buildPasteUpdates,
	collectClipTargets,
	copyGradeFromElement,
	remapEffectAnimations,
	stripEffectParamAnimations,
	type ClipTarget,
	type GradePayload,
} from "../grade-clipboard";
import type { MediaTime } from "@/wasm";
import type { TimelineElement, VisualElement } from "@/timeline";

// Fixtures are deliberately partial (only the fields a test touches), so a
// structural cast is the honest way to build them.
const video = (overrides: Partial<VisualElement> = {}): VisualElement =>
	({
		id: "v1",
		name: "clip",
		type: "video",
		mediaId: "m1",
		duration: 100,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		params: {},
		effects: [],
		...overrides,
	}) as VisualElement;

describe("copyGradeFromElement", () => {
	it("returns null when no color effects", () => {
		expect(copyGradeFromElement(video())).toBeNull();
		expect(
			copyGradeFromElement(video({ effects: [{ id: "b1", type: "blur", params: {}, enabled: true }] })),
		).toBeNull();
	});

	it("keeps color effects with params and their keyframes only", () => {
		const el = video({
			effects: [
				{ id: "a1", type: "adjust", params: { exposure: 1 }, enabled: true },
				{ id: "b1", type: "blur", params: {}, enabled: true },
			],
			animations: {
				"effects.a1.params.exposure": { keys: [] },
				"transform.scaleX": { keys: [] },
			} as never,
		});
		const payload = copyGradeFromElement(el)!;
		expect(payload.effects.length).toBe(1);
		expect(payload.effects[0]).toMatchObject({
			type: "adjust",
			params: { exposure: 1 },
			sourceEffectId: "a1",
		});
		expect(Object.keys(payload.effects[0]!.animations ?? {})).toEqual([
			"effects.a1.params.exposure",
		]);
	});
});

describe("remapEffectAnimations", () => {
	it("rewrites the effect id prefix only", () => {
		const out = remapEffectAnimations({
			animations: {
				"effects.old.params.exposure": { keys: [] },
				"transform.scaleX": { keys: [] },
			} as never,
			oldEffectId: "old",
			newEffectId: "new",
		});
		expect(Object.keys(out ?? {}).sort()).toEqual([
			"effects.new.params.exposure",
			"transform.scaleX",
		]);
	});

	it("returns undefined for empty input", () => {
		expect(
			remapEffectAnimations({ animations: undefined, oldEffectId: "a", newEffectId: "b" }),
		).toBeUndefined();
	});
});

describe("buildPasteUpdates", () => {
	const payload: GradePayload = {
		effects: [
			{
				type: "adjust",
				params: { exposure: 2 },
				sourceEffectId: "src",
				animations: { "effects.src.params.exposure": { keys: [] } } as never,
			},
		],
	};
	const target = (id: string, effects: VisualElement["effects"] = []): ClipTarget => ({
		trackId: "t1",
		element: video({ id, effects }),
	});

	it("overwrites same-type effect in place, keeping its id", () => {
		const [update] = buildPasteUpdates({
			targets: [target("v2", [{ id: "keep", type: "adjust", params: { exposure: 0 }, enabled: true }])],
			payload,
		});
		const effects = (update!.updates as { effects: { id: string; params: object }[] }).effects;
		expect(effects.length).toBe(1);
		expect(effects[0]).toMatchObject({ id: "keep", params: { exposure: 2 } });
		const animations = (update!.updates as { animations?: object }).animations as
			| Record<string, unknown>
			| undefined;
		expect(Object.keys(animations ?? {})).toEqual(["effects.keep.params.exposure"]);
	});

	it("appends missing effect with a fresh id", () => {
		const [update] = buildPasteUpdates({ targets: [target("v3")], payload });
		const effects = (update!.updates as { effects: { id: string; type: string }[] }).effects;
		expect(effects.length).toBe(1);
		expect(effects[0]!.type).toBe("adjust");
		expect(effects[0]!.id).not.toBe("src");
	});

	it("fans out to many targets", () => {
		const updates = buildPasteUpdates({ targets: [target("a"), target("b"), target("c")], payload });
		expect(updates.map((u) => u.elementId)).toEqual(["a", "b", "c"]);
		const ids = updates.map(
			(u) => (u.updates as { effects: { id: string }[] }).effects[0]!.id,
		);
		expect(new Set(ids).size).toBe(3);
	});

	// Regression: the patch used to omit the `animations` key entirely, so
	// a stale keyframe channel kept overriding every pasted param and the
	// apply looked like it did nothing.
	it("clears a stale keyframe channel when the payload has no keyframes", () => {
		const [update] = buildPasteUpdates({
			targets: [
				{
					trackId: "t1",
					element: video({
						id: "v9",
						effects: [{ id: "A", type: "adjust", params: { exposure: 0 }, enabled: true }],
						animations: {
							"effects.A.params.exposure": {
								keys: [
									{ id: "k1", time: 0, value: -5 },
									{ id: "k2", time: 50, value: 5 },
								],
							},
						} as never,
					}),
				},
			],
			payload: {
				effects: [
					{ type: "adjust", params: { exposure: 2 }, sourceEffectId: "src" },
				],
			},
		});
		const effects = (update!.updates as { effects: { params: object }[] }).effects;
		expect(effects[0]!.params).toEqual({ exposure: 2 });
		// The key must be present and empty — omitting it keeps the old value.
		expect("animations" in update!.updates).toBe(true);
		expect(Object.keys((update!.updates as { animations?: object }).animations ?? {})).toEqual([]);
	});

	it("keeps unrelated animation channels when stripping the pasted ones", () => {
		const [update] = buildPasteUpdates({
			targets: [
				{
					trackId: "t1",
					element: video({
						id: "v10",
						effects: [{ id: "A", type: "adjust", params: {}, enabled: true }],
						animations: {
							"effects.A.params.exposure": { keys: [] },
							"transform.scaleX": { keys: [] },
						} as never,
					}),
				},
			],
			payload: { effects: [{ type: "adjust", params: { exposure: 1 }, sourceEffectId: "s" }] },
		});
		expect(
			Object.keys((update!.updates as { animations?: object }).animations ?? {}),
		).toEqual(["transform.scaleX"]);
	});

	// Regression: keyframe times are relative to the source clip, so a
	// shorter target clip used to keep keys past its own duration.
	it("clamps pasted keyframes to the target clip duration", () => {
		const [update] = buildPasteUpdates({
			targets: [{ trackId: "t1", element: video({ id: "short", duration: 20 as MediaTime }) }],
			payload: {
				effects: [
					{
						type: "adjust",
						params: { exposure: 1 },
						sourceEffectId: "src",
						animations: {
							"effects.src.params.exposure": {
								keys: [
									{ id: "k1", time: 0, value: 0 },
									{ id: "k2", time: 10, value: 3 },
									{ id: "k3", time: 90, value: 9 },
								],
							},
						} as never,
					},
				],
			},
		});
		const animations = (
			update!.updates as { animations?: Record<string, { keys: { time: MediaTime }[] }> }
		).animations;
		const keys = Object.values(animations ?? {})[0]!.keys;
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) {
			expect(key.time).toBeLessThanOrEqual(20);
		}
	});

	it("drops duplicate same-type effects so a stale one cannot re-grade", () => {
		const [update] = buildPasteUpdates({
			targets: [
				target("v11", [
					{ id: "first", type: "adjust", params: { exposure: 0 }, enabled: true },
					{ id: "dup", type: "adjust", params: { exposure: 9 }, enabled: true },
				]),
			],
			payload: {
				effects: [{ type: "adjust", params: { exposure: 2 }, sourceEffectId: "src" }],
			},
		});
		const effects = (update!.updates as { effects: { id: string }[] }).effects;
		expect(effects.length).toBe(1);
		expect(effects[0]!.id).toBe("first");
	});
});

describe("stripEffectParamAnimations", () => {
	it("removes only the overwritten params", () => {
		const out = stripEffectParamAnimations({
			animations: {
				"effects.A.params.exposure": { keys: [] },
				"effects.A.params.contrast": { keys: [] },
				"transform.scaleX": { keys: [] },
			} as never,
			effectId: "A",
			paramKeys: ["exposure"],
		});
		expect(Object.keys(out ?? {})).toEqual([
			"effects.A.params.contrast",
			"transform.scaleX",
		]);
	});

	it("returns null when there is nothing to strip", () => {
		expect(
			stripEffectParamAnimations({
				animations: { "transform.scaleX": { keys: [] } } as never,
				effectId: "A",
				paramKeys: ["exposure"],
			}),
		).toBeNull();
		expect(
			stripEffectParamAnimations({
				animations: undefined,
				effectId: "A",
				paramKeys: ["exposure"],
			}),
		).toBeNull();
	});
});

describe("collectClipTargets", () => {
	it("keeps visual clips, drops audio", () => {
		const tracks = {
			main: { id: "main", type: "video", elements: [video({ id: "v1" })], muted: false, hidden: false },
			overlay: [],
			audio: [
				{
					id: "a",
					type: "audio",
					elements: [{ id: "s1", type: "audio", name: "s" } as TimelineElement],
					muted: false,
				},
			],
		} as never;
		const targets = collectClipTargets({
			selected: [
				{ trackId: "main", elementId: "v1" },
				{ trackId: "a", elementId: "s1" },
			],
			tracks,
		});
		expect(targets.map((t) => t.element.id)).toEqual(["v1"]);
		expect(targets[0]!.trackId).toBe("main");
	});
});
