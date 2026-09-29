import {
	pipeline,
	type AutomaticSpeechRecognitionPipeline,
	type AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers";
import type {
	TranscriptionSegment,
	TranscriptionWord,
} from "@/transcription/types";
import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
	DEFAULT_STRIDE_SECONDS,
} from "@/transcription/audio";
import { detectSpeechSlices, type SpeechSlice } from "@/transcription/vad";

export type WorkerMessage =
	| { type: "init"; modelId: string }
	| { type: "transcribe"; audio: Float32Array; language: string }
	| { type: "cancel" };

export type WorkerResponse =
	| { type: "init-progress"; progress: number }
	| { type: "init-complete" }
	| { type: "init-error"; error: string }
	| { type: "transcribe-progress"; progress: number; message?: string }
	| {
			type: "transcribe-complete";
			text: string;
			segments: TranscriptionSegment[];
			words?: TranscriptionWord[];
	  }
	| { type: "transcribe-error"; error: string }
	| { type: "cancelled" };

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let cancelled = false;
let lastReportedProgress = -1;
const fileBytes = new Map<string, { loaded: number; total: number }>();

type RawResult =
	| AutomaticSpeechRecognitionOutput
	| AutomaticSpeechRecognitionOutput[];

async function transcribeSpeechSlice({
	slice,
	language,
}: {
	slice: SpeechSlice;
	language?: string;
}): Promise<{
	text: string;
	segments: TranscriptionSegment[];
	words: TranscriptionWord[];
}> {
	if (!transcriber) throw new Error("Model not initialized");

	const baseOptions = {
		chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
		stride_length_s: DEFAULT_STRIDE_SECONDS,
		language,
	};
	let rawResult: RawResult | null = null;
	let wordLevel = false;

	try {
		rawResult = (await transcriber(slice.audio, {
			...baseOptions,
			return_timestamps: "word",
		} as Record<string, unknown>)) as RawResult;
		const probe = Array.isArray(rawResult) ? rawResult[0] : rawResult;
		wordLevel =
			!!probe?.chunks?.length &&
			probe.chunks.some(
				(chunk) =>
					typeof chunk?.timestamp?.[0] === "number" &&
					typeof chunk?.timestamp?.[1] === "number",
			);
		if (!wordLevel) rawResult = null;
	} catch {
		rawResult = null;
	}

	if (!rawResult) {
		rawResult = (await transcriber(slice.audio, {
			...baseOptions,
			return_timestamps: true,
		})) as RawResult;
	}

	const result = Array.isArray(rawResult) ? rawResult[0] : rawResult;
	const words: TranscriptionWord[] = [];
	const segments: TranscriptionSegment[] = [];
	const sourceDuration = Math.max(0, slice.end - slice.start);

	if (result.chunks) {
		for (const chunk of result.chunks) {
			const timestamp = chunk.timestamp;
			const relativeStart = timestamp?.[0];
			const relativeEnd = timestamp?.[1];
			const text = (chunk.text ?? "").trim();
			if (
				!text ||
				typeof relativeStart !== "number" ||
				typeof relativeEnd !== "number"
			) {
				continue;
			}

			// Ignore hallucinations in the zero-padding added to very short VAD
			// slices, then restore timestamps to the original audio timebase.
			if (relativeStart >= sourceDuration + 0.05) continue;
			const start = slice.start + Math.max(0, relativeStart);
			const end = slice.start + Math.min(sourceDuration, relativeEnd);
			if (end <= start) continue;

			if (wordLevel) {
				words.push({ word: text, start, end });
			} else {
				segments.push({ text, start, end });
			}
		}
	}

	if (wordLevel && words.length > 0) {
		const WORD_GAP_NEW_SEGMENT = 0.5;
		let current: TranscriptionWord[] = [];
		const flushSegment = () => {
			if (current.length === 0) return;
			const first = current[0];
			const last = current[current.length - 1];
			segments.push({
				text: current.map((word) => word.word).join(" "),
				start: first.start,
				end: last.end,
				words: [...current],
			});
			current = [];
		};

		for (let index = 0; index < words.length; index++) {
			current.push(words[index]);
			const next = words[index + 1];
			if (!next || next.start - words[index].end >= WORD_GAP_NEW_SEGMENT) {
				flushSegment();
			}
		}
	}

	return { text: result.text.trim(), segments, words };
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			await handleInit({ modelId: message.modelId });
			break;
		case "transcribe":
			await handleTranscribe({
				audio: message.audio,
				language: message.language,
			});
			break;
		case "cancel":
			cancelled = true;
			self.postMessage({ type: "cancelled" } satisfies WorkerResponse);
			break;
	}
};

/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The generic pipeline factory's union is too complex for TypeScript; the literal task guarantees this pipeline type. */
async function handleInit({ modelId }: { modelId: string }) {
	lastReportedProgress = -1;
	fileBytes.clear();

	try {
		transcriber = (await pipeline("automatic-speech-recognition", modelId, {
			dtype: "q4",
			device: "auto",
			progress_callback: (progressInfo: {
				status?: string;
				file?: string;
				loaded?: number;
				total?: number;
			}) => {
				const file = progressInfo.file;
				if (!file) return;

				const loaded = progressInfo.loaded ?? 0;
				const total = progressInfo.total ?? 0;

				if (progressInfo.status === "progress" && total > 0) {
					fileBytes.set(file, { loaded, total });
				} else if (progressInfo.status === "done") {
					const existing = fileBytes.get(file);
					if (existing) {
						fileBytes.set(file, {
							loaded: existing.total,
							total: existing.total,
						});
					}
				}

				// sum all bytes
				let totalLoaded = 0;
				let totalSize = 0;
				for (const { loaded, total } of fileBytes.values()) {
					totalLoaded += loaded;
					totalSize += total;
				}

				if (totalSize === 0) return;

				const overallProgress = (totalLoaded / totalSize) * 100;
				const roundedProgress = Math.floor(overallProgress);

				if (roundedProgress !== lastReportedProgress) {
					lastReportedProgress = roundedProgress;
					self.postMessage({
						type: "init-progress",
						progress: roundedProgress,
					} satisfies WorkerResponse);
				}
			},
		})) as unknown as AutomaticSpeechRecognitionPipeline;

		self.postMessage({ type: "init-complete" } satisfies WorkerResponse);
	} catch (error) {
		self.postMessage({
			type: "init-error",
			error: error instanceof Error ? error.message : "Failed to load model",
		} satisfies WorkerResponse);
	}
}
/* eslint-enable @typescript-eslint/no-unsafe-type-assertion */

async function handleTranscribe({
	audio,
	language,
}: {
	audio: Float32Array;
	language: string;
}) {
	if (!transcriber) {
		self.postMessage({
			type: "transcribe-error",
			error: "Model not initialized",
		} satisfies WorkerResponse);
		return;
	}

	cancelled = false;

	try {
		const lang = language === "auto" ? undefined : language;
		const detectedSlices = detectSpeechSlices({ audio });
		// If the energy gate cannot find speech, retain a whole-audio fallback
		// for quiet recordings. In normal mixed audio, VAD prevents music/SFX
		// from consuming Whisper's context and preserves each slice's offset.
		const slices =
			detectedSlices.length > 0
				? detectedSlices
				: [
						{
							start: 0,
							end: audio.length / DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
							audio,
						},
					];
		const segments: TranscriptionSegment[] = [];
		const words: TranscriptionWord[] = [];
		const texts: string[] = [];

		for (let index = 0; index < slices.length; index++) {
			if (cancelled) return;
			self.postMessage({
				type: "transcribe-progress",
				progress: Math.round((index / slices.length) * 100),
				message: `Transcribing speech ${index + 1}/${slices.length}...`,
			} satisfies WorkerResponse);
			const partial = await transcribeSpeechSlice({
				slice: slices[index],
				language: lang,
			});
			if (partial.text) texts.push(partial.text);
			segments.push(...partial.segments);
			words.push(...partial.words);
		}

		if (cancelled) return;

		self.postMessage({
			type: "transcribe-complete",
			text: texts.join(" "),
			segments,
			words: words.length > 0 ? words : undefined,
		} satisfies WorkerResponse);
	} catch (error) {
		if (cancelled) return;
		self.postMessage({
			type: "transcribe-error",
			error: error instanceof Error ? error.message : "Transcription failed",
		} satisfies WorkerResponse);
	}
}
