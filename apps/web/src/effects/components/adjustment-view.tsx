"use client";

import { useMemo } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { AdjustmentTab } from "@/effects/components/effects-tab";
import { collectClipTargets } from "@/effects/grade-clipboard";

/**
 * Assets-panel Adjustment view. Reuses the same AdjustmentTab as the
 * Properties panel: it edits the first selected clip and its batch actions
 * fan out to every selected clip, so multi-select works here too.
 */
export function AdjustmentAssetsView() {
	const selected = useEditor((e) => e.selection.getSelectedElements());
	const tracks = useEditor((e) => e.scenes.getActiveScene().tracks);

	const targets = useMemo(
		() => collectClipTargets({ selected, tracks }),
		[selected, tracks],
	);
	const first = targets[0];

	return (
		<PanelView title="Adjustment">
			{first ? (
				<AdjustmentTab element={first.element} trackId={first.trackId} />
			) : (
				<div className="text-muted-foreground p-4 text-sm text-balance">
					Select a video or image clip on the timeline to adjust its colors.
				</div>
			)}
		</PanelView>
	);
}
