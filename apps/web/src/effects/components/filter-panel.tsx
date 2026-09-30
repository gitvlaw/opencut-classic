"use client";

import { useEffect, useMemo, useRef } from "react";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/utils/ui";
import { buildEffectParamPath, resolveAnimationPathValueAtTime } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import type { ParamValues, ParamValue } from "@/params";
import type { Effect } from "@/effects/types";
import type { TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import { effectsRegistry } from "@/effects";
import { useEditor } from "@/editor/use-editor";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { FILTER_PRESETS, buildFilterSnapshot } from "@/effects/definitions/filter";
import { buildPasteUpdates, collectClipTargets } from "@/effects/grade-clipboard";

const THUMB_SIZE = 96;

function PresetThumb({
	presetId,
	presetName,
	active,
	onPick,
}: {
	presetId: string;
	presetName: string;
	active: boolean;
	onPick: () => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const render = () => {
			if (canvasRef.current) {
				effectPreviewService.renderPreview({
					effectType: "filter",
					params: { preset: presetId, intensity: 100 },
					targetCanvas: canvasRef.current,
				});
			}
		};
		render();
		return effectPreviewService.onPreviewImageReady({ callback: render });
	}, [presetId]);

	return (
		<button
			type="button"
			onClick={onPick}
			className={cn(
				"flex flex-col items-center gap-1 rounded p-1 hover:bg-accent",
				active && "bg-accent ring-1 ring-primary",
			)}
			title={presetName}
		>
			<canvas
				ref={canvasRef}
				width={THUMB_SIZE}
				height={THUMB_SIZE}
				className="size-16 rounded"
			/>
			<span className="max-w-16 truncate text-[11px] text-muted-foreground">
				{presetName}
			</span>
		</button>
	);
}

/** Filter effect: preset thumbnail gallery + keyframable intensity. */
export function FilterPanel({
	effect,
	trackId,
	elementId,
	animations,
	localTime,
	isPlayheadWithinElementRange,
	renderParams,
	previewEffectParams,
	patchEffectParam,
	onCommit,
}: {
	effect: Effect;
	trackId: string;
	elementId: string;
	animations: ElementAnimations | undefined;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
	renderParams: ParamValues;
	previewEffectParams: (patch: ParamValues) => void;
	patchEffectParam: (
		effectId: string,
		key: string,
		value: ParamValue,
	) => Partial<TimelineElement>;
	onCommit: () => void;
}) {
	const definition = effectsRegistry.get("filter");
	const intensityParam = definition.params.find((p) => p.key === "intensity")!;
	const activePreset = String(renderParams.preset ?? "none");
	const baseIntensity =
		typeof renderParams.intensity === "number" ? renderParams.intensity : 100;
	const propertyPath = buildEffectParamPath({ effectId: effect.id, paramKey: "intensity" });
	const resolvedIntensity = resolveAnimationPathValueAtTime({
		animations,
		propertyPath,
		localTime,
		fallbackValue: baseIntensity,
	});
	const animatedIntensity = useKeyframedParamProperty({
		param: intensityParam,
		trackId,
		elementId,
		animations,
		propertyPath,
		localTime,
		isPlayheadWithinElementRange,
		resolvedValue: resolvedIntensity,
		buildBaseUpdates: ({ value }) => patchEffectParam(effect.id, "intensity", value),
	});

	// Batch: gallery preset applies to every selected clip in one undo step.
	const editor = useEditor();
	const selected = useEditor((e) => e.selection.getSelectedElements());
	const tracks = useEditor((e) => e.scenes.getActiveScene().tracks);
	const targets = useMemo(
		() => collectClipTargets({ selected, tracks }),
		[selected, tracks],
	);
	const isBatch = targets.length > 1;

	const handlePickPreset = (presetId: string) => {
		const patch = { preset: presetId, snapshot: buildFilterSnapshot(presetId) };
		if (isBatch) {
			const updates = buildPasteUpdates({
				targets,
				payload: {
					effects: [{ type: "filter", params: patch, sourceEffectId: "" }],
				},
			});
			editor.timeline.previewElements({ updates });
			editor.timeline.commitPreview();
			return;
		}
		// Re-freeze the look: the snapshot versions the
		// preset against future library edits.
		previewEffectParams(patch);
		onCommit();
	};

	return (
		<div className="flex flex-col">
			{isBatch && (
				<p className="text-muted-foreground px-4 pt-2 text-xs">
					Preset applies to all {targets.length} selected clips.
				</p>
			)}
			<div className="grid grid-cols-4 gap-1 px-3 py-2">
				{FILTER_PRESETS.map((preset) => (
					<PresetThumb
						key={preset.id}
						presetId={preset.id}
						presetName={preset.name}
						active={activePreset === preset.id}
						onPick={() => handlePickPreset(preset.id)}
					/>
				))}
			</div>
			<Separator />
			<div className="flex flex-col gap-3.5 py-3">
				<div className="px-4">
					<PropertyParamField
						param={intensityParam}
						value={resolvedIntensity}
						onPreview={animatedIntensity.onPreview}
						onCommit={animatedIntensity.onCommit}
						keyframe={{
							isActive: animatedIntensity.isKeyframedAtTime,
							isDisabled: !isPlayheadWithinElementRange,
							onToggle: animatedIntensity.toggleKeyframe,
						}}
					/>
				</div>
				<Separator />
			</div>
		</div>
	);
}
