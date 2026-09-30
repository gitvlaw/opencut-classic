"use client";

import { useMemo } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { AdjustmentTab } from "@/effects/components/effects-tab";
import type { SceneTracks, TimelineElement, VisualElement } from "@/timeline";

function findElementInTracks({
	tracks,
	elementId,
}: {
	tracks: SceneTracks;
	elementId: string;
}): TimelineElement | null {
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
}

/**
 * Assets-panel Adjustment view. Operates on the currently selected
 * video/image clip; reuses the same AdjustmentTab as the Properties panel.
 */
export function AdjustmentAssetsView() {
	const selectedElements = useEditor((e) => e.selection.getSelectedElements());
	const tracks = useEditor((e) => e.scenes.getActiveScene().tracks);

	const target = useMemo(() => {
		if (selectedElements.length !== 1) return null;
		const ref = selectedElements[0]!;
		const el = findElementInTracks({ tracks, elementId: ref.elementId });
		if (el && (el.type === "video" || el.type === "image")) {
			return { element: el as VisualElement, trackId: ref.trackId };
		}
		return null;
	}, [selectedElements, tracks]);

	return (
		<PanelView title="Adjustment">
			{target ? (
				<AdjustmentTab element={target.element} trackId={target.trackId} />
			) : (
				<div className="text-muted-foreground p-4 text-sm text-balance">
					Select a video or image clip on the timeline to adjust its colors.
				</div>
			)}
		</PanelView>
	);
}
