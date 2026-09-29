import { ArbitraryFFT } from "./arbitrary-fft";

export interface MDXProcessorOptions {
	nFft?: number;
	hop?: number;
	dimF?: number;
	dimT?: number;
}

/**
 * High-precision STFT & iSTFT Processor for MDX-Net architecture.
 * Exactly matches PyTorch's ConvTDFNetTrim / UVR MDX-Net tensor layouts.
 */
export class MDXProcessor {
	readonly nFft: number;
	readonly hop: number;
	readonly dimF: number;
	readonly dimT: number;
	readonly nBins: number;
	readonly chunkSize: number;

	private readonly fft: ArbitraryFFT;
	private readonly window: Float32Array;

	// Preallocated frame buffers to eliminate GC pauses
	private readonly frameRealL: Float32Array;
	private readonly frameImagL: Float32Array;
	private readonly frameRealR: Float32Array;
	private readonly frameImagR: Float32Array;

	constructor(options: MDXProcessorOptions = {}) {
		this.nFft = options.nFft ?? 7680;
		this.hop = options.hop ?? 1024;
		this.dimF = options.dimF ?? 3072;
		this.dimT = options.dimT ?? 256;
		this.nBins = (this.nFft >> 1) + 1; // 3841 for 7680
		this.chunkSize = this.hop * (this.dimT - 1); // 261,120 samples

		this.fft = new ArbitraryFFT(this.nFft);

		// Periodic Hann window matching torch.hann_window(window_length=n_fft, periodic=True)
		this.window = new Float32Array(this.nFft);
		for (let i = 0; i < this.nFft; i++) {
			this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.nFft));
		}

		this.frameRealL = new Float32Array(this.nFft);
		this.frameImagL = new Float32Array(this.nFft);
		this.frameRealR = new Float32Array(this.nFft);
		this.frameImagR = new Float32Array(this.nFft);
	}

	/**
	 * Compute STFT of a 2-channel chunk and pack into MDX-Net ONNX input tensor:
	 * Shape [1, 4, dimF, dimT]
	 * Channel 0: Left real
	 * Channel 1: Left imag
	 * Channel 2: Right real
	 * Channel 3: Right imag
	 */
	stft(chunkL: Float32Array, chunkR: Float32Array): Float32Array {
		const tensorData = new Float32Array(1 * 4 * this.dimF * this.dimT);
		const halfN = this.nFft >> 1; // 3840 (for center=True padding)
		const window = this.window;
		const nFft = this.nFft;
		const dimF = this.dimF;
		const dimT = this.dimT;
		const chunkSize = this.chunkSize;

		const frameRL = this.frameRealL;
		const frameIL = this.frameImagL;
		const frameRR = this.frameRealR;
		const frameIR = this.frameImagR;

		for (let t = 0; t < dimT; t++) {
			const frameStart = t * this.hop - halfN;

			frameRL.fill(0);
			frameIL.fill(0);
			frameRR.fill(0);
			frameIR.fill(0);

			for (let i = 0; i < nFft; i++) {
				const idx = frameStart + i;
				if (idx >= 0 && idx < chunkSize) {
					const w = window[i];
					frameRL[i] = chunkL[idx] * w;
					frameRR[i] = chunkR[idx] * w;
				}
			}

			this.fft.forward(frameRL, frameIL);
			this.fft.forward(frameRR, frameIR);

			for (let f = 0; f < dimF; f++) {
				const base = f * dimT + t;
				tensorData[0 * dimF * dimT + base] = frameRL[f];
				tensorData[1 * dimF * dimT + base] = frameIL[f];
				tensorData[2 * dimF * dimT + base] = frameRR[f];
				tensorData[3 * dimF * dimT + base] = frameIR[f];
			}
		}

		return tensorData;
	}

	/**
	 * Inverse STFT synthesis: takes MDX-Net output tensor [1, 4, dimF, dimT],
	 * reconstructs full spectrum up to nBins with Hermitian symmetry,
	 * and synthesizes stereo vocal waveform with Hann overlap-add.
	 */
	istft(outTensor: Float32Array): { left: Float32Array; right: Float32Array } {
		const chunkSize = this.chunkSize;
		const vocalL = new Float32Array(chunkSize);
		const vocalR = new Float32Array(chunkSize);
		const normBuffer = new Float32Array(chunkSize);

		const halfN = this.nFft >> 1;
		const nFft = this.nFft;
		const nBins = this.nBins;
		const dimF = this.dimF;
		const dimT = this.dimT;
		const window = this.window;

		const fullRL = this.frameRealL;
		const fullIL = this.frameImagL;
		const fullRR = this.frameRealR;
		const fullIR = this.frameImagR;

		for (let t = 0; t < dimT; t++) {
			const frameStart = t * this.hop - halfN;

			fullRL.fill(0);
			fullIL.fill(0);
			fullRR.fill(0);
			fullIR.fill(0);

			// Copy model frequency bins [0 .. dimF-1]
			for (let f = 0; f < dimF; f++) {
				const base = f * dimT + t;
				fullRL[f] = outTensor[0 * dimF * dimT + base];
				fullIL[f] = outTensor[1 * dimF * dimT + base];
				fullRR[f] = outTensor[2 * dimF * dimT + base];
				fullIR[f] = outTensor[3 * dimF * dimT + base];
			}

			// Higher frequencies [dimF .. nBins-1] remain 0 (freq_pad in PyTorch)

			// Hermitian symmetry for real signal iFFT
			for (let k = 1; k < nBins - 1; k++) {
				const mirror = nFft - k;
				fullRL[mirror] = fullRL[k];
				fullIL[mirror] = -fullIL[k];
				fullRR[mirror] = fullRR[k];
				fullIR[mirror] = -fullIR[k];
			}

			this.fft.inverse(fullRL, fullIL);
			this.fft.inverse(fullRR, fullIR);

			for (let i = 0; i < nFft; i++) {
				const idx = frameStart + i;
				if (idx >= 0 && idx < chunkSize) {
					const w = window[i];
					vocalL[idx] += fullRL[i] * w;
					vocalR[idx] += fullRR[i] * w;
					normBuffer[idx] += w * w;
				}
			}
		}

		// Overlap-add window power normalization
		for (let i = 0; i < chunkSize; i++) {
			const norm = normBuffer[i];
			if (norm > 1e-4) {
				vocalL[i] /= norm;
				vocalR[i] /= norm;
			}
		}

		return { left: vocalL, right: vocalR };
	}
}
