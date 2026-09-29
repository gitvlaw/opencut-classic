/**
 * High-performance Radix-2 / Radix-4 Fast Fourier Transform (FFT)
 * Optimized for Float32Array typed arrays with precomputed twiddle factors.
 */

export class FastFourierTransform {
	readonly size: number;
	private readonly cosTable: Float32Array;
	private readonly sinTable: Float32Array;
	private readonly bitRev: Uint32Array;

	constructor(size = 2048) {
		if ((size & (size - 1)) !== 0) {
			throw new Error("FFT size must be a power of 2");
		}
		this.size = size;

		// Precompute twiddle factors
		const halfSize = size >> 1;
		this.cosTable = new Float32Array(halfSize);
		this.sinTable = new Float32Array(halfSize);
		for (let i = 0; i < halfSize; i++) {
			const angle = (-2 * Math.PI * i) / size;
			this.cosTable[i] = Math.cos(angle);
			this.sinTable[i] = Math.sin(angle);
		}

		// Precompute bit-reversal permutation
		this.bitRev = new Uint32Array(size);
		const bits = Math.round(Math.log2(size));
		for (let i = 0; i < size; i++) {
			let rev = 0;
			for (let j = 0; j < bits; j++) {
				rev = (rev << 1) | ((i >> j) & 1);
			}
			this.bitRev[i] = rev;
		}
	}

	/**
	 * In-place forward FFT: transforms real and imag Float32Arrays
	 */
	forward(real: Float32Array, imag: Float32Array): void {
		const n = this.size;
		const bitRev = this.bitRev;

		// Bit-reversal permutation
		for (let i = 0; i < n; i++) {
			const j = bitRev[i];
			if (i < j) {
				const tempR = real[i];
				real[i] = real[j];
				real[j] = tempR;

				const tempI = imag[i];
				imag[i] = imag[j];
				imag[j] = tempI;
			}
		}

		// Cooley-Tukey Radix-2 decimation-in-time
		const cos = this.cosTable;
		const sin = this.sinTable;

		for (let len = 2; len <= n; len <<= 1) {
			const halfLen = len >> 1;
			const step = n / len;

			for (let i = 0; i < n; i += len) {
				let k = 0;
				for (let j = 0; j < halfLen; j++) {
					const c = cos[k];
					const s = sin[k];
					k += step;

					const uR = real[i + j];
					const uI = imag[i + j];

					const vR = real[i + j + halfLen] * c - imag[i + j + halfLen] * s;
					const vI = real[i + j + halfLen] * s + imag[i + j + halfLen] * c;

					real[i + j] = uR + vR;
					imag[i + j] = uI + vI;

					real[i + j + halfLen] = uR - vR;
					imag[i + j + halfLen] = uI - vI;
				}
			}
		}
	}

	/**
	 * In-place inverse FFT (iFFT)
	 */
	inverse(real: Float32Array, imag: Float32Array): void {
		const n = this.size;

		// Conjugate input
		for (let i = 0; i < n; i++) {
			imag[i] = -imag[i];
		}

		// Forward FFT
		this.forward(real, imag);

		// Conjugate and scale output
		const invN = 1 / n;
		for (let i = 0; i < n; i++) {
			real[i] *= invN;
			imag[i] = -imag[i] * invN;
		}
	}
}
