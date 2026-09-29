import { nanoid } from "nanoid";
import { EditorCore } from "@/core";
import {
	findTrackInSceneTracks,
	updateTrackInSceneTracks,
	type VideoTrack,
	type TrackTransition,
	type VideoElement,
	type ImageElement,
} from "@/timeline";
import { TICKS_PER_SECOND, mediaTime, type MediaTime } from "@/wasm";
import { useTransitionsStore } from "./store";

export function getActiveTrackTransition({
	trackId,
	transitionId,
}: {
	trackId: string;
	transitionId: string;
}): TrackTransition | null {
	const editor = EditorCore.getInstance();
	const activeScene = editor.scenes.getActiveScene();
	const track = findTrackInSceneTracks({
		tracks: activeScene.tracks,
		trackId,
	});
	if (!track || track.type !== "video") return null;
	const videoTrack = track as VideoTrack;
	return (
		videoTrack.transitions?.find((t) => t.id === transitionId) ?? null
	);
}

export function addOrUpdateTransition({
	trackId,
	fromElementId,
	toElementId,
	type,
	duration,
	alignment = "center",
	direction,
	easing = "ease-in-out",
	params,
}: {
	trackId: string;
	fromElementId: string;
	toElementId: string;
	type: string;
	duration?: MediaTime; // in ticks or undefined
	alignment?: "center" | "start" | "end";
	direction?: "left" | "right" | "up" | "down";
	easing?: string;
	params?: Record<string, any>;
}): string {
	const editor = EditorCore.getInstance();
	const activeScene = editor.scenes.getActiveScene();
	const track = findTrackInSceneTracks({
		tracks: activeScene.tracks,
		trackId,
	});
	if (!track || track.type !== "video") return "";

	const videoTrack = track as VideoTrack;
	const existing = videoTrack.transitions?.find(
		(t) => t.fromElementId === fromElementId && t.toElementId === toElementId,
	);

	const defaultDurationTicks = mediaTime({ ticks: Math.round(0.5 * TICKS_PER_SECOND) });
	const targetDuration = duration ?? existing?.duration ?? defaultDurationTicks;
	const transitionId = existing?.id ?? nanoid();

	const newTransition: TrackTransition = {
		id: transitionId,
		type,
		fromElementId,
		toElementId,
		duration: targetDuration,
		alignment: alignment ?? existing?.alignment ?? "center",
		direction: direction ?? existing?.direction,
		easing: easing ?? existing?.easing ?? "ease-in-out",
		params: params ?? existing?.params ?? {},
	};

	const currentTransitions = videoTrack.transitions ?? [];
	const updatedTransitions = existing
		? currentTransitions.map((t) => (t.id === existing.id ? newTransition : t))
		: [...currentTransitions, newTransition];

	const updatedTracks = updateTrackInSceneTracks({
		tracks: activeScene.tracks,
		trackId,
		update: (tr) => ({
			...tr,
			transitions: updatedTransitions,
		}),
	});

	editor.timeline.updateTracks(updatedTracks);
	useTransitionsStore.getState().setSelectedTransition({
		trackId,
		transitionId,
	});

	return transitionId;
}

export function updateTransitionConfig({
	trackId,
	transitionId,
	updates,
}: {
	trackId: string;
	transitionId: string;
	updates: Partial<TrackTransition>;
}) {
	const editor = EditorCore.getInstance();
	const activeScene = editor.scenes.getActiveScene();
	const track = findTrackInSceneTracks({
		tracks: activeScene.tracks,
		trackId,
	});
	if (!track || track.type !== "video") return;

	const videoTrack = track as VideoTrack;
	const updatedTransitions = (videoTrack.transitions ?? []).map((t) => {
		if (t.id === transitionId) {
			return { ...t, ...updates };
		}
		return t;
	});

	const updatedTracks = updateTrackInSceneTracks({
		tracks: activeScene.tracks,
		trackId,
		update: (tr) => ({
			...tr,
			transitions: updatedTransitions,
		}),
	});

	editor.timeline.updateTracks(updatedTracks);
}

export function removeTransition({
	trackId,
	transitionId,
}: {
	trackId: string;
	transitionId: string;
}) {
	const editor = EditorCore.getInstance();
	const activeScene = editor.scenes.getActiveScene();
	const track = findTrackInSceneTracks({
		tracks: activeScene.tracks,
		trackId,
	});
	if (!track || track.type !== "video") return;

	const videoTrack = track as VideoTrack;
	const updatedTransitions = (videoTrack.transitions ?? []).filter(
		(t) => t.id !== transitionId,
	);

	const updatedTracks = updateTrackInSceneTracks({
		tracks: activeScene.tracks,
		trackId,
		update: (tr) => ({
			...tr,
			transitions: updatedTransitions,
		}),
	});

	editor.timeline.updateTracks(updatedTracks);
	const sel = useTransitionsStore.getState().selectedTransition;
	if (sel?.transitionId === transitionId) {
		useTransitionsStore.getState().setSelectedTransition(null);
	}
}

export function applyTransitionToAllCuts({
	type,
	duration,
}: {
	type: string;
	duration?: MediaTime;
}): number {
	const editor = EditorCore.getInstance();
	const activeScene = editor.scenes.getActiveScene();
	let appliedCount = 0;

	const defaultDurationTicks = mediaTime({ ticks: Math.round(0.5 * TICKS_PER_SECOND) });
	const targetDuration = duration ?? defaultDurationTicks;
	let currentTracks = activeScene.tracks;

	const allVideoTracks: VideoTrack[] = [
		activeScene.tracks.main,
		...activeScene.tracks.overlay.filter((t): t is VideoTrack => t.type === "video"),
	];

	for (const videoTrack of allVideoTracks) {
		const elements = videoTrack.elements.slice().sort((a, b) => a.startTime - b.startTime);
		if (elements.length < 2) continue;

		const newTransitions: TrackTransition[] = [...(videoTrack.transitions ?? [])];

		for (let i = 0; i < elements.length - 1; i++) {
			const elA = elements[i];
			const elB = elements[i + 1];
			const cutDiff = Math.abs(elA.startTime + elA.duration - elB.startTime);

			// Within 3 frames tolerance (consider adjacent)
			if (cutDiff <= Math.round((TICKS_PER_SECOND / 30) * 3)) {
				const existingIndex = newTransitions.findIndex(
					(t) => t.fromElementId === elA.id && t.toElementId === elB.id,
				);
				const transitionItem: TrackTransition = {
					id: existingIndex >= 0 ? newTransitions[existingIndex].id : nanoid(),
					type,
					fromElementId: elA.id,
					toElementId: elB.id,
					duration: targetDuration,
					alignment: "center",
					easing: "ease-in-out",
					params: {},
				};

				if (existingIndex >= 0) {
					newTransitions[existingIndex] = transitionItem;
				} else {
					newTransitions.push(transitionItem);
				}
				appliedCount++;
			}
		}

		currentTracks = updateTrackInSceneTracks({
			tracks: currentTracks,
			trackId: videoTrack.id,
			update: (tr) => ({
				...tr,
				transitions: newTransitions,
			}),
		});
	}

	if (appliedCount > 0) {
		editor.timeline.updateTracks(currentTracks);
	}

	return appliedCount;
}
