import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks, TextElement, TextTrack } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement";
import { generateUUID } from "@/utils/id";
import { buildSubtitleTextElement } from "@/subtitles/build-subtitle-text-element";
import type { SubtitleCue } from "@/subtitles/types";

export interface InsertSubtitlesParams {
	captions: SubtitleCue[];
	sourceClipId?: string;
}

export class InsertSubtitlesCommand extends Command {
	private captions: SubtitleCue[];
	private sourceClipId?: string;
	private savedState: SceneTracks | null = null;
	private targetTrackId: string | null = null;
	private insertedElementIds: string[] = [];

	constructor({ captions, sourceClipId }: InsertSubtitlesParams) {
		super();
		this.captions = captions;
		this.sourceClipId = sourceClipId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		if (this.captions.length === 0) {
			return undefined;
		}

		// Look for an existing text track in overlay to reuse
		let targetTrack = this.savedState.overlay.find(
			(track): track is TextTrack => track.type === "text",
		);

		let isNewTrack = false;
		if (!targetTrack) {
			targetTrack = buildEmptyTrack({
				id: generateUUID(),
				type: "text",
				name: "Subtitles",
			});
			isNewTrack = true;
		}

		this.targetTrackId = targetTrack.id;
		const canvasSize = editor.project.getActive().settings.canvasSize;
		this.insertedElementIds = [];

		const newElements: TextElement[] = this.captions.map((caption, index) => {
			const elementId = generateUUID();
			this.insertedElementIds.push(elementId);
			const textElementBlueprint = buildSubtitleTextElement({
				index,
				caption,
				canvasSize,
			});

			return {
				...textElementBlueprint,
				id: elementId,
			} as TextElement;
		});

		let updatedOverlay: SceneTracks["overlay"];
		if (isNewTrack) {
			const completeNewTrack: TextTrack = {
				...targetTrack,
				elements: newElements,
			};
			updatedOverlay = [completeNewTrack, ...this.savedState.overlay];
		} else {
			updatedOverlay = this.savedState.overlay.map((track) => {
				if (track.id === this.targetTrackId && track.type === "text") {
					const combinedElements = [...track.elements, ...newElements].sort(
						(a, b) => a.startTime - b.startTime,
					);
					return {
						...track,
						elements: combinedElements,
					} as TextTrack;
				}
				return track;
			});
		}

		const updatedTracks: SceneTracks = {
			...this.savedState,
			overlay: updatedOverlay,
		};

		editor.timeline.updateTracks(updatedTracks);

		return {
			selection: {
				selectedElements:
					this.insertedElementIds.length > 0
						? [
								{
									trackId: this.targetTrackId!,
									elementId: this.insertedElementIds[0],
								},
							]
						: [],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			},
		};
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getTrackId(): string | null {
		return this.targetTrackId;
	}

	getInsertedElementIds(): string[] {
		return this.insertedElementIds;
	}
}
