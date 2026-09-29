/**
 * High-performance 16-bit Stereo PCM WAV encoder.
 * Converts Float32Array left and right channels into a downloadable/storable WAV Blob.
 */
export function encodeStereoWavBlob(
	leftChannel: Float32Array,
	rightChannel: Float32Array,
	sampleRate = 44100,
): Blob {
	const numSamples = Math.min(leftChannel.length, rightChannel.length);
	const numChannels = 2;
	const bytesPerSample = 2; // 16-bit PCM
	const blockAlign = numChannels * bytesPerSample; // 4 bytes
	const byteRate = sampleRate * blockAlign;
	const dataByteLength = numSamples * blockAlign;
	const buffer = new ArrayBuffer(44 + dataByteLength);
	const view = new DataView(buffer);

	// Helper to write ASCII strings
	const writeString = (offset: number, str: string) => {
		for (let i = 0; i < str.length; i++) {
			view.setUint8(offset + i, str.charCodeAt(i));
		}
	};

	// 1. RIFF chunk descriptor
	writeString(0, "RIFF");
	view.setUint32(4, 36 + dataByteLength, true); // ChunkSize
	writeString(8, "WAVE");

	// 2. "fmt " sub-chunk
	writeString(12, "fmt ");
	view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
	view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, 16, true); // BitsPerSample

	// 3. "data" sub-chunk
	writeString(36, "data");
	view.setUint32(40, dataByteLength, true);

	// 4. Interleaved 16-bit PCM sample data
	let offset = 44;
	for (let i = 0; i < numSamples; i++) {
		// Left channel
		const l = leftChannel[i];
		const clampedL = l < -1 ? -1 : l > 1 ? 1 : l;
		const intL = clampedL < 0 ? clampedL * 32768 : clampedL * 32767;
		view.setInt16(offset, Math.round(intL), true);
		offset += 2;

		// Right channel
		const r = rightChannel[i];
		const clampedR = r < -1 ? -1 : r > 1 ? 1 : r;
		const intR = clampedR < 0 ? clampedR * 32768 : clampedR * 32767;
		view.setInt16(offset, Math.round(intR), true);
		offset += 2;
	}

	return new Blob([buffer], { type: "audio/wav" });
}
