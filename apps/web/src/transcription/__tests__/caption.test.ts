import { describe, expect, it } from "bun:test";
import { buildCaptionChunks } from "../caption";
import type { TranscriptionSegment, TranscriptionWord } from "../types";

describe("buildCaptionChunks (Whisper segment timestamps)", () => {
	it("keeps real segment boundaries instead of inventing word timestamps", () => {
		const segments: TranscriptionSegment[] = [
			{ text: "Xin chào các bạn", start: 1.0, end: 5.0 },
		];

		const chunks = buildCaptionChunks({
			segments,
			wordsPerChunk: 2,
			minDuration: 0.8,
		});

		expect(chunks.length).toBe(1);
		expect(chunks[0].text).toBe("Xin chào các bạn");
		expect(chunks[0].startTime).toBe(1.0);
		expect(chunks[0].duration).toBe(4.0);
	});

	it("does not extend a segment past its detected speech end", () => {
		const segments: TranscriptionSegment[] = [
			{ text: "Nhanh quá", start: 0.1, end: 0.5 },
		];

		const chunks = buildCaptionChunks({
			segments,
			wordsPerChunk: 1,
			minDuration: 1.0,
		});

		expect(chunks.length).toBe(1);
		expect(chunks[0].duration).toBeCloseTo(0.4, 2);
	});
});

describe("buildCaptionChunks (real model word timestamps)", () => {
	it("places cue #1 on the true voice onset, not the clip head", () => {
		// Ball spoken at ~1.5s after leading background music; Doll at ~4s.
		const words: TranscriptionWord[] = [
			{ word: "Ball", start: 1.5, end: 1.9 },
			{ word: "Doll", start: 4.0, end: 4.4 },
		];
		const segments: TranscriptionSegment[] = [
			{ text: "Ball", start: 0, end: 2, words: [words[0]] },
			{ text: "Doll", start: 4, end: 6, words: [words[1]] },
		];

		const chunks = buildCaptionChunks({
			segments,
			words,
			wordsPerChunk: 3,
			minDuration: 0.8,
		});

		expect(chunks.length).toBe(2);
		expect(chunks[0].text).toBe("Ball");
		expect(chunks[0].startTime).toBeCloseTo(1.5, 2);
		expect(chunks[1].text).toBe("Doll");
		expect(chunks[1].startTime).toBeCloseTo(4.0, 2);
	});

	it("breaks cues on natural pauses between real words", () => {
		const words: TranscriptionWord[] = [
			{ word: "Xin", start: 1.0, end: 1.25 },
			{ word: "chào", start: 1.25, end: 1.55 },
			// 1.45s pause
			{ word: "các", start: 3.0, end: 3.2 },
			{ word: "bạn", start: 3.2, end: 3.5 },
		];

		const chunks = buildCaptionChunks({
			segments: [],
			words,
			wordsPerChunk: 5,
			minDuration: 0.6,
		});

		expect(chunks.length).toBe(2);
		expect(chunks[0].text).toBe("Xin chào");
		expect(chunks[0].startTime).toBe(1.0);
		expect(chunks[0].startTime + chunks[0].duration).toBeLessThanOrEqual(3.0);
		expect(chunks[1].text).toBe("các bạn");
		expect(chunks[1].startTime).toBe(3.0);
	});

	it("prefers segment-embedded words when top-level words are absent", () => {
		const segments: TranscriptionSegment[] = [
			{
				text: "Ball",
				start: 0,
				end: 2,
				words: [{ word: "Ball", start: 1.5, end: 1.9 }],
			},
		];

		const chunks = buildCaptionChunks({ segments, wordsPerChunk: 3 });

		expect(chunks.length).toBe(1);
		expect(chunks[0].startTime).toBeCloseTo(1.5, 2);
	});

	it("does not stretch a short final word after speech ends", () => {
		const chunks = buildCaptionChunks({
			segments: [],
			words: [{ word: "Yes", start: 2.0, end: 2.25 }],
			minDuration: 0.8,
		});

		expect(chunks[0].startTime).toBe(2.0);
		expect(chunks[0].duration).toBe(0.25);
	});

	it("removes duplicate words from overlapping Whisper windows", () => {
		const chunks = buildCaptionChunks({
			segments: [],
			words: [
				{ word: "hello", start: 4.0, end: 4.3 },
				{ word: "hello", start: 4.05, end: 4.35 },
				{ word: "world", start: 4.4, end: 4.8 },
			],
			wordsPerChunk: 3,
		});

		expect(chunks).toHaveLength(1);
		expect(chunks[0].text).toBe("hello world");
	});
});

describe("Retime & Timeline Coordinate Transformation", () => {
	it("should correctly scale Whisper timestamps by retimeRate and add clipStartTime", () => {
		const rawChunks = [
			{ text: "Nói nhanh", startTime: 1.5, duration: 1.5 },
			{ text: "rất nhiều", startTime: 3.5, duration: 1.0 },
		];

		const clipStartTime = 12.0;
		const retimeRate = 1.5;

		const mappedChunks = rawChunks.map((chunk) => ({
			...chunk,
			startTime: clipStartTime + chunk.startTime / retimeRate,
			duration: chunk.duration / retimeRate,
		}));

		expect(mappedChunks[0].startTime).toBe(13.0);
		expect(mappedChunks[0].duration).toBe(1.0);
		expect(mappedChunks[1].startTime).toBeCloseTo(14.333, 2);
		expect(mappedChunks[1].duration).toBeCloseTo(0.667, 2);
	});
});
