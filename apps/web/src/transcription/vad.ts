import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "./audio";

export interface SpeechSlice {
	/** Start time of speech in seconds on original audio */
	start: number;
	/** End time of speech in seconds on original audio */
	end: number;
	/** Audio PCM data of the slice (minimum 2.0s padded with trailing silence for Whisper stability) */
	audio: Float32Array;
}

export interface VadOptions {
	sampleRate?: number;
	/** Frame duration in seconds for energy calculation (default: 0.025s = 25ms) */
	frameDuration?: number;
	/** Hop duration in seconds between consecutive frames (default: 0.010s = 10ms) */
	hopDuration?: number;
	/** Minimum duration of speech to be considered valid (default: 0.20s = 200ms) */
	minSpeechDuration?: number;
	/** Minimum silence duration to trigger a segment cut (default: 0.40s = 400ms) */
	minSilenceDuration?: number;
	/** Safety padding before speech onset in seconds (default: 0.15s = 150ms) */
	prePadDuration?: number;
	/** Safety padding after speech offset in seconds (default: 0.15s = 150ms) */
	postPadDuration?: number;
	/** Maximum slice duration in seconds before splitting at the quietest breath dip (default: 14.0s) */
	maxSliceDuration?: number;
	/** Minimum slice duration in seconds padded with zeros for Whisper model stability (default: 2.0s) */
	minSliceDuration?: number;
}

/**
 * Fast IIR cascade (High-pass 200Hz + Low-pass 3400Hz) to isolate human voice formants
 * and eliminate background music bass, kick drums, sub-rumble, and cymbal sizzle.
 */
function applySpeechBandpass({
	samples,
	sampleRate,
}: {
	samples: Float32Array;
	sampleRate: number;
}): Float32Array {
	const n = samples.length;
	const filtered = new Float32Array(n);
	const hpAlpha = 1 / (1 + (2 * Math.PI * 200) / sampleRate);
	const lpAlpha =
		(2 * Math.PI * 3400) / sampleRate / (1 + (2 * Math.PI * 3400) / sampleRate);

	let hpXPrev = 0;
	let hpYPrev = 0;
	let lpYPrev = 0;

	for (let i = 0; i < n; i++) {
		const x = samples[i];
		const hpY = hpAlpha * (hpYPrev + x - hpXPrev);
		hpXPrev = x;
		hpYPrev = hpY;
		const lpY = lpYPrev + lpAlpha * (hpY - lpYPrev);
		lpYPrev = lpY;
		filtered[i] = lpY;
	}
	return filtered;
}

/**
 * High-performance Voice Activity Detector (VAD) that analyzes 16kHz mono audio,
 * isolates speech formants away from background music, detects active speech regions,
 * and slices audio into coherent, bounded phrases.
 * Runs in < 2ms for 1 minute of audio.
 */
export function detectSpeechSlices({
	audio,
	options = {},
}: {
	audio: Float32Array;
	options?: VadOptions;
}): SpeechSlice[] {
	if (!audio || audio.length === 0) {
		return [];
	}

	const sampleRate = options.sampleRate ?? DEFAULT_TRANSCRIPTION_SAMPLE_RATE;
	const frameSize = Math.max(
		16,
		Math.floor(sampleRate * (options.frameDuration ?? 0.025)),
	);
	const hopSize = Math.max(
		8,
		Math.floor(sampleRate * (options.hopDuration ?? 0.01)),
	);
	const minSpeechSec = options.minSpeechDuration ?? 0.2;
	const minSilenceSec = options.minSilenceDuration ?? 0.4;
	const prePadSec = options.prePadDuration ?? 0.15;
	const postPadSec = options.postPadDuration ?? 0.15;
	const maxSliceSec = options.maxSliceDuration ?? 14.0;
	const minSliceSec = options.minSliceDuration ?? 2.0;

	const numFrames =
		Math.floor(Math.max(0, audio.length - frameSize) / hopSize) + 1;
	if (numFrames <= 0) {
		return [];
	}

	// 1. Isolate speech frequency band (200Hz - 3400Hz) to reject background music drums & sizzle
	const speechBandAudio = applySpeechBandpass({ samples: audio, sampleRate });

	// Calculate Root-Mean-Square (RMS) energy per frame
	const energies = new Float32Array(numFrames);
	let maxEnergy = 0;
	let minEnergy = Infinity;

	for (let f = 0; f < numFrames; f++) {
		const offset = f * hopSize;
		let sumSq = 0;
		for (let i = 0; i < frameSize; i++) {
			const s = speechBandAudio[offset + i];
			sumSq += s * s;
		}
		const rms = Math.sqrt(sumSq / frameSize);
		energies[f] = rms;
		if (rms > maxEnergy) maxEnergy = rms;
		if (rms < minEnergy) minEnergy = rms;
	}

	// Digital silence check: if audio is completely flat, no speech exists
	if (maxEnergy < 0.005) {
		return [];
	}

	// 2. Compute Adaptive Speech Threshold using energy percentiles
	const sortedEnergies = new Float32Array(energies).sort();
	const noiseFloorIdx = Math.floor(numFrames * 0.1); // 10th percentile for background floor (silence or music bed)
	const speechPeakIdx = Math.floor(numFrames * 0.9);
	const noiseFloor = sortedEnergies[noiseFloorIdx];
	const speechPeak = sortedEnergies[speechPeakIdx];

	// Check contrast between speech peak and background floor
	const contrast = speechPeak / Math.max(1e-5, noiseFloor);
	if (contrast < 1.3 && speechPeak < 0.03) {
		// Pure steady music or steady ambient noise with no distinct speech bursts
		return [];
	}

	// Threshold: positioned cleanly between background music floor and speech peak
	const adaptiveThreshold = Math.max(
		0.008,
		noiseFloor + 0.28 * (speechPeak - noiseFloor),
	);

	// 3. Frame classification (Speech vs Silence/Music)
	const isSpeech = new Uint8Array(numFrames);
	for (let f = 0; f < numFrames; f++) {
		if (energies[f] >= adaptiveThreshold) {
			isSpeech[f] = 1;
		}
	}

	// 4. Temporal State Machine: Group speech frames and bridge micro-pauses
	const minSpeechFrames = Math.max(
		1,
		Math.round(minSpeechSec / (hopSize / sampleRate)),
	);
	const minSilenceFrames = Math.max(
		1,
		Math.round(minSilenceSec / (hopSize / sampleRate)),
	);

	interface RawInterval {
		startFrame: number;
		endFrame: number;
	}
	const intervals: RawInterval[] = [];

	let inSpeech = false;
	let currentStartFrame = 0;
	let silenceCount = 0;
	let lastSpeechFrame = 0;

	for (let f = 0; f < numFrames; f++) {
		if (isSpeech[f]) {
			if (!inSpeech) {
				inSpeech = true;
				currentStartFrame = f;
			}
			lastSpeechFrame = f;
			silenceCount = 0;
		} else {
			if (inSpeech) {
				silenceCount++;
				if (silenceCount >= minSilenceFrames) {
					// Confirmed end of speech segment
					const speechDurationFrames = lastSpeechFrame - currentStartFrame + 1;
					if (speechDurationFrames >= minSpeechFrames) {
						intervals.push({
							startFrame: currentStartFrame,
							endFrame: lastSpeechFrame,
						});
					}
					inSpeech = false;
					silenceCount = 0;
				}
			}
		}
	}

	// Flush trailing speech if any
	if (inSpeech) {
		const speechDurationFrames = lastSpeechFrame - currentStartFrame + 1;
		if (speechDurationFrames >= minSpeechFrames) {
			intervals.push({
				startFrame: currentStartFrame,
				endFrame: lastSpeechFrame,
			});
		}
	}

	if (intervals.length === 0) {
		return [];
	}

	// 5. Expand intervals with pre/post safety padding & merge overlapping intervals
	const prePadSamples = Math.round(prePadSec * sampleRate);
	const postPadSamples = Math.round(postPadSec * sampleRate);
	const totalSamples = audio.length;

	interface TimeInterval {
		startSample: number;
		endSample: number;
		actualSpeechStartSec: number;
		actualSpeechEndSec: number;
	}

	const timeIntervals: TimeInterval[] = [];
	for (const interval of intervals) {
		const rawStartSample = interval.startFrame * hopSize;
		const rawEndSample = Math.min(
			totalSamples,
			interval.endFrame * hopSize + frameSize,
		);

		const actualSpeechStartSec = rawStartSample / sampleRate;
		const actualSpeechEndSec = rawEndSample / sampleRate;

		const startSample = Math.max(0, rawStartSample - prePadSamples);
		const endSample = Math.min(totalSamples, rawEndSample + postPadSamples);

		const prev = timeIntervals[timeIntervals.length - 1];
		if (prev && startSample <= prev.endSample) {
			// Merge adjacent or overlapping intervals
			prev.endSample = Math.max(prev.endSample, endSample);
			prev.actualSpeechEndSec = Math.max(
				prev.actualSpeechEndSec,
				actualSpeechEndSec,
			);
		} else {
			timeIntervals.push({
				startSample,
				endSample,
				actualSpeechStartSec,
				actualSpeechEndSec,
			});
		}
	}

	// 6. Split long intervals exceeding maxSliceDuration at lowest energy frame
	const maxSliceSamples = Math.round(maxSliceSec * sampleRate);
	const finalIntervals: TimeInterval[] = [];

	for (const interval of timeIntervals) {
		let currentStart = interval.startSample;
		const totalEnd = interval.endSample;

		while (totalEnd - currentStart > maxSliceSamples) {
			// Find lowest energy point between 60% and 90% of maxSlice
			const searchStartSample =
				currentStart + Math.round(maxSliceSamples * 0.6);
			const searchEndSample = currentStart + Math.round(maxSliceSamples * 0.95);

			const searchStartFrame = Math.max(
				0,
				Math.floor(searchStartSample / hopSize),
			);
			const searchEndFrame = Math.min(
				numFrames - 1,
				Math.floor(searchEndSample / hopSize),
			);

			let minEnergyVal = Infinity;
			let bestSplitFrame = searchStartFrame;

			for (let f = searchStartFrame; f <= searchEndFrame; f++) {
				if (energies[f] < minEnergyVal) {
					minEnergyVal = energies[f];
					bestSplitFrame = f;
				}
			}

			const splitSample = Math.min(
				totalEnd,
				bestSplitFrame * hopSize + Math.floor(frameSize / 2),
			);
			finalIntervals.push({
				startSample: currentStart,
				endSample: splitSample,
				actualSpeechStartSec: currentStart / sampleRate,
				actualSpeechEndSec: splitSample / sampleRate,
			});

			currentStart = splitSample;
		}

		if (totalEnd - currentStart > 0) {
			finalIntervals.push({
				startSample: currentStart,
				endSample: totalEnd,
				actualSpeechStartSec: currentStart / sampleRate,
				actualSpeechEndSec: totalEnd / sampleRate,
			});
		}
	}

	// 7. Produce SpeechSlice objects with minimum slice duration padding
	const minSliceSamples = Math.round(minSliceSec * sampleRate);
	const slices: SpeechSlice[] = [];

	for (const interval of finalIntervals) {
		const rawSliceLength = interval.endSample - interval.startSample;
		if (rawSliceLength <= 0) continue;

		const startSec =
			Math.round((interval.startSample / sampleRate) * 100) / 100;
		const endSec = Math.round((interval.endSample / sampleRate) * 100) / 100;

		let sliceData: Float32Array;
		if (rawSliceLength < minSliceSamples) {
			// Pad with trailing zeros to reach minSliceDuration for Whisper model stability
			sliceData = new Float32Array(minSliceSamples);
			sliceData.set(audio.subarray(interval.startSample, interval.endSample));
		} else {
			sliceData = audio.slice(interval.startSample, interval.endSample);
		}

		slices.push({
			start: startSec,
			end: endSec,
			audio: sliceData,
		});
	}

	return slices;
}
