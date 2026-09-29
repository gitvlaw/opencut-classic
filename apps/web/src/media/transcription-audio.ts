import {
	collectAudioElements,
	createAudioContext,
} from "@/media/audio";
import { TICKS_PER_SECOND } from "@/wasm";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { getSourceTimeAtClipTime } from "@/retime";
import type { SceneTracks, TimelineElement } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { canElementHaveAudio } from "@/timeline/element-utils";

export interface SelectedClipAudioInfo {
	audioData: Float32Array;
	clipStartTime: number; // in seconds
	retimeRate: number;    // playback rate (e.g. 1.0, 1.5)
	elementId: string;
	clipDuration: number;  // in seconds
}

export interface TimelineAudioInfo {
	audioData: Float32Array;
	totalDuration: number; // in seconds
}

/**
 * Isolates the human-voice band (200Hz-3400Hz) so bass/drums/sizzle from
 * background music don't fake a voice onset. Fast IIR high-pass +
 * low-pass cascade, same idea as the VAD in `transcription/vad.ts`.
 */
function applyVoiceBand(samples: Float32Array, sampleRate: number): Float32Array {
	const n = samples.length;
	const filtered = new Float32Array(n);
	const hpAlpha = 1 / (1 + (2 * Math.PI * 200) / sampleRate);
	const lpAlpha =
		((2 * Math.PI * 3400) / sampleRate) / (1 + (2 * Math.PI * 3400) / sampleRate);
	let hpXPrev = 0;
	let hpYPrev = 0;
	let lpYPrev = 0;
	for (let i = 0; i < n; i++) {
		const x = samples[i] ?? 0;
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
 * Finds the first voice-like (non-silence) time in 16kHz mono audio.
 * Last-resort floor for the FIRST caption only: Whisper sometimes snaps
 * the first chunk start to 0.0 even with leading music/silence, which
 * would glue caption #1 to the clip head instead of the voice onset.
 * Uses the voice band + a percentile-based threshold so background music
 * beds don't trigger it. Returns seconds in the audioData time base.
 * Prefer real model word timestamps (see worker.ts) over this heuristic.
 */
export function findFirstAudibleTime({
	audioData,
	sampleRate = DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
}: {
	audioData: Float32Array;
	sampleRate?: number;
}): number {
	if (!audioData || audioData.length === 0) return 0;

	const frameSize = Math.max(16, Math.floor(sampleRate * 0.025));
	const hopSize = Math.max(8, Math.floor(sampleRate * 0.01));
	const numFrames = Math.floor((audioData.length - frameSize) / hopSize);
	if (numFrames <= 0) return 0;

	const voiceBand = applyVoiceBand(audioData, sampleRate);

	const energies = new Float32Array(numFrames);
	let peak = 0;
	for (let f = 0; f < numFrames; f++) {
		const offset = f * hopSize;
		let sumSq = 0;
		for (let i = 0; i < frameSize; i++) {
			const s = voiceBand[offset + i] ?? 0;
			sumSq += s * s;
		}
		const rms = Math.sqrt(sumSq / frameSize);
		energies[f] = rms;
		if (rms > peak) peak = rms;
	}

	if (peak < 1e-4) return 0;

	// Percentile-based threshold: sits between the background bed
	// (music/hiss floor) and the voice peak instead of a fixed ratio.
	const sorted = new Float32Array(energies).sort();
	const floor = sorted[Math.floor(numFrames * 0.1)] ?? 0;
	const voicePeak = sorted[Math.floor(numFrames * 0.9)] ?? peak;
	const threshold = Math.max(0.008, floor + 0.28 * (voicePeak - floor));

	// Require sustained voice so a drum hit doesn't count as onset.
	const requiredConsecutive = 5;
	let run = 0;
	for (let f = 0; f < numFrames; f++) {
		if (energies[f] >= threshold) {
			run++;
			if (run >= requiredConsecutive) {
				const firstFrame = f - requiredConsecutive + 1;
				return (firstFrame * hopSize) / sampleRate;
			}
		} else {
			run = 0;
		}
	}
	return 0;
}

/**
 * Extracts a normalized 16kHz mono Float32Array for a single selected clip.
 * The audio is extracted at natural 1.0x rate across its visible source duration
 * so Whisper ASR gets clear, uncompressed speech without pitch or time-stretching artifacts.
 */
export async function extractClipAudioForTranscription({
	element,
	tracks,
	mediaAssets,
	sampleRate = DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
}: {
	element: TimelineElement;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	sampleRate?: number;
}): Promise<SelectedClipAudioInfo | null> {
	if (!canElementHaveAudio(element)) {
		return null;
	}

	const audioContext = createAudioContext({ sampleRate });

	try {
		const collectedElements = await collectAudioElements({
			tracks,
			mediaAssets,
			audioContext,
		});

		const matched = collectedElements.find(
			(collected) => collected.timelineElement.id === element.id,
		);

		if (!matched || !matched.buffer) {
			return null;
		}

		const { buffer, trimStart, duration: timelineDuration, retime } = matched;
		const rate = retime?.rate ?? 1.0;
		const retimeRate = rate > 0 ? rate : 1.0;

		// The natural speech duration in source seconds
		const sourceDuration = timelineDuration * retimeRate;
		const totalSamples = Math.ceil(sourceDuration * sampleRate);

		if (totalSamples <= 0) {
			return null;
		}

		const monoOutput = new Float32Array(totalSamples);
		const sourceSampleRate = buffer.sampleRate;
		const numChannels = buffer.numberOfChannels;

		for (let i = 0; i < totalSamples; i++) {
			const sourceTime = trimStart + i / sampleRate;
			const sourceIndex = sourceTime * sourceSampleRate;

			if (sourceIndex >= buffer.length) break;

			const lowerIndex = Math.floor(sourceIndex);
			const upperIndex = Math.min(buffer.length - 1, lowerIndex + 1);
			const fraction = sourceIndex - lowerIndex;

			let sampleVal = 0;
			for (let ch = 0; ch < numChannels; ch++) {
				const channelData = buffer.getChannelData(ch);
				sampleVal +=
					channelData[lowerIndex] * (1 - fraction) +
					channelData[upperIndex] * fraction;
			}
			monoOutput[i] = sampleVal / numChannels;
		}

		return {
			audioData: monoOutput,
			clipStartTime: element.startTime / TICKS_PER_SECOND,
			clipDuration: timelineDuration,
			retimeRate,
			elementId: element.id,
		};
	} finally {
		if (audioContext.state !== "closed") {
			audioContext.close().catch(() => {});
		}
	}
}

/**
 * Extracts a normalized 16kHz mono Float32Array for the entire active timeline.
 * Directly samples and mixes audio elements without intermediate WAV blobs or mastering compressors.
 */
export async function extractTimelineAudioForTranscription({
	tracks,
	mediaAssets,
	totalDurationTicks,
	sampleRate = DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
	onProgress,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	totalDurationTicks: number;
	sampleRate?: number;
	onProgress?: (progress: number) => void;
}): Promise<TimelineAudioInfo> {
	const durationSeconds = totalDurationTicks / TICKS_PER_SECOND;
	const totalSamples = Math.ceil(durationSeconds * sampleRate);

	if (totalSamples <= 0) {
		return {
			audioData: new Float32Array(0),
			totalDuration: 0,
		};
	}

	onProgress?.(10);

	const audioContext = createAudioContext({ sampleRate });

	try {
		const collectedElements = await collectAudioElements({
			tracks,
			mediaAssets,
			audioContext,
		});

		onProgress?.(30);

		const monoOutput = new Float32Array(totalSamples);

		for (let elemIdx = 0; elemIdx < collectedElements.length; elemIdx++) {
			const elem = collectedElements[elemIdx];
			if (elem.muted || elem.volume <= 0) continue;

			const elemStartSample = Math.floor(elem.startTime * sampleRate);
			const elemLengthSamples = Math.ceil(elem.duration * sampleRate);
			const buffer = elem.buffer;
			const sourceChannels = buffer.numberOfChannels;

			for (let i = 0; i < elemLengthSamples; i++) {
				const outputIndex = elemStartSample + i;
				if (outputIndex >= totalSamples) break;

				const clipTime = i / sampleRate;
				const sourceTime =
					elem.trimStart + getSourceTimeAtClipTime({ clipTime, retime: elem.retime });
				const sourceIndex = sourceTime * buffer.sampleRate;

				if (sourceIndex >= buffer.length) break;

				const lowerIndex = Math.floor(sourceIndex);
				const upperIndex = Math.min(buffer.length - 1, lowerIndex + 1);
				const fraction = sourceIndex - lowerIndex;

				let mixedChannel = 0;
				for (let ch = 0; ch < sourceChannels; ch++) {
					const data = buffer.getChannelData(ch);
					mixedChannel +=
						data[lowerIndex] * (1 - fraction) + data[upperIndex] * fraction;
				}
				monoOutput[outputIndex] += (mixedChannel / sourceChannels) * elem.volume;
			}
		}

		onProgress?.(80);

		// Clamp output to [-1, 1] to prevent clipping
		for (let i = 0; i < totalSamples; i++) {
			const val = monoOutput[i];
			if (val > 1) monoOutput[i] = 1;
			else if (val < -1) monoOutput[i] = -1;
		}

		onProgress?.(100);

		return {
			audioData: monoOutput,
			totalDuration: durationSeconds,
		};
	} finally {
		if (audioContext.state !== "closed") {
			audioContext.close().catch(() => {});
		}
	}
}
