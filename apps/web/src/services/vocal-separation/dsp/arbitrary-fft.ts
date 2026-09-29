import { FastFourierTransform } from "./fft";

/**
 * Arbitrary-length FFT implementation using Bluestein's Chirp Z-Transform.
 * Enables arbitrary non-power-of-two FFT sizes (such as N = 7680 for MDX-Net)
 * by converting the transform into a circular convolution solved via power-of-two Radix-2 FFT.
 */
export class ArbitraryFFT {
	readonly n: number;
	readonly m: number; // Next power of 2 >= 2*n - 1
	private readonly fftM: FastFourierTransform;
	private readonly bkReal: Float32Array;
	private readonly bkImag: Float32Array;
	private readonly bFftReal: Float32Array;
	private readonly bFftImag: Float32Array;

	// Preallocated buffers for scratch convolution to avoid garbage collection
	private readonly aReal: Float32Array;
	private readonly aImag: Float32Array;

	constructor(n: number) {
		this.n = n;

		// Find next power of 2 >= 2*n - 1
		let m = 1;
		while (m < 2 * n - 1) {
			m <<= 1;
		}
		this.m = m;
		this.fftM = new FastFourierTransform(m);

		this.aReal = new Float32Array(m);
		this.aImag = new Float32Array(m);

		this.bkReal = new Float32Array(n);
		this.bkImag = new Float32Array(n);

		// Precompute chirp factors w[k] = exp(-i * pi * k^2 / n)
		for (let k = 0; k < n; k++) {
			const angle = (-Math.PI * (k * k)) / n;
			this.bkReal[k] = Math.cos(angle);
			this.bkImag[k] = Math.sin(angle);
		}

		// Sequence b[k] = exp(i * pi * k^2 / n) = conjugate(w[k])
		const bReal = new Float32Array(m);
		const bImag = new Float32Array(m);
		bReal[0] = this.bkReal[0];
		bImag[0] = -this.bkImag[0];

		for (let k = 1; k < n; k++) {
			const r = this.bkReal[k];
			const im = -this.bkImag[k];
			bReal[k] = r;
			bImag[k] = im;
			bReal[m - k] = r;
			bImag[m - k] = im;
		}

		// Precompute FFT of b
		this.bFftReal = new Float32Array(bReal);
		this.bFftImag = new Float32Array(bImag);
		this.fftM.forward(this.bFftReal, this.bFftImag);
	}

	/**
	 * Compute forward FFT of length N in-place.
	 */
	forward(real: Float32Array, imag: Float32Array): void {
		const m = this.m;
		const n = this.n;
		const aReal = this.aReal;
		const aImag = this.aImag;

		aReal.fill(0);
		aImag.fill(0);

		// a[k] = x[k] * w[k]
		for (let k = 0; k < n; k++) {
			const xr = real[k];
			const xi = imag[k];
			const wr = this.bkReal[k];
			const wi = this.bkImag[k];
			aReal[k] = xr * wr - xi * wi;
			aImag[k] = xr * wi + xi * wr;
		}

		// Forward FFT of size M
		this.fftM.forward(aReal, aImag);

		// Pointwise complex multiplication: C = FFT(a) * FFT(b)
		const bReal = this.bFftReal;
		const bImag = this.bFftImag;
		for (let i = 0; i < m; i++) {
			const ar = aReal[i];
			const ai = aImag[i];
			const br = bReal[i];
			const bi = bImag[i];
			aReal[i] = ar * br - ai * bi;
			aImag[i] = ar * bi + ai * br;
		}

		// Inverse FFT of size M
		this.fftM.inverse(aReal, aImag);

		// Post-multiply by w[k]: y[k] = C[k] * w[k]
		for (let k = 0; k < n; k++) {
			const cr = aReal[k];
			const ci = aImag[k];
			const wr = this.bkReal[k];
			const wi = this.bkImag[k];
			real[k] = cr * wr - ci * wi;
			imag[k] = cr * wi + ci * wr;
		}
	}

	/**
	 * Compute inverse FFT of length N in-place.
	 */
	inverse(real: Float32Array, imag: Float32Array): void {
		const n = this.n;

		// Conjugate input
		for (let i = 0; i < n; i++) {
			imag[i] = -imag[i];
		}

		// Forward transform
		this.forward(real, imag);

		// Conjugate and normalize by 1/N
		const invN = 1 / n;
		for (let i = 0; i < n; i++) {
			real[i] *= invN;
			imag[i] = -imag[i] * invN;
		}
	}
}
