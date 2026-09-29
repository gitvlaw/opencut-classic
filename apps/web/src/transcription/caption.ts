import type {
	TranscriptionSegment,
	TranscriptionWord,
	CaptionChunk,
} from "@/transcription/types";
import {
	DEFAULT_WORDS_PER_CAPTION,
	MIN_CAPTION_DURATION_SECONDS,
} from "@/transcription/caption-defaults";

// Break cues on natural pauses at/above this gap (seconds).
const PAUSE_BREAK_SECONDS = 0.4;
// Never let one cue span more than this (seconds) of real speech.
const MAX_CUE_SPAN_SECONDS = 4.0;
// Keep a small gap so consecutive cues never touch.
const MIN_GAP_BETWEEN_CUES_SECONDS = 0.05;

function collectRealWords({
	segments,
	words,
}: {
	segments: TranscriptionSegment[];
	words?: TranscriptionWord[];
}): TranscriptionWord[] {
	const collected: TranscriptionWord[] = [];
	if (words && words.length > 0) {
		for (const word of words) {
			if (word.word && word.word.trim() !== "") {
				collected.push(word);
			}
		}
	} else {
		for (const segment of segments) {
			if (segment.words && segment.words.length > 0) {
				for (const word of segment.words) {
					if (word.word && word.word.trim() !== "") {
						collected.push(word);
					}
				}
			}
		}
	}
	const sorted = collected
		.filter(
			(word) =>
				Number.isFinite(word.start) &&
				Number.isFinite(word.end) &&
				word.start >= 0 &&
				word.end >= word.start,
		)
		.map((word) => ({
			...word,
			word: word.word.trim(),
			end: Math.max(word.start + 0.05, word.end),
		}))
		.sort((a, b) => a.start - b.start || a.end - b.end);

	// Long-form Whisper windows can repeat a boundary token in their overlap.
	// Remove only near-identical duplicates; repeated words spoken later remain.
	return sorted.filter((word, index) => {
		const previous = sorted[index - 1];
		if (!previous) return true;
		return !(
			word.word.toLocaleLowerCase() === previous.word.toLocaleLowerCase() &&
			word.start < previous.end + 0.08 &&
			Math.abs(word.start - previous.start) < 0.35
		);
	});
}

function buildFromRealWords({
	allWords,
	wordsPerChunk,
	minDuration,
}: {
	allWords: TranscriptionWord[];
	wordsPerChunk: number;
	minDuration: number;
}): CaptionChunk[] {
	const maxWords = Math.max(1, wordsPerChunk);
	const rawCues: Array<{
		words: TranscriptionWord[];
		text: string;
		rawStart: number;
		rawEnd: number;
	}> = [];
	let current: TranscriptionWord[] = [];

	const flush = () => {
		if (current.length === 0) return;
		const first = current[0];
		const last = current[current.length - 1];
		const text = current
			.map((w) => w.word.trim())
			.filter(Boolean)
			.join(" ");
		if (text.length > 0) {
			rawCues.push({
				words: [...current],
				text,
				rawStart: first.start,
				rawEnd: Math.max(first.start + 0.15, last.end),
			});
		}
		current = [];
	};

	for (let i = 0; i < allWords.length; i++) {
		current.push(allWords[i]);
		if (i === allWords.length - 1) {
			flush();
			break;
		}
		const next = allWords[i + 1];
		const pause = next.start - allWords[i].end;
		const span = allWords[i].end - current[0].start;
		const endsWithPunctuation = /[.,!?:;…]$/.test(allWords[i].word.trim());
		if (
			pause >= PAUSE_BREAK_SECONDS ||
			endsWithPunctuation ||
			current.length >= maxWords ||
			span >= MAX_CUE_SPAN_SECONDS
		) {
			flush();
		}
	}

	// Preserve the model's speech boundaries. Artificially stretching short cues
	// makes captions visibly linger after the speaker has stopped. minDuration is
	// only a safety fallback for malformed/zero-length model timestamps.
	const captions: CaptionChunk[] = [];
	for (let i = 0; i < rawCues.length; i++) {
		const cue = rawCues[i];
		const natural = cue.rawEnd - cue.rawStart;
		const next = rawCues[i + 1];
		const safeNatural = natural > 0 ? natural : Math.max(0.1, minDuration);
		const maxBeforeNext = next
			? Math.max(
					0.1,
					next.rawStart - cue.rawStart - MIN_GAP_BETWEEN_CUES_SECONDS,
				)
			: safeNatural;
		const duration = Math.min(safeNatural, maxBeforeNext);
		captions.push({
			text: cue.text,
			startTime: Math.round(cue.rawStart * 100) / 100,
			duration: Math.max(0.1, Math.round(duration * 100) / 100),
			words: cue.words,
		});
	}
	return captions;
}

export function buildCaptionChunks({
	segments,
	words,
	wordsPerChunk = DEFAULT_WORDS_PER_CAPTION,
	minDuration = MIN_CAPTION_DURATION_SECONDS,
}: {
	segments: TranscriptionSegment[];
	// Real model-predicted word timestamps when the backend supports them.
	// These take priority because only the model can tell voice apart from
	// leading music/silence. Never synthesized here — see worker.ts.
	words?: TranscriptionWord[];
	wordsPerChunk?: number;
	minDuration?: number;
}): CaptionChunk[] {
	// STRATEGY 1: real word timestamps from the model.
	const allWords = collectRealWords({ segments, words });
	if (allWords.length > 0) {
		return buildFromRealWords({ allWords, wordsPerChunk, minDuration });
	}

	// STRATEGY 2 (fallback): keep Whisper's real segment boundaries. Splitting a
	// segment proportionally creates plausible-looking but invented timestamps,
	// which drift badly around pauses, music and sound effects.
	const captions: CaptionChunk[] = [];
	let globalEndTime = 0;

	for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
		const text = segment.text.trim();
		if (
			!text ||
			!Number.isFinite(segment.start) ||
			!Number.isFinite(segment.end)
		) {
			continue;
		}

		const startTime = Math.max(0, segment.start, globalEndTime);
		const naturalDuration = segment.end - startTime;
		if (naturalDuration <= 0) continue;

		const duration = Math.max(0.1, naturalDuration);
		captions.push({ text, startTime, duration });
		globalEndTime = startTime + duration;
	}

	return captions;
}
