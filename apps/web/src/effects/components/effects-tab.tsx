"use client";

import { useState } from "react";
import { buildEffectParamPath, resolveAnimationPathValueAtTime } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import type { ParamDefinition, ParamValues, ParamValue } from "@/params";
import type { Effect } from "@/effects/types";
import type { EffectElement, VisualElement, TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import { effectsRegistry } from "@/effects";
import { useEditor } from "@/editor/use-editor";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
	SectionFields,
} from "@/components/section";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Delete02Icon,
	ViewIcon,
	ViewOffSlashIcon,
	MagicWand05Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";
import { Separator } from "@/components/ui/separator";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { EffectHistogram } from "@/effects/components/scopes";
import { CurveEditor } from "@/effects/components/curve-editor";
import { LutPicker } from "@/effects/components/lut-panel";
import {
	CURVE_CHANNELS,
	curvePreset,
	encodeCurve,
	parseCurvePoints,
	type CurveChannel,
} from "@/effects/definitions/curves";
import type { LutEntry } from "@/lut/lut-registry";
import { WheelPad } from "@/effects/components/color-wheels";
import { FilterPanel } from "@/effects/components/filter-panel";
import { WHEEL_ZONES, WHEEL_ZONE_LABELS } from "@/effects/definitions/wheels";

export function StandaloneEffectTab({
	element,
	trackId,
}: {
	element: EffectElement;
	trackId: string;
}) {
	const { renderElement, previewUpdates, commit } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});

	const effect: Effect = {
		id: element.id,
		type: element.effectType,
		params: element.params,
		enabled: true,
	};

	const previewParam = (key: string) => (value: number | string | boolean) => {
		previewUpdates({
			params: { ...(renderElement as EffectElement).params, [key]: value },
		});
	};

	const previewEffectParams = (patch: ParamValues) => {
		previewUpdates({
			params: { ...(renderElement as EffectElement).params, ...patch },
		});
	};

	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});

	return (
		<div className="flex flex-col h-full">
			<div className="border-b px-3.5 h-11 shrink-0 flex items-center">
				<SectionTitle>Effect</SectionTitle>
			</div>
			<EffectSection
				effect={effect}
				trackId={trackId}
				elementId={element.id}
				animations={(renderElement as EffectElement).animations}
				localTime={localTime}
				isPlayheadWithinElementRange={isPlayheadWithinElementRange}
				renderParams={(renderElement as EffectElement).params}
				previewParam={previewParam}
				previewEffectParams={previewEffectParams}
				patchEffectParam={(_effectId, key, value) => ({
					params: { ...(renderElement as EffectElement).params, [key]: value },
				})}
				onCommit={commit}
			/>
		</div>
	);
}

export function ClipEffectsTab({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	const [dragIndex, setDragIndex] = useState<number | null>(null);
	const [dropIndex, setDropIndex] = useState<number | null>(null);
	const editor = useEditor();
	const ed = useClipEffectEditing({ element, trackId });
	const {
		renderElement,
		effects,
		localTime,
		isPlayheadWithinElementRange,
		getRenderParams,
		buildPreviewParam,
		buildPreviewEffectParams,
		patchEffectParam,
		commit,
	} = ed;

	const handleDragStart = ({ index }: { index: number }) => setDragIndex(index);

	const handleDragOver = ({
		event,
		index,
	}: {
		event: React.DragEvent;
		index: number;
	}) => {
		event.preventDefault();
		if (index !== dropIndex) setDropIndex(index);
	};

	const handleDrop = ({ toIndex }: { toIndex: number }) => {
		if (dragIndex !== null && dragIndex !== toIndex) {
			editor.timeline.reorderClipEffects({
				trackId,
				elementId: element.id,
				fromIndex: dragIndex,
				toIndex,
			});
		}
		setDragIndex(null);
		setDropIndex(null);
	};

	const handleDragEnd = () => {
		setDragIndex(null);
		setDropIndex(null);
	};

	return (
		<div className="flex flex-col h-full">
			<div className="border-b px-3.5 h-11 shrink-0 flex items-center justify-between">
				<SectionTitle>Effects</SectionTitle>
				<QuickAddColor
					effects={effects}
					onAdd={(effectType) =>
						editor.timeline.addClipEffect({
							trackId,
							elementId: element.id,
							effectType,
						})
					}
				/>
			</div>
			{effects.length === 0 ? (
				<EmptyView
					elementId={element.id}
					trackId={trackId}
				/>
			) : (
				<ul className="flex flex-col">
					{effects.map((effect, index) => {
						const resolvedDragIndex = dragIndex ?? -1;
						const isDragging = dragIndex === index;
						const isDropTarget =
							dropIndex === index && dragIndex !== null && dragIndex !== index;
						const showTopDropIndicator =
							isDropTarget && index < resolvedDragIndex;
						const showBottomDropIndicator =
							isDropTarget && index > resolvedDragIndex;

						return (
							<li
								key={effect.id}
								draggable
								onDragStart={() => handleDragStart({ index })}
								onDragOver={(event) => handleDragOver({ event, index })}
								onDrop={() => handleDrop({ toIndex: index })}
								onDragEnd={handleDragEnd}
								className={cn(
									"group list-none",
									isDragging && "opacity-40",
									showTopDropIndicator && "border-t-2 border-primary",
									showBottomDropIndicator && "border-b-2 border-primary",
								)}
							>
								<EffectSection
									effect={effect}
									trackId={trackId}
									elementId={element.id}
									animations={(renderElement as VisualElement).animations}
									localTime={localTime}
									isPlayheadWithinElementRange={isPlayheadWithinElementRange}
									renderParams={getRenderParams({ effectId: effect.id })}
									previewParam={buildPreviewParam(effect.id)}
									previewEffectParams={buildPreviewEffectParams(effect.id)}
									patchEffectParam={patchEffectParam}
									onCommit={commit}
									onToggle={() =>
										editor.timeline.toggleClipEffect({
											trackId,
											elementId: element.id,
											effectId: effect.id,
										})
									}
									onRemove={() =>
										editor.timeline.removeClipEffect({
											trackId,
											elementId: element.id,
											effectId: effect.id,
										})
									}
								/>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

const COLOR_QUICK_ADD: Array<{ type: string; label: string }> = [
	{ type: "adjust", label: "Adjust" },
	{ type: "wheels", label: "Wheels" },
	{ type: "filter", label: "Filter" },
	{ type: "lut", label: "LUT" },
	{ type: "hsl", label: "HSL" },
	{ type: "curves", label: "Curves" },
];

/** Shared clip-effect editing state (preview, playhead, param writers). */
function useClipEffectEditing({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	const { renderElement, previewUpdates, commit } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});

	const effects: Effect[] = element.effects ?? [];
	const renderEffects: Effect[] =
		(renderElement as VisualElement).effects ?? effects;

	const getRenderParams = ({ effectId }: { effectId: string }): ParamValues => {
		return (
			(renderElement as VisualElement).effects?.find((ef) => ef.id === effectId)
				?.params ??
			effects.find((ef) => ef.id === effectId)?.params ??
			{}
		);
	};

	const buildPreviewEffectParams =
		(effectId: string) => (patch: ParamValues) => {
			const updatedEffects = renderEffects.map((existing) =>
				existing.id !== effectId
					? existing
					: { ...existing, params: { ...existing.params, ...patch } },
			);
			previewUpdates({ effects: updatedEffects });
		};

	const buildPreviewParam =
		(effectId: string) =>
		(key: string) =>
		(value: number | string | boolean) => {
			buildPreviewEffectParams(effectId)({ [key]: value });
		};

	const patchEffectParam = (
		effectId: string,
		key: string,
		value: ParamValue,
	): Partial<TimelineElement> => ({
		effects: renderEffects.map((existing) =>
			existing.id !== effectId
				? existing
				: { ...existing, params: { ...existing.params, [key]: value } },
		),
	});

	return {
		renderElement,
		effects,
		renderEffects,
		localTime,
		isPlayheadWithinElementRange,
		getRenderParams,
		buildPreviewParam,
		buildPreviewEffectParams,
		patchEffectParam,
		commit,
	};
}

/**
 * Dedicated Adjustment tab (CapCut-style color home): the Adjust effect
 * with histogram, plus quick-add and panels for the other color tools.
 * Non-color effects (blur, …) stay in the Effects tab.
 */
export function AdjustmentTab({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	const editor = useEditor();
	const ed = useClipEffectEditing({ element, trackId });
	const {
		renderElement,
		effects,
		localTime,
		isPlayheadWithinElementRange,
		getRenderParams,
		buildPreviewParam,
		buildPreviewEffectParams,
		patchEffectParam,
		commit,
	} = ed;

	const addEffect = (effectType: string) =>
		editor.timeline.addClipEffect({ trackId, elementId: element.id, effectType });

	const adjust = effects.find((e) => e.type === "adjust");
	const colorOthers = effects.filter(
		(e) => e.type !== "adjust" && COLOR_EFFECT_TYPES.includes(e.type),
	);
	const missing = COLOR_QUICK_ADD.filter(
		(c) => c.type !== "adjust" && !effects.some((e) => e.type === c.type),
	);

	const sectionProps = (effect: Effect) => ({
		effect,
		trackId,
		elementId: element.id,
		animations: (renderElement as VisualElement).animations,
		localTime,
		isPlayheadWithinElementRange,
		renderParams: getRenderParams({ effectId: effect.id }),
		previewParam: buildPreviewParam(effect.id),
		previewEffectParams: buildPreviewEffectParams(effect.id),
		patchEffectParam,
		onCommit: commit,
		onToggle: () =>
			editor.timeline.toggleClipEffect({ trackId, elementId: element.id, effectId: effect.id }),
		onRemove: () =>
			editor.timeline.removeClipEffect({ trackId, elementId: element.id, effectId: effect.id }),
	});

	return (
		<div className="flex flex-col h-full">
			<div className="border-b px-3.5 h-11 shrink-0 flex items-center">
				<SectionTitle>Adjustment</SectionTitle>
			</div>
			{!adjust ? (
				<div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
					<p className="text-sm text-muted-foreground text-balance">
						Exposure, contrast, white balance and more — non-destructive, keyframable.
					</p>
					<Button variant="default" size="sm" onClick={() => addEffect("adjust")}>
						Enable Adjustment
					</Button>
				</div>
			) : (
				<EffectSection {...sectionProps(adjust)} />
			)}
			{missing.length > 0 && (
				<div className="flex flex-col gap-2 px-4 py-3">
					<span className="text-xs font-medium text-muted-foreground">Color tools</span>
					<div className="flex flex-wrap gap-1.5">
						{missing.map((c) => (
							<Button key={c.type} variant="outline" size="sm" onClick={() => addEffect(c.type)}>
								+ {c.label}
							</Button>
						))}
					</div>
				</div>
			)}
			{colorOthers.map((effect) => (
				<EffectSection key={effect.id} {...sectionProps(effect)} />
			))}
		</div>
	);
}

/** Effect types shown in the Adjustment tab (color tools only). */
export const COLOR_EFFECT_TYPES = ["adjust", "wheels", "filter", "lut", "hsl", "curves"];

function QuickAddColor({
	effects,
	onAdd,
}: {
	effects: Effect[];
	onAdd: (effectType: string) => void;
}) {
	const existing = new Set(effects.map((e) => e.type));
	const missing = COLOR_QUICK_ADD.filter((c) => !existing.has(c.type));
	if (missing.length === 0) return null;
	return (
		<div className="flex items-center gap-1">
			{missing.map((c) => (
				<Button
					key={c.type}
					variant="ghost"
					size="sm"
					className="h-7 px-2 text-xs"
					onClick={() => onAdd(c.type)}
				>
					+ {c.label}
				</Button>
			))}
		</div>
	);
}

function EmptyView({ elementId, trackId }: { elementId: string; trackId: string }) {
	const setActiveTab = useAssetsPanelStore((s) => s.setActiveTab);
	const editor = useEditor();

	return (
		<div className="flex flex-col h-full items-center justify-center gap-4 text-center">
			<HugeiconsIcon
				icon={MagicWand05Icon}
				className="size-10 text-muted-foreground"
				strokeWidth={1}
			/>
			<div className="flex flex-col gap-2">
				<h3 className="font-medium text-foreground">No effects</h3>
				<p className="text-muted-foreground text-sm text-balance max-w-44">
					Add effects to this layer from the Assets panel.
				</p>
			</div>
			<div className="flex flex-wrap items-center justify-center gap-1.5 px-4">
				{COLOR_QUICK_ADD.map((c) => (
					<Button
						key={c.type}
						variant="outline"
						size="sm"
						onClick={() =>
							editor.timeline.addClipEffect({
								trackId,
								elementId,
								effectType: c.type,
							})
						}
					>
						+ {c.label}
					</Button>
				))}
			</div>
			<Button
				variant="default"
				size="sm"
				onClick={() => setActiveTab("effects")}
			>
				Open effects
			</Button>
		</div>
	);
}

function EffectSection({
	effect,
	trackId,
	elementId,
	animations,
	localTime,
	isPlayheadWithinElementRange,
	renderParams,
	previewParam,
	previewEffectParams,
	patchEffectParam,
	onCommit,
	onToggle,
	onRemove,
}: {
	effect: Effect;
	trackId: string;
	elementId: string;
	animations: ElementAnimations | undefined;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
	renderParams: ParamValues;
	previewParam: (key: string) => (value: number | string | boolean) => void;
	previewEffectParams: (patch: ParamValues) => void;
	patchEffectParam: (
		effectId: string,
		key: string,
		value: ParamValue,
	) => Partial<TimelineElement>;
	onCommit: () => void;
	onToggle?: () => void;
	onRemove?: () => void;
}) {
	if (!effectsRegistry.has(effect.type)) {
		return (
			<Section showTopBorder={false}>
				<SectionHeader>
					<SectionTitle className="text-muted-foreground">
						Unsupported effect ({effect.type})
					</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<p className="px-4 text-sm text-muted-foreground">
						This effect is not available in this version. You can safely remove it.
					</p>
					{onRemove && (
						<div className="px-4 pb-4">
							<Button variant="ghost" size="sm" onClick={onRemove}>
								Remove
							</Button>
						</div>
					)}
				</SectionContent>
			</Section>
		);
	}
	const definition = effectsRegistry.get(effect.type);

	return (
		<Section
			sectionKey={onToggle ? `clip-effect:${effect.id}` : undefined}
			showTopBorder={false}
		>
			<SectionHeader
				className={cn(onToggle && "cursor-move")}
				trailing={
					onToggle && (
						<div className="flex items-center gap-1">
							<Button
								variant={effect.enabled ? "secondary" : "ghost"}
								size="icon"
								aria-label={`Toggle ${definition.name}`}
								onClick={onToggle}
							>
								<HugeiconsIcon
									icon={effect.enabled ? ViewIcon : ViewOffSlashIcon}
								/>
							</Button>
							<Button
								variant="ghost"
								size="icon"
								aria-label={`Remove ${definition.name}`}
								onClick={onRemove}
							>
								<HugeiconsIcon icon={Delete02Icon} />
							</Button>
						</div>
					)
				}
			>
				<SectionTitle
					className={cn(onToggle && !effect.enabled && "text-muted-foreground")}
				>
					{definition.name}
				</SectionTitle>
			</SectionHeader>
			<SectionContent
				className={cn("p-0", onToggle && !effect.enabled && "opacity-50")}
			>
				{effect.type === "adjust" && (
					<div className="flex flex-col gap-3.5 pb-1 pt-3">
						<EffectHistogram effectType={effect.type} params={renderParams} />
						<Separator />
					</div>
				)}
				{effect.type === "curves" ? (
					<CurvesPanel
						renderParams={renderParams}
						previewEffectParams={previewEffectParams}
						onCommit={onCommit}
					/>
				) : effect.type === "lut" ? (
					<LutPanel
						effect={effect}
						trackId={trackId}
						elementId={elementId}
						animations={animations}
						localTime={localTime}
						isPlayheadWithinElementRange={isPlayheadWithinElementRange}
						renderParams={renderParams}
						previewEffectParams={previewEffectParams}
						patchEffectParam={patchEffectParam}
						onCommit={onCommit}
					/>
				) : effect.type === "wheels" ? (
					<WheelsPanel
						effect={effect}
						trackId={trackId}
						elementId={elementId}
						animations={animations}
						localTime={localTime}
						isPlayheadWithinElementRange={isPlayheadWithinElementRange}
						renderParams={renderParams}
						previewEffectParams={previewEffectParams}
						patchEffectParam={patchEffectParam}
						onCommit={onCommit}
					/>
				) : effect.type === "filter" ? (
					<FilterPanel
						effect={effect}
						trackId={trackId}
						elementId={elementId}
						animations={animations}
						localTime={localTime}
						isPlayheadWithinElementRange={isPlayheadWithinElementRange}
						renderParams={renderParams}
						previewEffectParams={previewEffectParams}
						patchEffectParam={patchEffectParam}
						onCommit={onCommit}
					/>
				) : (
					<SectionFields>
						{definition.params.map((param) => (
							<div key={param.key} className="flex flex-col gap-3.5">
								<div className="px-4">
									<EffectParamField
										effect={effect}
										trackId={trackId}
										elementId={elementId}
										animations={animations}
										localTime={localTime}
										isPlayheadWithinElementRange={isPlayheadWithinElementRange}
										param={param}
										baseValue={
											(renderParams[param.key] ?? param.default) as ParamValue
										}
										previewParam={previewParam}
										patchEffectParam={patchEffectParam}
										onCommit={onCommit}
									/>
								</div>
								<Separator />
							</div>
						))}
					</SectionFields>
				)}
			</SectionContent>
		</Section>
	);
}

/**
 * One effect param row with keyframe support. Number params route through
 * the animation channel (effects.<id>.params.<key>) when keyframed —
 * same behavior as element params in ElementParamsTab.
 */
function EffectParamField({
	effect,
	trackId,
	elementId,
	animations,
	localTime,
	isPlayheadWithinElementRange,
	param,
	baseValue,
	previewParam,
	patchEffectParam,
	onCommit,
}: {
	effect: Effect;
	trackId: string;
	elementId: string;
	animations: ElementAnimations | undefined;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
	param: ParamDefinition;
	baseValue: ParamValue;
	previewParam: (key: string) => (value: number | string | boolean) => void;
	patchEffectParam: (
		effectId: string,
		key: string,
		value: ParamValue,
	) => Partial<TimelineElement>;
	onCommit: () => void;
}) {
	const propertyPath = buildEffectParamPath({ effectId: effect.id, paramKey: param.key });
	const resolvedValue = resolveAnimationPathValueAtTime({
		animations,
		propertyPath,
		localTime,
		fallbackValue: baseValue,
	});
	const animated = useKeyframedParamProperty({
		param,
		trackId,
		elementId,
		animations,
		propertyPath,
		localTime,
		isPlayheadWithinElementRange,
		resolvedValue,
		buildBaseUpdates: ({ value }) => patchEffectParam(effect.id, param.key, value),
	});

	if (param.type !== "number" || param.keyframable === false) {
		return (
			<PropertyParamField
				param={param}
				value={resolvedValue}
				onPreview={previewParam(param.key)}
				onCommit={onCommit}
			/>
		);
	}

	return (
		<PropertyParamField
			param={param}
			value={resolvedValue}
			onPreview={animated.onPreview}
			onCommit={animated.onCommit}
			keyframe={{
				isActive: animated.isKeyframedAtTime,
				isDisabled: !isPlayheadWithinElementRange,
				onToggle: animated.toggleKeyframe,
			}}
		/>
	);
}

/** Curves effect: drag editor + preset select (preset writes channel JSON). */
function CurvesPanel({
	renderParams,
	previewEffectParams,
	onCommit,
}: {
	renderParams: ParamValues;
	previewEffectParams: (patch: ParamValues) => void;
	onCommit: () => void;
}) {
	const definition = effectsRegistry.get("curves");
	const presetParam = definition.params.find((p) => p.key === "preset")!;
	const channels = {
		master: parseCurvePoints(renderParams, "master"),
		red: parseCurvePoints(renderParams, "red"),
		green: parseCurvePoints(renderParams, "green"),
		blue: parseCurvePoints(renderParams, "blue"),
	} satisfies Record<CurveChannel, number[]>;

	return (
		<SectionFields>
			<div className="flex flex-col gap-3.5">
				<CurveEditor
					channels={channels}
					onPreview={(channel, points) =>
						previewEffectParams({
							[`curves.${channel}`]: encodeCurve(points),
							preset: "custom",
						})
					}
					onCommit={onCommit}
				/>
				<Separator />
			</div>
			<div className="flex flex-col gap-3.5">
				<div className="px-4">
					<PropertyParamField
						param={presetParam}
						value={renderParams.preset ?? "custom"}
						onPreview={(value) => {
							const name = String(value);
							if (name === "custom") {
								previewEffectParams({ preset: name });
								return;
							}
							const p = curvePreset(name);
							previewEffectParams({
								preset: name,
								"curves.master": encodeCurve(p.master),
								"curves.red": encodeCurve(p.red),
								"curves.green": encodeCurve(p.green),
								"curves.blue": encodeCurve(p.blue),
							});
						}}
						onCommit={onCommit}
					/>
				</div>
				<Separator />
			</div>
		</SectionFields>
	);
}

/** LUT effect: file import + session list + keyframable intensity. */
function LutPanel({
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
	const definition = effectsRegistry.get("lut");
	const intensityParam = definition.params.find((p) => p.key === "intensity")!;
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

	return (
		<SectionFields>
			<div className="flex flex-col gap-3.5">
				<LutPicker
					lutKey={String(renderParams.lutKey ?? "none")}
					onPick={(entry: LutEntry | null) => {
						previewEffectParams(
							entry
								? { lutKey: entry.key, lutName: entry.name }
								: { lutKey: "none", lutName: "None" },
						);
						onCommit();
					}}
				/>
				<Separator />
			</div>
			<div className="flex flex-col gap-3.5">
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
		</SectionFields>
	);
}

/**
 * Wheels effect: 3 hue-ring pads (hue+sat, direct write) + luminance
 * sliders with full keyframe support. Hue/sat pad drags write static
 * values; keyframe those via panel only through lum rows in v1.
 */
function WheelsPanel({
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
	const definition = effectsRegistry.get("wheels");
	const lumParams = definition.params.filter((p) => p.key.endsWith(".lum"));
	const num = (key: string, fallback: number): number => {
		const v = renderParams[key];
		const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? fallback));
		return Number.isFinite(n) ? n : fallback;
	};

	return (
		<SectionFields>
			<div className="flex flex-col gap-3.5">
				<div className="flex items-start justify-around px-4 pt-1">
					{WHEEL_ZONES.map((zone) => (
						<div key={zone} className="flex flex-col items-center gap-1.5">
							<WheelPad
								hue={num(`wheels.${zone}.hue`, 0)}
								sat={num(`wheels.${zone}.sat`, 0)}
								onPreview={(hue, sat) =>
									previewEffectParams({
										[`wheels.${zone}.hue`]: hue,
										[`wheels.${zone}.sat`]: sat,
									})
								}
								onCommit={onCommit}
							/>
							<span className="text-xs text-muted-foreground">
								{WHEEL_ZONE_LABELS[zone]}
							</span>
						</div>
					))}
				</div>
				<Separator />
			</div>
			{lumParams.map((param) => (
				<div key={param.key} className="flex flex-col gap-3.5">
					<div className="px-4">
						<EffectParamField
							effect={effect}
							trackId={trackId}
							elementId={elementId}
							animations={animations}
							localTime={localTime}
							isPlayheadWithinElementRange={isPlayheadWithinElementRange}
							param={param}
							baseValue={(renderParams[param.key] ?? param.default) as ParamValue}
							previewParam={(key) => (value) => previewEffectParams({ [key]: value })}
							patchEffectParam={patchEffectParam}
							onCommit={onCommit}
						/>
					</div>
					<Separator />
				</div>
			))}
		</SectionFields>
	);
}
