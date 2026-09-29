import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useMemo, useReducer, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { TRANSCRIPTION_DIAGNOSTICS_SCOPE } from "@/transcription/diagnostics";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";
import type {
	CaptionChunk,
	TranscriptionLanguage,
	TranscriptionProgress,
} from "@/transcription/types";
import { transcriptionService } from "@/services/transcription/service";
import {
	extractClipAudioForTranscription,
	extractTimelineAudioForTranscription,
} from "@/media/transcription-audio";
import { buildCaptionChunks } from "@/transcription/caption";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { parseSubtitleFile } from "@/subtitles/parse";
import { Spinner } from "@/components/ui/spinner";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import { AlertCircleIcon, CloudUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DiagnosticSeverity } from "@/diagnostics/types";
import { canElementHaveAudio } from "@/timeline/element-utils";
import type { SceneTracks, TimelineElement } from "@/timeline";

const DIAGNOSTIC_BUTTON_VARIANT: Record<
	DiagnosticSeverity,
	"caution" | "destructive-foreground"
> = {
	caution: "caution",
	error: "destructive-foreground",
};

type ProcessingState =
	| { status: "idle"; error: string | null; warnings: string[] }
	| { status: "processing"; step: string };

type ProcessingAction =
	| { type: "start"; step: string }
	| { type: "update_step"; step: string }
	| { type: "succeed"; warnings: string[] }
	| { type: "fail"; error: string };

const IDLE_STATE: ProcessingState = {
	status: "idle",
	error: null,
	warnings: [],
};

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

/* eslint-disable opencut/prefer-object-params -- React reducers must accept (state, action). */
function processingReducer(
	state: ProcessingState,
	action: ProcessingAction,
): ProcessingState {
	switch (action.type) {
		case "start":
			return { status: "processing", step: action.step };
		case "update_step":
			if (state.status !== "processing") return state;
			return { status: "processing", step: action.step };
		case "succeed":
			return { status: "idle", error: null, warnings: action.warnings };
		case "fail":
			return { status: "idle", error: action.error, warnings: [] };
	}
}
/* eslint-enable opencut/prefer-object-params */

export function Captions() {
	const [selectedLanguage, setSelectedLanguage] =
		useState<TranscriptionLanguage>("auto");
	const [userScope, setUserScope] = useState<"selected" | "timeline" | null>(
		null,
	);
	const [processing, dispatch] = useReducer(processingReducer, IDLE_STATE);
	const containerRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const editor = useEditor();

	const selectedElements = useEditor((e) => e.selection.getSelectedElements());
	const tracks = useEditor((e) => e.scenes.getActiveScene().tracks);

	const selectedAudibleElement = useMemo(() => {
		if (selectedElements.length !== 1) return null;
		const ref = selectedElements[0];
		const el = findElementInTracks({ tracks, elementId: ref.elementId });
		if (el && canElementHaveAudio(el)) {
			return el;
		}
		return null;
	}, [selectedElements, tracks]);

	const effectiveScope =
		userScope ?? (selectedAudibleElement ? "selected" : "timeline");

	const isProcessing = processing.status === "processing";

	const activeDiagnostics = useEditor((e) =>
		e.diagnostics.getActive({ scope: TRANSCRIPTION_DIAGNOSTICS_SCOPE }),
	);

	const handleProgress = (progress: TranscriptionProgress) => {
		if (progress.status === "loading-model") {
			dispatch({
				type: "update_step",
				step: `Loading model ${Math.round(progress.progress)}%`,
			});
		} else if (progress.status === "transcribing") {
			dispatch({
				type: "update_step",
				step: progress.message ?? "Transcribing...",
			});
		}
	};

	const insertCaptions = ({
		captions,
		sourceClipId,
	}: {
		captions: CaptionChunk[];
		sourceClipId?: string;
	}): boolean => {
		const trackId = insertCaptionChunksAsTextTrack({
			editor,
			captions,
			sourceClipId,
		});
		return trackId !== null;
	};

	const handleGenerateTranscript = async () => {
		dispatch({ type: "start", step: "Extracting audio..." });
		try {
			const activeTracks = editor.scenes.getActiveScene().tracks;
			const mediaAssets = editor.media.getAssets();

			let audioData: Float32Array;
			let clipStartTime = 0;
			let retimeRate = 1.0;
			let sourceClipId: string | undefined;

			if (effectiveScope === "selected" && selectedAudibleElement) {
				const clipInfo = await extractClipAudioForTranscription({
					element: selectedAudibleElement,
					tracks: activeTracks,
					mediaAssets,
				});

				if (!clipInfo || clipInfo.audioData.length === 0) {
					dispatch({
						type: "fail",
						error: "Could not extract audio from the selected clip",
					});
					return;
				}

				audioData = clipInfo.audioData;
				clipStartTime = clipInfo.clipStartTime;
				retimeRate = clipInfo.retimeRate;
				sourceClipId = clipInfo.elementId;
			} else {
				const timelineInfo = await extractTimelineAudioForTranscription({
					tracks: activeTracks,
					mediaAssets,
					totalDurationTicks: editor.timeline.getTotalDuration(),
					onProgress: (progress) => {
						dispatch({
							type: "update_step",
							step: `Extracting audio (${Math.round(progress)}%)...`,
						});
					},
				});

				if (timelineInfo.audioData.length === 0) {
					dispatch({
						type: "fail",
						error: "Timeline has no audible elements or duration is 0",
					});
					return;
				}

				audioData = timelineInfo.audioData;
			}

			dispatch({ type: "update_step", step: "Transcribing audio..." });

			const result = await transcriptionService.transcribe({
				audioData,
				language: selectedLanguage === "auto" ? undefined : selectedLanguage,
				onProgress: handleProgress,
			});

			dispatch({ type: "update_step", step: "Generating captions..." });
			const rawCaptionChunks = buildCaptionChunks({
				segments: result.segments,
				words: result.words,
			});

			// Map captions to timeline coordinates taking retime and clip position into account
			const captionChunks: CaptionChunk[] = rawCaptionChunks.map((chunk) => ({
				...chunk,
				startTime: clipStartTime + chunk.startTime / retimeRate,
				duration: chunk.duration / retimeRate,
			}));

			if (!insertCaptions({ captions: captionChunks, sourceClipId })) {
				dispatch({ type: "fail", error: "No captions were generated" });
				return;
			}

			dispatch({ type: "succeed", warnings: [] });
		} catch (error) {
			console.error("Transcription failed:", error);
			dispatch({
				type: "fail",
				error:
					error instanceof Error
						? error.message
						: "An unexpected error occurred",
			});
		}
	};

	const handleImportClick = () => {
		fileInputRef.current?.click();
	};

	const handleImportFile = async ({ file }: { file: File }) => {
		dispatch({ type: "start", step: "Reading subtitle file..." });
		try {
			const input = await file.text();
			const result = parseSubtitleFile({
				fileName: file.name,
				input,
			});

			if (result.captions.length === 0) {
				dispatch({
					type: "fail",
					error: "No valid subtitle cues were found in the subtitle file",
				});
				return;
			}

			dispatch({ type: "update_step", step: "Importing subtitles..." });

			if (!insertCaptions({ captions: result.captions })) {
				dispatch({ type: "fail", error: "No captions were generated" });
				return;
			}

			const nextWarnings = [...result.warnings];
			if (result.skippedCueCount > 0) {
				nextWarnings.unshift(
					`Imported ${result.captions.length} subtitle cue(s) and skipped ${result.skippedCueCount} malformed cue(s).`,
				);
			}

			dispatch({ type: "succeed", warnings: nextWarnings });
		} catch (error) {
			console.error("Subtitle import failed:", error);
			dispatch({
				type: "fail",
				error:
					error instanceof Error
						? error.message
						: "An unexpected error occurred",
			});
		}
	};

	const handleFileChange = async ({
		event,
	}: {
		event: React.ChangeEvent<HTMLInputElement>;
	}) => {
		const file = event.target.files?.[0];
		if (event.target) {
			event.target.value = "";
		}
		if (!file) return;

		await handleImportFile({ file });
	};

	const handleLanguageChange = ({ value }: { value: string }) => {
		if (value === "auto") {
			setSelectedLanguage("auto");
			return;
		}
		const matched = TRANSCRIPTION_LANGUAGES.find(
			(language) => language.code === value,
		);
		if (matched) setSelectedLanguage(matched.code);
	};

	const error = processing.status === "idle" ? processing.error : null;
	const warnings = processing.status === "idle" ? processing.warnings : [];

	return (
		<PanelView
			title="Captions"
			actions={
				<TooltipProvider>
					<div className="flex items-center gap-1">
						{activeDiagnostics.map((diagnostic) => (
							<Tooltip key={diagnostic.id}>
								<TooltipTrigger asChild>
									<Button
										variant={DIAGNOSTIC_BUTTON_VARIANT[diagnostic.severity]}
										size="icon"
										className="size-7"
									>
										<HugeiconsIcon icon={AlertCircleIcon} />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									<p>{diagnostic.message}</p>
								</TooltipContent>
							</Tooltip>
						))}
						<Button
							variant="ghost"
							size="sm"
							onClick={handleImportClick}
							disabled={isProcessing}
							className="text-xs"
						>
							<HugeiconsIcon icon={CloudUploadIcon} />
							Import
						</Button>
					</div>
				</TooltipProvider>
			}
			ref={containerRef}
		>
			<input
				ref={fileInputRef}
				type="file"
				accept=".srt,.ass"
				className="hidden"
				onChange={(event) => void handleFileChange({ event })}
			/>
			<Section
				showTopBorder={false}
				showBottomBorder={false}
				className="flex-1"
			>
				<SectionContent className="flex flex-col gap-4 h-full pt-1">
					<SectionFields>
						<SectionField label="Scope">
							<Select
								value={effectiveScope}
								onValueChange={(val: "selected" | "timeline") =>
									setUserScope(val)
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem
										value="selected"
										disabled={!selectedAudibleElement}
									>
										{selectedAudibleElement
											? `Selected clip (${selectedAudibleElement.name})`
											: "Selected clip (none selected)"}
									</SelectItem>
									<SelectItem value="timeline">Entire timeline</SelectItem>
								</SelectContent>
							</Select>
						</SectionField>

						<SectionField label="Language">
							<Select
								value={selectedLanguage}
								onValueChange={(value) => handleLanguageChange({ value })}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select a language" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="auto">Auto detect</SelectItem>
									{TRANSCRIPTION_LANGUAGES.map((language) => (
										<SelectItem key={language.code} value={language.code}>
											{language.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
					</SectionFields>

					<Button
						type="button"
						className="mt-auto w-full"
						onClick={handleGenerateTranscript}
						disabled={isProcessing || activeDiagnostics.length > 0}
					>
						{isProcessing && <Spinner className="mr-1" />}
						{isProcessing ? processing.step : "Generate transcript"}
					</Button>
					{error && (
						<div className="bg-destructive/10 border-destructive/20 rounded-md border p-3">
							<p className="text-destructive text-sm">{error}</p>
						</div>
					)}
					{warnings.length > 0 && (
						<div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
							<ul className="space-y-1 text-sm text-amber-700">
								{warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</div>
					)}
				</SectionContent>
			</Section>
		</PanelView>
	);
}
