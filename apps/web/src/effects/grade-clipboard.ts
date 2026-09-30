import { useSyncExternalStore } from "react";
import type {
	AnimationChannel,
	ChannelData,
	CompositeChannelData,
	ElementAnimations,
} from "@/animation/types";
import type { MediaTime } from "@/wasm";
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
 * A composite channel nests per-property channels; a scalar one carries
 * `keys` directly. Distinguish by shape, not by assertion.
 */
function isCompositeChannel(
	channel: ChannelData | undefined,
): channel is CompositeChannelData {
	return channel !== undefined && !isScalarChannel(channel);
}

/** A scalar/discrete channel carries `keys`; anything else nests sub-channels. */
function isScalarChannel(
	channel: ChannelData,
): channel is Exclude<ChannelData, CompositeChannelData> {
	return "keys" in channel;
}

/**
 * Past-the-end keyframes are the real failure mode: source keyframe times
 * are relative to the source clip, so a shorter target keeps keys beyond
 * its own duration and renders as a flat hold.
 */
function clampTime({
	time,
	duration,
}: {
	time: MediaTime;
	duration: MediaTime;
}): MediaTime {
	return time > duration ? duration : time;
}

/**
 * Clamp pasted keyframes into the target clip. Keyframe times are relative
 * to the source clip, so a shorter target would otherwise keep keys past
 * its own duration (rendering as a flat hold and committing broken data).
 * Same clamp the paste-keyframes path uses.
 */
function clampKeyframeTimes({
	animations,
	duration,
}: {
	animations: ElementAnimations | undefined;
	duration: MediaTime;
}): ElementAnimations | undefined {
	if (!animations || duration <= 0) return animations;
	const out: ElementAnimations = {};
	for (const [path, channel] of Object.entries(animations)) {
		// A scalar channel carries `keys`; a composite one nests per-property
		// channels, so handle both shapes instead of assuming the flat one.
		if (isCompositeChannel(channel)) {
			let changed = false;
			const nested: CompositeChannelData = {};
			for (const [sub, subChannel] of Object.entries(channel)) {
				nested[sub] = clampKeys({ channel: subChannel, duration });
				if (nested[sub] !== subChannel) changed = true;
			}
			out[path] = changed ? { ...channel, ...nested } : channel;
			continue;
		}
		out[path] = clampKeys({ channel, duration });
	}
	return out;
}

/** Clamp one scalar/discrete channel's keyframe times into [0, duration]. */
function clampKeys<TChannel extends AnimationChannel | undefined>({
	channel,
	duration,
}: {
	channel: TChannel;
	duration: MediaTime;
}): TChannel {
	if (!channel || !("keys" in channel) || channel.keys.length === 0) {
		return channel;
	}
	const keys: { id: string; time: MediaTime }[] = channel.keys;
	const seen = new Set<MediaTime>();
	const clamped: { id: string; time: MediaTime }[] = [];
	let changed = false;
	for (const key of keys) {
		const time = clampTime({ time: key.time, duration });
		if (seen.has(time)) {
			changed = true;
			continue;
		}
		seen.add(time);
		if (time !== key.time) changed = true;
		clamped.push(time === key.time ? key : { ...key, time });
	}
	if (!changed) return channel;
	// Same channel kind and key fields; only the times differ.
	return { ...channel, keys: clamped };
}

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
		const hadAnimations = element.animations !== undefined;
		let animations: ElementAnimations | undefined = element.animations
			? { ...element.animations }
			: undefined;
		const updates: PasteUpdate["updates"] = { effects: next };

		for (const src of payload.effects) {
			// Overwrite the first effect of this type; drop any further
			// same-type duplicates. A leftover duplicate would keep its old
			// params and re-grade on top of the pasted grade.
			const firstIdx = next.findIndex((e) => e.type === src.type);
			const dupIdx = next.findIndex((e, i) => i !== firstIdx && e.type === src.type);
			if (firstIdx >= 0) {
				const existing = next[firstIdx]!;
				next[firstIdx] = { ...existing, params: { ...src.params } };
				animations = replaceEffectAnimations({
					animations,
					effectId: existing.id,
					replacement: remapEffectAnimations({
						animations: clampKeyframeTimes({
							animations: src.animations,
							duration: element.duration,
							}),
						oldEffectId: src.sourceEffectId,
						newEffectId: existing.id,
					}),
				});
				if (dupIdx >= 0) {
					const [removed] = next.splice(dupIdx, 1);
					if (removed) animations = dropEffectAnimations({ animations, effectId: removed.id });
				}
			} else {
				const id = generateUUID();
				next.push({ id, type: src.type, params: { ...src.params }, enabled: true });
				animations = replaceEffectAnimations({
					animations,
					effectId: id,
					replacement: remapEffectAnimations({
						// Pasted keyframe times are relative to the source
						// clip — clamp so they land inside this clip.
						animations: clampKeyframeTimes({
							animations: src.animations,
							duration: element.duration,
							}),
						oldEffectId: src.sourceEffectId,
						newEffectId: id,
					}),
				});
			}
		}

		// Always carry the key when the clip had any: omitting it leaves
		// stale channels that override the pasted params.
		if (hadAnimations || animations) {
			updates.animations = animations ?? {};
		}

		return {
			trackId,
			elementId: element.id,
			updates,
		};
	});
}

/** Drop every keyframe channel belonging to one effect id. */
export function dropEffectAnimations({
	animations,
	effectId,
}: {
	animations: ElementAnimations | undefined;
	effectId: string;
}): ElementAnimations | undefined {
	if (!animations) return undefined;
	const prefix = `effects.${effectId}.params.`;
	const base: ElementAnimations = {};
	for (const [key, value] of Object.entries(animations)) {
		if (!key.startsWith(prefix)) base[key] = value;
	}
	return Object.keys(base).length > 0 ? base : undefined;
}

/**
 * Drop the keyframe channels of the params a preset/grade is about to
 * overwrite. The renderer resolves a keyframed param from its channel, so
 * a stale channel makes the whole apply a visual no-op.
 *
 * Returns `null` when there is nothing to strip (caller should then leave
 * the element's animations untouched).
 */
export function stripEffectParamAnimations({
	animations,
	effectId,
	paramKeys,
}: {
	animations: ElementAnimations | undefined;
	effectId: string;
	paramKeys: readonly string[];
}): ElementAnimations | null {
	if (!animations || paramKeys.length === 0) return null;
	const params = new Set(paramKeys);
	let stripped = false;
	const base: ElementAnimations = {};
	for (const [key, value] of Object.entries(animations)) {
		const prefix = `effects.${effectId}.params.`;
		if (key.startsWith(prefix) && params.has(key.slice(prefix.length))) {
			stripped = true;
			continue;
		}
		base[key] = value;
	}
	return stripped ? base : null;
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
