import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { applyPlacement, resolveTrackPlacement } from "@/timeline/placement";
import { updateElementInSceneTracks } from "@/timeline/track-element-update";
import type {
	CreateUploadAudioElement,
	SceneTracks,
	TimelineElement,
	VideoElement,
	AudioElement,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import type { SeparationMode } from "@/services/vocal-separation/types";

export interface SeparateVocalsCommandParams {
	trackId: string;
	elementId: string;
	mode: SeparationMode;
	vocalsAsset?: MediaAsset;
	instrumentalAsset?: MediaAsset;
}

export class SeparateVocalsCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(private readonly params: SeparateVocalsCommandParams) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const sourceTrack = [
			...this.savedState.overlay,
			this.savedState.main,
			...this.savedState.audio,
		].find((track) => track.id === this.params.trackId);

		if (!sourceTrack) {
			return;
		}

		const sourceElement = sourceTrack.elements.find(
			(el) => el.id === this.params.elementId,
		) as TimelineElement | undefined;

		if (!sourceElement) {
			return;
		}

		let currentTracks: SceneTracks = this.savedState;

		// 1. Mute or disable source audio to prevent double playback
		if (sourceElement.type === "video") {
			currentTracks = updateElementInSceneTracks({
				tracks: currentTracks,
				trackId: this.params.trackId,
				elementId: this.params.elementId,
				elementPredicate: (element): element is VideoElement =>
					element.type === "video",
				update: (element) => ({
					...element,
					isSourceAudioEnabled: false,
				}),
			});
		} else if (sourceElement.type === "audio") {
			currentTracks = updateElementInSceneTracks({
				tracks: currentTracks,
				trackId: this.params.trackId,
				elementId: this.params.elementId,
				elementPredicate: (element): element is AudioElement =>
					element.type === "audio",
				update: (element) => ({
					...element,
					params: {
						...element.params,
						muted: true,
					},
				}),
			});
		}

		// Helper to build audio element
		const buildStemElement = (
			asset: MediaAsset,
			stemSuffix: string,
		): CreateUploadAudioElement & { id: string } => {
			return {
				id: generateUUID(),
				type: "audio",
				sourceType: "upload",
				mediaId: asset.id,
				name: `${sourceElement.name} (${stemSuffix})`,
				duration: sourceElement.duration,
				startTime: sourceElement.startTime,
				trimStart: sourceElement.trimStart,
				trimEnd: sourceElement.trimEnd,
				sourceDuration: sourceElement.sourceDuration ?? sourceElement.duration,
				params: {
					volume: sourceElement.params?.volume ?? 1,
					muted: false,
				},
				retime:
					"retime" in sourceElement && sourceElement.retime
						? {
								rate: (sourceElement.retime as any).rate,
								maintainPitch: (sourceElement.retime as any).maintainPitch,
							}
						: undefined,
				animations: sourceElement.animations
					? JSON.parse(JSON.stringify(sourceElement.animations))
					: undefined,
			};
		};

		// 2. Place Vocals Element if available
		if (this.params.vocalsAsset) {
			const vocalsElement = buildStemElement(this.params.vocalsAsset, "Vocals");
			const placement = resolveTrackPlacement({
				tracks: currentTracks,
				trackType: "audio",
				timeSpans: [
					{
						startTime: vocalsElement.startTime,
						duration: vocalsElement.duration,
					},
				],
				strategy: { type: "firstAvailable" },
			});

			if (placement) {
				const applied = applyPlacement({
					tracks: currentTracks,
					placementResult: placement,
					elements: [vocalsElement],
				});
				if (applied) {
					currentTracks = applied.updatedTracks;
				}
			}
		}

		// 3. Place Instrumental Element if available
		if (this.params.instrumentalAsset) {
			const instElement = buildStemElement(
				this.params.instrumentalAsset,
				"Instrumental",
			);
			const placement = resolveTrackPlacement({
				tracks: currentTracks,
				trackType: "audio",
				timeSpans: [
					{
						startTime: instElement.startTime,
						duration: instElement.duration,
					},
				],
				// Use new track if vocals was also placed, or first available
				strategy: this.params.vocalsAsset
					? { type: "alwaysNew", position: "default" }
					: { type: "firstAvailable" },
			});

			if (placement) {
				const applied = applyPlacement({
					tracks: currentTracks,
					placementResult: placement,
					elements: [instElement],
				});
				if (applied) {
					currentTracks = applied.updatedTracks;
				}
			}
		}

		editor.timeline.updateTracks(currentTracks);
		return undefined;
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}

		const editor = EditorCore.getInstance();
		editor.timeline.updateTracks(this.savedState);
	}
}
