import { FastFourierTransform } from "./fft";

export interface STFTOptions {
	fftSize?: number;
	hopSize?: number;
}

export interface Spectrogram {
	numFrames: number;
	numBins: number;
	real: Float32Array; // Flattened [numFrames * numBins]
	imag: Float32Array; // Flattened [numFrames * numBins]
	mag: Float32Array;  // Flattened [numFrames * numBins]
}

/**
 * Short-Time Fourier Transform (STFT) and Inverse STFT (iSTFT)
 * with single-target Wiener power ratio masking.
 */
export class STFTProcessor {
	readonly fftSize: number;
	readonly hopSize: number;
	readonly numBins: number;
	private readonly fft: FastFourierTransform;
	private readonly window: Float32Array;
	private readonly windowSquaredSum: number;

	constructor(options: STFTOptions = {}) {
		this.fftSize = options.fftSize ?? 2048;
		this.hopSize = options.hopSize ?? 512;
		this.numBins = (this.fftSize >> 1) + 1; // 1025 for 2048
		this.fft = new FastFourierTransform(this.fftSize);

		// Periodic Hann window (divisor is fftSize, matching PyTorch / DSP standards)
		this.window = new Float32Array(this.fftSize);
		let sumSq = 0;
		for (let i = 0; i < this.fftSize; i++) {
			const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.fftSize));
			this.window[i] = w;
			sumSq += w * w;
		}
		// For Hann with 75% overlap (hop = fftSize / 4), OLA window squared sum is (fftSize / hopSize) * 3/8 = 1.5
		this.windowSquaredSum = sumSq / this.hopSize;
	}

	/**
	 * Compute STFT of 1D audio channel.
	 */
	stft(signal: Float32Array): Spectrogram {
		const signalLen = signal.length;
		const numFrames = Math.floor((signalLen - this.fftSize) / this.hopSize) + 1;
		if (numFrames <= 0) {
			throw new Error(
				`Signal length (${signalLen}) is shorter than FFT size (${this.fftSize})`,
			);
		}

		const totalElements = numFrames * this.numBins;
		const outReal = new Float32Array(totalElements);
		const outImag = new Float32Array(totalElements);
		const outMag = new Float32Array(totalElements);

		const frameReal = new Float32Array(this.fftSize);
		const frameImag = new Float32Array(this.fftSize);

		for (let f = 0; f < numFrames; f++) {
			const start = f * this.hopSize;

			// Windowed frame
			for (let i = 0; i < this.fftSize; i++) {
				frameReal[i] = signal[start + i] * this.window[i];
				frameImag[i] = 0;
			}

			// Forward FFT
			this.fft.forward(frameReal, frameImag);

			const frameOffset = f * this.numBins;
			for (let k = 0; k < this.numBins; k++) {
				const r = frameReal[k];
				const im = frameImag[k];
				const idx = frameOffset + k;
				outReal[idx] = r;
				outImag[idx] = im;
				outMag[idx] = Math.sqrt(r * r + im * im);
			}
		}

		return {
			numFrames,
			numBins: this.numBins,
			real: outReal,
			imag: outImag,
			mag: outMag,
		};
	}

	/**
	 * Inverse STFT (iSTFT) to reconstruct time-domain audio.
	 */
	istft(spec: {
		real: Float32Array;
		imag: Float32Array;
		numFrames: number;
		outputLength?: number;
	}): Float32Array {
		const { real, imag, numFrames } = spec;
		const outputLength =
			spec.outputLength ??
			Math.max(0, (numFrames - 1) * this.hopSize + this.fftSize);
		const output = new Float32Array(outputLength);
		const normBuffer = new Float32Array(outputLength);

		const frameReal = new Float32Array(this.fftSize);
		const frameImag = new Float32Array(this.fftSize);

		for (let f = 0; f < numFrames; f++) {
			const frameOffset = f * this.numBins;

			// Reconstruct full spectrum with Hermitian symmetry
			for (let k = 0; k < this.numBins; k++) {
				const idx = frameOffset + k;
				frameReal[k] = real[idx];
				frameImag[k] = imag[idx];
			}

			for (let k = 1; k < this.fftSize - this.numBins + 1; k++) {
				frameReal[this.fftSize - k] = frameReal[k];
				frameImag[this.fftSize - k] = -frameImag[k];
			}

			// Inverse FFT
			this.fft.inverse(frameReal, frameImag);

			const start = f * this.hopSize;
			for (let i = 0; i < this.fftSize; i++) {
				const outIdx = start + i;
				if (outIdx < outputLength) {
					const w = this.window[i];
					output[outIdx] += frameReal[i] * w;
					normBuffer[outIdx] += w * w;
				}
			}
		}

		// Overlap-Add normalization
		for (let i = 0; i < outputLength; i++) {
			const norm = normBuffer[i];
			if (norm > 1e-4) {
				output[i] /= norm;
			}
		}

		return output;
	}

	/**
	 * Apply Wiener Power Ratio Masking:
	 * M_v = clamp(estimatedVocalMag / (|Mix| + eps), 0, 1)
	 * M_i = 1 - M_v
	 * Returns masked complex spectrograms for vocals and instrumental.
	 */
	applyPowerRatioMask(
		mix: Spectrogram,
		estimatedVocalMag: Float32Array,
		eps = 1e-7,
	): {
		vocals: { real: Float32Array; imag: Float32Array };
		instrumental: { real: Float32Array; imag: Float32Array };
	} {
		const total = mix.real.length;
		const vReal = new Float32Array(total);
		const vImag = new Float32Array(total);
		const iReal = new Float32Array(total);
		const iImag = new Float32Array(total);

		for (let i = 0; i < total; i++) {
			const mixMag = mix.mag[i];
			const estVMag = estimatedVocalMag[i] ?? 0;

			// Soft ratio mask: M_v bounded in [0, 1]
			let mv = estVMag / (mixMag + eps);
			if (mv < 0) mv = 0;
			else if (mv > 1) mv = 1;

			const mi = 1.0 - mv;

			const mr = mix.real[i];
			const mim = mix.imag[i];

			vReal[i] = mr * mv;
			vImag[i] = mim * mv;

			iReal[i] = mr * mi;
			iImag[i] = mim * mi;
		}

		return {
			vocals: { real: vReal, imag: vImag },
			instrumental: { real: iReal, imag: iImag },
		};
	}
}
