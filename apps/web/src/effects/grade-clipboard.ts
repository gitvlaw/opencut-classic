import { useSyncExternalStore } from "react";
import type { ElementAnimations } from "@/animation/types";
import type { ParamValues } from "@/params";
import type { TimelineElement, VisualElement } from "@/timeline";
import type { SceneTracks } from "@/timeline";
import { generateUUID } from "@/utils/id";

/** Effect types carried by grade copy/paste (color tools only). */
export const GRADE_EFFECT_TYPES = ["adjust", "wheels", "filter", "lut", "hsl", "curves"];

export interface GradeEffectPayload {
	type: string;
	params: ParamValues;
	sourceEffectId: string;
	/** Only `effects.<sourceEffectId>.params.*` entries (remapped on paste). */
	animations?: ElementAnimations;
}

export interface GradePayload {
	effects: GradeEffectPayload[];
}

export interface ClipTarget {
	trackId: string;
	element: VisualElement;
}

function isVisualElementWithEffects(el: TimelineElement): el is VisualElement {
	return (
		el.type === "video" ||
		el.type === "image" ||
		el.type === "text" ||
		el.type === "sticker" ||
		el.type === "graphic"
	);
}

/** Collect clip targets (single or multi-select) that can hold color effects. */
export function collectClipTargets({
	selected,
	tracks,
}: {
	selected: ReadonlyArray<{ trackId: string; elementId: string }>;
	tracks: SceneTracks;
}): ClipTarget[] {
	const out: ClipTarget[] = [];
	const find = (elementId: string): TimelineElement | null => {
		if (tracks.main.elements.some((e) => e.id === elementId)) {
			return tracks.main.elements.find((e) => e.id === elementId) ?? null;
		}
		for (const track of tracks.overlay) {
			const found = track.elements.find((e) => e.id === elementId);
			if (found) return found;
		}
		for (const track of tracks.audio) {
			const found = track.elements.find((e) => e.id === elementId);
			if (found) return found;
		}
		return null;
	};
	for (const ref of selected) {
		const el = find(ref.elementId);
		if (el && isVisualElementWithEffects(el)) {
			out.push({ trackId: ref.trackId, element: el });
		}
	}
	return out;
}

/** Snapshot the grade (color effects + their keyframes) of one clip. */
export function copyGradeFromElement(element: VisualElement): GradePayload | null {
	const effects = (element.effects ?? []).filter((e) =>
		GRADE_EFFECT_TYPES.includes(e.type),
	);
	if (effects.length === 0) return null;
	return {
		effects: effects.map((e) => ({
			type: e.type,
			params: { ...e.params },
			sourceEffectId: e.id,
			animations: filterEffectAnimations({
				animations: element.animations,
				effectId: e.id,
			}),
		})),
	};
}

function filterEffectAnimations({
	animations,
	effectId,
}: {
	animations: ElementAnimations | undefined;
	effectId: string;
}): ElementAnimations | undefined {
	if (!animations) return undefined;
	const prefix = `effects.${effectId}.params.`;
	const out: ElementAnimations = {};
	let found = false;
	for (const [key, value] of Object.entries(animations)) {
		if (key.startsWith(prefix)) {
			out[key] = value;
			found = true;
		}
	}
	return found ? out : undefined;
}

/** Rewrite `effects.<oldId>.params.*` keys to a new effect id. */
export function remapEffectAnimations({
	animations,
	oldEffectId,
	newEffectId,
}: {
	animations: ElementAnimations | undefined;
	oldEffectId: string;
	newEffectId: string;
}): ElementAnimations | undefined {
	if (!animations) return undefined;
	const from = `effects.${oldEffectId}.params.`;
	const to = `effects.${newEffectId}.params.`;
	const out: ElementAnimations = {};
	for (const [key, value] of Object.entries(animations)) {
		out[key.startsWith(from) ? to + key.slice(from.length) : key] = value;
	}
	return out;
}

export interface PasteUpdate {
	trackId: string;
	elementId: string;
	updates: Partial<TimelineElement>;
}

/**
 * Build one preview/commit update per target clip. Same-type effects are
 * overwritten in place (stable id); missing ones are appended with fresh
 * ids and remapped keyframes. Pure — no editor access.
 */
export function buildPasteUpdates({
	targets,
	payload,
}: {
	targets: ClipTarget[];
	payload: GradePayload;
}): PasteUpdate[] {
	return targets.map(({ trackId, element }) => {
		const current = element.effects ?? [];
		const next = [...current];
		let animations: ElementAnimations | undefined = element.animations
			? { ...element.animations }
			: undefined;

		for (const src of payload.effects) {
			const idx = next.findIndex((e) => e.type === src.type);
			if (idx >= 0) {
				const existing = next[idx]!;
				next[idx] = { ...existing, params: { ...src.params } };
				animations = replaceEffectAnimations({
					animations,
					effectId: existing.id,
					replacement: remapEffectAnimations({
						animations: src.animations,
						oldEffectId: src.sourceEffectId,
						newEffectId: existing.id,
					}),
				});
			} else {
				const id = generateUUID();
				next.push({ id, type: src.type, params: { ...src.params }, enabled: true });
				animations = replaceEffectAnimations({
					animations,
					effectId: id,
					replacement: remapEffectAnimations({
						animations: src.animations,
						oldEffectId: src.sourceEffectId,
						newEffectId: id,
					}),
				});
			}
		}

		return {
			trackId,
			elementId: element.id,
			updates: { effects: next, ...(animations ? { animations } : {}) } as Partial<TimelineElement>,
		};
	});
}

/**
 * Merge replacement keyframes for one effect id: drop old paths, add new.
 * `replacement` uses final ids already.
 */
function replaceEffectAnimations({
	animations,
	effectId,
	replacement,
}: {
	animations: ElementAnimations | undefined;
	effectId: string;
	replacement: ElementAnimations | undefined;
}): ElementAnimations | undefined {
	const prefix = `effects.${effectId}.params.`;
 const base: ElementAnimations = {};
	if (animations) {
		for (const [key, value] of Object.entries(animations)) {
			if (!key.startsWith(prefix)) base[key] = value;
		}
	}
	if (replacement) {
		for (const [key, value] of Object.entries(replacement)) base[key] = value;
	}
	return Object.keys(base).length > 0 ? base : undefined;
}

// ---------------------------------------------------------------------------
// Session clipboard (in-memory singleton)
// ---------------------------------------------------------------------------

let clipboard: GradePayload | null = null;
let clipboardLabel = "";
const listeners = new Set<() => void>();

function notify(): void {
	for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

function getSnapshot(): GradePayload | null {
	return clipboard;
}

export function setGradeClipboard(payload: GradePayload | null, label = ""): void {
	clipboard = payload;
	clipboardLabel = label;
	notify();
}

export function getGradeClipboardLabel(): string {
	return clipboardLabel;
}

/** React binding for the clipboard (re-renders on copy/clear). */
export function useGradeClipboard(): GradePayload | null {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
