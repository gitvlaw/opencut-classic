"use client";

import { useState } from "react";
import type { ParamValues } from "@/params";
import type { Effect } from "@/effects/types";
import type { EffectElement, VisualElement } from "@/timeline";
import { effectsRegistry } from "@/effects";
import { useEditor } from "@/editor/use-editor";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
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

	return (
		<div className="flex flex-col h-full">
			<div className="border-b px-3.5 h-11 shrink-0 flex items-center">
				<SectionTitle>Effect</SectionTitle>
			</div>
			<EffectSection
				effect={effect}
				renderParams={(renderElement as EffectElement).params}
				previewParam={previewParam}
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
	const { renderElement, previewUpdates, commit } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});

	const effects: Effect[] = element.effects ?? [];

	const getRenderParams = ({ effectId }: { effectId: string }): ParamValues => {
		return (
			(renderElement as VisualElement).effects?.find((ef) => ef.id === effectId)
				?.params ??
			effects.find((ef) => ef.id === effectId)?.params ??
			{}
		);
	};

	const buildPreviewParam =
		(effectId: string) =>
		(key: string) =>
		(value: number | string | boolean) => {
			const updatedEffects = (
				(renderElement as VisualElement).effects ?? []
			).map((existing) =>
				existing.id !== effectId
					? existing
					: { ...existing, params: { ...existing.params, [key]: value } },
			);
			previewUpdates({ effects: updatedEffects });
		};

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
									renderParams={getRenderParams({ effectId: effect.id })}
									previewParam={buildPreviewParam(effect.id)}
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
	{ type: "filter", label: "Filter" },
	{ type: "hsl", label: "HSL" },
	{ type: "curves", label: "Curves" },
];

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
	renderParams,
	previewParam,
	onCommit,
	onToggle,
	onRemove,
}: {
	effect: Effect;
	renderParams: ParamValues;
	previewParam: (key: string) => (value: number | string | boolean) => void;
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
				<SectionFields>
					{definition.params.map((param) => (
						<div key={param.key} className="flex flex-col gap-3.5">
							<div className="px-4">
								<PropertyParamField
									param={param}
									value={renderParams[param.key] ?? param.default}
									onPreview={previewParam(param.key)}
									onCommit={onCommit}
								/>
							</div>
							<Separator />
						</div>
					))}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
