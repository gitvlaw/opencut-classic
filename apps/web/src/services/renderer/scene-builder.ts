import type {
	SceneTracks,
	TimelineTrack,
	VideoElement,
	ImageElement,
} from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import { TransitionNode } from "./nodes/transition-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";

const PREVIEW_MAX_IMAGE_SIZE = 2048;

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

function buildVisualNodeForElement({
	element,
	mediaMap,
	isPreview,
	overrideTimeOffset,
	overrideDuration,
	overrideTrimStart,
}: {
	element: VideoElement | ImageElement;
	mediaMap: Map<string, MediaAsset>;
	isPreview?: boolean;
	overrideTimeOffset?: number;
	overrideDuration?: number;
	overrideTrimStart?: number;
}): VideoNode | ImageNode | null {
	const mediaAsset = mediaMap.get(element.mediaId);
	if (!mediaAsset?.file || !mediaAsset?.url) {
		return null;
	}

	const duration = overrideDuration ?? element.duration;
	const timeOffset = overrideTimeOffset ?? element.startTime;
	const trimStart = overrideTrimStart ?? element.trimStart;

	if (element.type === "video" && mediaAsset.type === "video") {
		return new VideoNode({
			mediaId: mediaAsset.id,
			url: mediaAsset.url,
			file: mediaAsset.file,
			duration,
			timeOffset,
			trimStart,
			trimEnd: element.trimEnd,
			retime: element.retime,
			transform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			opacity: readOpacityFromParams({ params: element.params }),
			blendMode: readBlendModeFromParams({ params: element.params }),
			effects: element.effects ?? [],
			masks: element.masks ?? [],
		});
	}

	if (element.type === "image" && mediaAsset.type === "image") {
		return new ImageNode({
			url: mediaAsset.url,
			duration,
			timeOffset,
			trimStart,
			trimEnd: element.trimEnd,
			transform: buildTransformFromParams({ params: element.params }),
			animations: element.animations,
			opacity: readOpacityFromParams({ params: element.params }),
			blendMode: readBlendModeFromParams({ params: element.params }),
			effects: element.effects ?? [],
			masks: element.masks ?? [],
			...(isPreview && {
				maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
			}),
		});
	}

	return null;
}

function buildTrackNodes({
	tracks,
	mediaMap,
	canvasSize,
	isPreview,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
}): AnyBaseNode[] {
	const nodes: AnyBaseNode[] = [];

	for (const track of tracks) {
		const elements = getVisibleSortedElements({ track });
		const transitions =
			track.type === "video" && track.transitions ? track.transitions : [];

		if (transitions.length === 0) {
			for (const element of elements) {
				if (element.type === "effect") {
					nodes.push(
						new EffectLayerNode({
							effectType: element.effectType,
							effectId: element.id,
							effectParams: element.params,
							animations: element.animations,
							timeOffset: element.startTime,
							duration: element.duration,
						}),
					);
					continue;
				}

				if (element.type === "video" || element.type === "image") {
					const node = buildVisualNodeForElement({
						element,
						mediaMap,
						isPreview,
					});
					if (node) {
						nodes.push(node);
					}
					continue;
				}

				if (element.type === "text") {
					nodes.push(
						new TextNode({
							...element,
							transform: buildTransformFromParams({ params: element.params }),
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
							canvasHeight: canvasSize.height,
							textBaseline: "middle",
							effects: element.effects ?? [],
						}),
					);
					continue;
				}

				if (element.type === "sticker") {
					nodes.push(
						new StickerNode({
							stickerId: element.stickerId,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
						}),
					);
					continue;
				}

				if (element.type === "graphic") {
					nodes.push(
						new GraphicNode({
							...element,
							timeOffset: element.startTime,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
						}),
					);
				}
			}
			continue;
		}

		// Track with transitions
		const visualElements = new Map<string, VideoElement | ImageElement>();
		for (const element of elements) {
			if (element.type === "video" || element.type === "image") {
				visualElements.set(element.id, element);
			}
		}

		const elementIntervals = new Map<
			string,
			{ activeStart: number; activeEnd: number }
		>();
		for (const [id, el] of visualElements) {
			elementIntervals.set(id, {
				activeStart: el.startTime,
				activeEnd: el.startTime + el.duration,
			});
		}

		for (const transition of transitions) {
			const elA = visualElements.get(transition.fromElementId);
			const elB = visualElements.get(transition.toElementId);
			if (!elA || !elB) continue;

			const nodeA = buildVisualNodeForElement({
				element: elA,
				mediaMap,
				isPreview,
			});
			const nodeB = buildVisualNodeForElement({
				element: elB,
				mediaMap,
				isPreview,
			});
			if (!nodeA || !nodeB) continue;

			const cutTime = elA.startTime + elA.duration;
			const duration = transition.duration;
			const alignment = transition.alignment ?? "center";
			const startTime =
				alignment === "start"
					? cutTime
					: alignment === "end"
						? cutTime - duration
						: cutTime - Math.floor(duration / 2);
			const endTime = startTime + duration;

			const intA = elementIntervals.get(elA.id);
			if (intA) {
				intA.activeEnd = Math.min(intA.activeEnd, startTime);
			}
			const intB = elementIntervals.get(elB.id);
			if (intB) {
				intB.activeStart = Math.max(intB.activeStart, endTime);
			}

			nodes.push(
				new TransitionNode({
					transition,
					nodeA,
					nodeB,
					fromElementId: transition.fromElementId,
					toElementId: transition.toElementId,
					cutTime,
					duration,
					startTime,
					endTime,
				}),
			);
		}

		for (const element of elements) {
			if (element.type === "effect") {
				nodes.push(
					new EffectLayerNode({
						effectType: element.effectType,
						effectId: element.id,
						effectParams: element.params,
						animations: element.animations,
						timeOffset: element.startTime,
						duration: element.duration,
					}),
				);
				continue;
			}

			if (element.type === "video" || element.type === "image") {
				const interval = elementIntervals.get(element.id);
				if (interval && interval.activeEnd > interval.activeStart) {
					const timeOffset = interval.activeStart;
					const duration = interval.activeEnd - interval.activeStart;
					const trimStart =
						element.trimStart + (timeOffset - element.startTime);
					const node = buildVisualNodeForElement({
						element,
						mediaMap,
						isPreview,
						overrideTimeOffset: timeOffset,
						overrideDuration: duration,
						overrideTrimStart: trimStart,
					});
					if (node) {
						nodes.push(node);
					}
				}
				continue;
			}

			if (element.type === "text") {
				nodes.push(
					new TextNode({
						...element,
						transform: buildTransformFromParams({ params: element.params }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
						effects: element.effects ?? [],
					}),
				);
				continue;
			}

			if (element.type === "sticker") {
				nodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
					}),
				);
				continue;
			}

			if (element.type === "graphic") {
				nodes.push(
					new GraphicNode({
						...element,
						timeOffset: element.startTime,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						masks: element.masks ?? [],
					}),
				);
			}
		}
	}

	return nodes;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const elements = getVisibleSortedElements({ track });

	for (const element of elements) {
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		const mediaAsset = mediaMap.get(element.mediaId);
		if (
			!mediaAsset?.file ||
			!mediaAsset?.url ||
			(mediaAsset.type !== "video" && mediaAsset.type !== "image")
		) {
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: mediaAsset.id,
				url: mediaAsset.url,
				file: mediaAsset.file,
				mediaType: mediaAsset.type,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.type === "video" ? element.retime : undefined,
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
};

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
}: BuildSceneParams) {
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));

	const visibleTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	];
	const orderedTracksBottomToTop = visibleTracks.slice().reverse();
	const mainTrack = tracks.main.hidden ? undefined : tracks.main;

	const allNodes = buildTrackNodes({
		tracks: orderedTracksBottomToTop,
		mediaMap,
		canvasSize,
		isPreview,
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
		});
		for (const node of blurNodes) {
			rootNode.add(node);
		}
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		rootNode.add(new ColorNode({ color: background.color }));
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	return rootNode;
}
