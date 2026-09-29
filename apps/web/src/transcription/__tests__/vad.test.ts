import { describe, expect, it } from "bun:test";
import { detectSpeechSlices } from "../vad";

describe("Voice Activity Detection (detectSpeechSlices)", () => {
	const sampleRate = 16000;

	// Helper to create synthetic audio with tone bursts (simulating speech) and silence
	function createSyntheticAudio({
		durationSeconds,
		speechIntervals,
	}: {
		durationSeconds: number;
		speechIntervals: Array<{ start: number; end: number; amplitude?: number }>;
	}): Float32Array {
		const totalSamples = Math.round(durationSeconds * sampleRate);
		const audio = new Float32Array(totalSamples);

		for (const interval of speechIntervals) {
			const startSample = Math.round(interval.start * sampleRate);
			const endSample = Math.min(
				totalSamples,
				Math.round(interval.end * sampleRate),
			);
			const amp = interval.amplitude ?? 0.3;

			for (let i = startSample; i < endSample; i++) {
				// 300Hz tone with some harmonics simulating voiced speech
				const t = (i - startSample) / sampleRate;
				audio[i] =
					amp *
					(0.7 * Math.sin(2 * Math.PI * 300 * t) +
						0.3 * Math.sin(2 * Math.PI * 600 * t));
			}
		}

		return audio;
	}

	it("should return an empty array for pure silence or empty audio", () => {
		const emptyAudio = new Float32Array(0);
		expect(detectSpeechSlices({ audio: emptyAudio })).toEqual([]);

		const silentAudio = new Float32Array(sampleRate * 5); // 5 seconds of 0.0
		expect(detectSpeechSlices({ audio: silentAudio })).toEqual([]);
	});

	it("should detect two speech bursts separated by a 2-second silence gap", () => {
		// Audio: 10s total
		// Speech 1: 1.0s to 3.0s (2s duration)
		// Silence: 3.0s to 6.0s (3s silence)
		// Speech 2: 6.0s to 8.5s (2.5s duration)
		// Silence: 8.5s to 10.0s
		const audio = createSyntheticAudio({
			durationSeconds: 10.0,
			speechIntervals: [
				{ start: 1.0, end: 3.0 },
				{ start: 6.0, end: 8.5 },
			],
		});

		const slices = detectSpeechSlices({ audio, options: { sampleRate } });

		expect(slices.length).toBe(2);

		// First slice should start around 1.0s (with ~0.15s pre-padding -> ~0.85s)
		expect(slices[0].start).toBeLessThanOrEqual(1.0);
		expect(slices[0].start).toBeGreaterThanOrEqual(0.7);
		// First slice should end around 3.0s (with ~0.15s post-padding -> ~3.15s)
		expect(slices[0].end).toBeGreaterThanOrEqual(3.0);
		expect(slices[0].end).toBeLessThanOrEqual(3.3);

		// Second slice should start around 6.0s (with ~0.15s pre-padding -> ~5.85s)
		expect(slices[1].start).toBeLessThanOrEqual(6.0);
		expect(slices[1].start).toBeGreaterThanOrEqual(5.7);
		expect(slices[1].end).toBeGreaterThanOrEqual(8.5);
		expect(slices[1].end).toBeLessThanOrEqual(8.8);

		// Crucially: Silence between 3.3s and 5.7s must NOT be in any slice!
		expect(slices[1].start).toBeGreaterThan(slices[0].end + 2.0);
	});

	it("should bridge micro-pauses (< 300ms) within the same speech sentence", () => {
		// Speech: 1.0s - 1.5s, pause of 200ms (1.5s - 1.7s), then speech 1.7s - 2.5s
		const audio = createSyntheticAudio({
			durationSeconds: 5.0,
			speechIntervals: [
				{ start: 1.0, end: 1.5 },
				{ start: 1.7, end: 2.5 },
			],
		});

		const slices = detectSpeechSlices({ audio, options: { sampleRate } });

		// Should be merged into a single coherent sentence slice
		expect(slices.length).toBe(1);
		expect(slices[0].start).toBeLessThanOrEqual(1.0);
		expect(slices[0].end).toBeGreaterThanOrEqual(2.5);
	});

	it("should ensure every slice audio is padded to at least 2.0s for Whisper model stability", () => {
		// Short speech: 0.5 seconds of speech
		const audio = createSyntheticAudio({
			durationSeconds: 3.0,
			speechIntervals: [{ start: 1.0, end: 1.5 }],
		});

		const slices = detectSpeechSlices({ audio, options: { sampleRate } });

		expect(slices.length).toBe(1);
		// Slice audio length must be at least 2.0s * sampleRate
		expect(slices[0].audio.length).toBeGreaterThanOrEqual(
			Math.round(2.0 * sampleRate),
		);
	});

	it("should split long speech (> 14s) into manageable sub-slices", () => {
		// Continuous speech for 18 seconds
		const audio = createSyntheticAudio({
			durationSeconds: 20.0,
			speechIntervals: [{ start: 1.0, end: 19.0 }],
		});

		const slices = detectSpeechSlices({
			audio,
			options: {
				sampleRate,
				maxSliceDuration: 10.0, // test with 10s max slice
			},
		});

		expect(slices.length).toBeGreaterThanOrEqual(2);
		for (const slice of slices) {
			const dur = slice.end - slice.start;
			expect(dur).toBeLessThanOrEqual(11.0);
		}
	});

	it("should accurately isolate speech boundaries in the presence of continuous background music", () => {
		const totalSamples = 10 * sampleRate;
		const audio = new Float32Array(totalSamples);

		// Continuous background music with low bass & high cymbal frequencies across all 10 seconds
		for (let i = 0; i < totalSamples; i++) {
			const t = i / sampleRate;
			audio[i] =
				0.12 * Math.sin(2 * Math.PI * 80 * t) +
				0.04 * Math.sin(2 * Math.PI * 500 * t) +
				0.08 * Math.sin(2 * Math.PI * 5000 * t);
		}

		// Speech burst exclusively between 4.0s and 7.0s
		for (
			let i = Math.round(4.0 * sampleRate);
			i < Math.round(7.0 * sampleRate);
			i++
		) {
			const t = i / sampleRate;
			audio[i] +=
				0.25 * Math.sin(2 * Math.PI * 300 * t) +
				0.15 * Math.sin(2 * Math.PI * 800 * t);
		}

		const slices = detectSpeechSlices({ audio, options: { sampleRate } });

		// Must detect speech only around 4.0s - 7.0s and NOT the music intro (0-4s) or outro (7-10s)
		expect(slices.length).toBe(1);
		// With 0.15s safety padding: start should be around 3.85s (NOT 0.0s!)
		expect(slices[0].start).toBeGreaterThanOrEqual(3.7);
		expect(slices[0].start).toBeLessThanOrEqual(4.1);

		// End should be around 7.15s (NOT 10.0s!)
		expect(slices[0].end).toBeGreaterThanOrEqual(6.9);
		expect(slices[0].end).toBeLessThanOrEqual(7.3);
	});
});
