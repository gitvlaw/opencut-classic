"use client";

import { resolveAnimationPathValueAtTime } from "@/animation";
import { Section, SectionContent, SectionFields } from "@/components/section";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import type { ParamValue, ParamValues } from "@/params";
import {
	getElementParams,
	readElementParamValue,
	writeElementParamValue,
	type ElementParamDefinition,
} from "@/params/registry";
import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { SparklesIcon } from "@hugeicons/core-free-icons";
import { VocalSeparationDialog } from "@/components/editor/vocal-separation-dialog";
import type { TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";

export function ElementParamsTab({
	element,
	trackId,
	elementsWithTracks,
	paramKeys,
	sectionKey,
}: {
	element: TimelineElement;
	trackId: string;
	elementsWithTracks?: Array<{ element: TimelineElement; track: { id: string } }>;
	paramKeys?: readonly string[];
	sectionKey: string;
}) {
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const isMultiSelect = (elementsWithTracks?.length ?? 0) > 1;
	const params = getElementParams({ element })
		.filter((param) => !paramKeys || paramKeys.includes(param.key))
		.filter((param) => !isMultiSelect || param.key !== "content");
	const [isVocalSeparationOpen, setIsVocalSeparationOpen] = useState(false);
	const baseValues = buildValues({ element, params });

	return (
		<Section sectionKey={`${element.id}:${sectionKey}`}>
			<SectionContent className="pt-4">
				<SectionFields>
					{params
						.filter((param) => isVisible({ param, values: baseValues }))
						.map((param) => (
							<ElementParamField
								key={param.key}
								element={element}
								trackId={trackId}
								elementsWithTracks={elementsWithTracks}
								param={param}
								baseValue={baseValues[param.key] ?? param.default}
								localTime={localTime}
								isPlayheadWithinElementRange={isPlayheadWithinElementRange}
							/>
						))}
					{sectionKey === "audio" && !isMultiSelect && (
						<div className="pt-2">
							<Button
								variant="outline"
								size="sm"
								className="w-full gap-2 text-xs"
								onClick={() => setIsVocalSeparationOpen(true)}
							>
								<HugeiconsIcon icon={SparklesIcon} className="size-4 text-primary" />
								Tách lời khỏi nhạc...
							</Button>
							{isVocalSeparationOpen && (
								<VocalSeparationDialog
									isOpen={isVocalSeparationOpen}
									onOpenChange={setIsVocalSeparationOpen}
									trackId={trackId}
									element={element}
								/>
							)}
						</div>
					)}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function ElementParamField({
	element,
	trackId,
	elementsWithTracks,
	param,
	baseValue,
	localTime,
	isPlayheadWithinElementRange,
}: {
	element: TimelineElement;
	trackId: string;
	elementsWithTracks?: Array<{ element: TimelineElement; track: { id: string } }>;
	param: ElementParamDefinition;
	baseValue: ParamValue;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
}) {
	const editor = useEditor();
	const resolvedValue = resolveAnimationPathValueAtTime({
		animations: element.animations,
		propertyPath: param.key,
		localTime,
		fallbackValue: baseValue,
	});
	const animatedParam = useKeyframedParamProperty({
		param,
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: param.key,
		localTime,
		isPlayheadWithinElementRange,
		resolvedValue,
		buildBaseUpdates: ({ value }) =>
			writeElementParamValue({ element, param, value }),
	});

	const isMultiSelect = (elementsWithTracks?.length ?? 0) > 1;

	const handlePreview = (value: ParamValue) => {
		if (isMultiSelect && elementsWithTracks) {
			const updates = elementsWithTracks.map(({ element: el, track: tr }) => ({
				trackId: tr.id,
				elementId: el.id,
				updates: writeElementParamValue({ element: el, param, value }),
			}));
			editor.timeline.previewElements({ updates });
			return;
		}
		animatedParam.onPreview(value);
	};

	return (
		<PropertyParamField
			param={param}
			value={resolvedValue}
			onPreview={handlePreview}
			onCommit={animatedParam.onCommit}
			keyframe={
				param.keyframable === false || isMultiSelect
					? undefined
					: {
							isActive: animatedParam.isKeyframedAtTime,
							isDisabled: !isPlayheadWithinElementRange,
							onToggle: animatedParam.toggleKeyframe,
						}
			}
		/>
	);
}

function buildValues({
	element,
	params,
}: {
	element: TimelineElement;
	params: readonly ElementParamDefinition[];
}): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		const value = readElementParamValue({ element, param });
		if (value !== null) {
			values[param.key] = value;
		}
	}
	return values;
}

function isVisible({
	param,
	values,
}: {
	param: ElementParamDefinition;
	values: ParamValues;
}): boolean {
	return (param.dependencies ?? []).every((dependency) =>
		areParamValuesEqual({
			left: values[dependency.param],
			right: dependency.equals,
		}),
	);
}

function areParamValuesEqual({
	left,
	right,
}: {
	left: ParamValue | undefined;
	right: ParamValue;
}): boolean {
	return left === right;
}
