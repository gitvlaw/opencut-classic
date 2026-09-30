import { describe, expect, it } from "bun:test";
import {
	buildPasteUpdates,
	collectClipTargets,
	copyGradeFromElement,
	remapEffectAnimations,
	type ClipTarget,
	type GradePayload,
} from "../grade-clipboard";
import type { TimelineElement, VisualElement } from "@/timeline";

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
