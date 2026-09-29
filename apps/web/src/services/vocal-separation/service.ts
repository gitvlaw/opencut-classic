import { encodeStereoWavBlob } from "./dsp/wav";
import type {
	SeparationMode,
	VocalSeparationOptions,
	VocalSeparationProgress,
	VocalSeparationResult,
	WorkerInboundMessage,
	WorkerOutboundMessage,
} from "./types";

export class VocalSeparationService {
	private worker: Worker | null = null;
	private activeAbortController: AbortController | null = null;
	private isProcessing = false;

	/**
	 * Separate vocal and instrumental tracks from audio channels
	 */
	async separateAudio({
		leftChannel,
		rightChannel,
		sampleRate = 44100,
		options,
	}: {
		leftChannel: Float32Array;
		rightChannel: Float32Array;
		sampleRate?: number;
		options: VocalSeparationOptions;
	}): Promise<VocalSeparationResult> {
		if (this.isProcessing) {
			throw new Error("A separation process is already in progress");
		}

		this.isProcessing = true;
		this.activeAbortController = new AbortController();

		if (options.signal) {
			options.signal.addEventListener("abort", () => {
				this.cancel();
			});
		}

		try {
			const worker = this.getOrCreateWorker();

			return await new Promise<VocalSeparationResult>((resolve, reject) => {
				const cleanup = () => {
					this.isProcessing = false;
					this.activeAbortController = null;
				};

				const handleWorkerMessage = (event: MessageEvent<WorkerOutboundMessage>) => {
					const msg = event.data;

					switch (msg.type) {
						case "init_progress":
							options.onProgress?.({
								phase: "downloading",
								progress: Math.round(msg.percentage * 0.3), // 0% - 30%
								message: `Đang tải mô hình AI tách giọng (${msg.percentage}%)...`,
								loadedBytes: msg.loaded,
								totalBytes: msg.total,
							});
							break;

						case "init_complete": {
							const providerName =
								msg.executionProvider === "dsp"
									? "Bộ lọc DSP Spectral Panning"
									: msg.executionProvider === "webgpu"
										? "AI UVR MDX-Net (WebGPU tăng tốc)"
										: "AI UVR MDX-Net (WebAssembly)";
							options.onProgress?.({
								phase: "processing",
								progress: 30,
								message: `Động cơ tách âm thanh đã sẵn sàng (${providerName}). Bắt đầu tách...`,
							});

							// Model initialized, now send audio for processing
							// Transfer copies to avoid detaching caller's buffers
							const lCopy = new Float32Array(leftChannel);
							const rCopy = new Float32Array(rightChannel);
							worker.postMessage(
								{
									type: "process",
									leftChannel: lCopy,
									rightChannel: rCopy,
									sampleRate,
									mode: options.mode,
								} satisfies WorkerInboundMessage,
								[lCopy.buffer, rCopy.buffer],
							);
							break;
						}

						case "process_progress":
							options.onProgress?.({
								phase: "processing",
								progress: 30 + Math.round(msg.percentage * 0.6), // 30% - 90%
								message: `Đang phân tách âm thanh... (${msg.currentChunk}/${msg.totalChunks} đoạn)`,
							});
							break;

						case "process_complete":
							worker.removeEventListener("message", handleWorkerMessage);
							options.onProgress?.({
								phase: "encoding",
								progress: 95,
								message: "Đang đóng gói file WAV 16-bit stereo...",
							});

							let vocalsBlob: Blob | undefined;
							let instrumentalBlob: Blob | undefined;

							if (msg.vocalsLeft && msg.vocalsRight) {
								vocalsBlob = encodeStereoWavBlob(
									msg.vocalsLeft,
									msg.vocalsRight,
									sampleRate,
								);
							}

							if (msg.instrumentalLeft && msg.instrumentalRight) {
								instrumentalBlob = encodeStereoWavBlob(
									msg.instrumentalLeft,
									msg.instrumentalRight,
									sampleRate,
								);
							}

							const duration = msg.length / sampleRate;

							options.onProgress?.({
								phase: "done",
								progress: 100,
								message: "Tách lời hoàn tất!",
							});

							cleanup();
							resolve({
								mode: options.mode,
								duration,
								vocalsBlob,
								instrumentalBlob,
							});
							break;

						case "cancelled":
							worker.removeEventListener("message", handleWorkerMessage);
							cleanup();
							reject(new DOMException("Separation was cancelled", "AbortError"));
							break;

						case "error":
							worker.removeEventListener("message", handleWorkerMessage);
							cleanup();
							reject(new Error(msg.message));
							break;
					}
				};

				worker.addEventListener("message", handleWorkerMessage);

				// Start init
				options.onProgress?.({
					phase: "init",
					progress: 5,
					message: "Khởi tạo tiến trình tách âm thanh...",
				});

				worker.postMessage({ type: "init" } satisfies WorkerInboundMessage);
			});
		} catch (error) {
			this.isProcessing = false;
			this.activeAbortController = null;
			throw error;
		}
	}

	/**
	 * Decode audio file or blob into 44.1kHz stereo Float32Array on main thread
	 */
	async decodeAudioSource(
		source: File | Blob | string,
		onProgress?: (progress: VocalSeparationProgress) => void,
	): Promise<{ left: Float32Array; right: Float32Array; duration: number }> {
		onProgress?.({
			phase: "init",
			progress: 5,
			message: "Đang giải mã âm thanh nguồn (44.1kHz stereo)...",
		});

		let arrayBuffer: ArrayBuffer;
		if (typeof source === "string") {
			const res = await fetch(source);
			arrayBuffer = await res.arrayBuffer();
		} else {
			arrayBuffer = await source.arrayBuffer();
		}

		const AudioCtx =
			window.AudioContext ||
			(window as unknown as { webkitAudioContext: typeof AudioContext })
				.webkitAudioContext;
		const audioCtx = new AudioCtx({ sampleRate: 44100 });

		try {
			const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
			const left = audioBuffer.getChannelData(0);
			const right =
				audioBuffer.numberOfChannels > 1
					? audioBuffer.getChannelData(1)
					: new Float32Array(left);

			return {
				left,
				right,
				duration: audioBuffer.duration,
			};
		} finally {
			await audioCtx.close();
		}
	}

	/**
	 * Cancel current separation process
	 */
	cancel(): void {
		if (this.worker && this.isProcessing) {
			this.worker.postMessage({ type: "cancel" } satisfies WorkerInboundMessage);
			this.activeAbortController?.abort();
		}
	}

	/**
	 * Terminate worker and clean up resources
	 */
	dispose(): void {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		this.isProcessing = false;
		this.activeAbortController = null;
	}

	private getOrCreateWorker(): Worker {
		if (!this.worker) {
			this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
				type: "module",
			});
		}
		return this.worker;
	}
}

export const vocalSeparationService = new VocalSeparationService();
