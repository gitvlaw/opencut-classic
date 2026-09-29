export type SeparationMode = "both" | "vocals_only" | "instrumental_only";

export type SeparationPhase =
	| "init"
	| "downloading"
	| "processing"
	| "encoding"
	| "done"
	| "error";

export interface VocalSeparationProgress {
	phase: SeparationPhase;
	progress: number; // 0 - 100
	message: string;
	loadedBytes?: number;
	totalBytes?: number;
}

export interface VocalSeparationOptions {
	mode: SeparationMode;
	rangeMode?: "full" | "selection";
	timeRange?: {
		startSeconds: number;
		durationSeconds: number;
	};
	onProgress?: (progress: VocalSeparationProgress) => void;
	signal?: AbortSignal;
}

export interface VocalSeparationResult {
	mode: SeparationMode;
	duration: number;
	vocalsBlob?: Blob;
	instrumentalBlob?: Blob;
}

// Worker message contracts
export type WorkerInboundMessage =
	| {
			type: "init";
			modelUrl?: string;
	  }
	| {
			type: "process";
			leftChannel: Float32Array;
			rightChannel: Float32Array;
			sampleRate: number;
			mode: SeparationMode;
	  }
	| {
			type: "cancel";
	  };

export type WorkerOutboundMessage =
	| {
			type: "init_progress";
			loaded: number;
			total: number;
			percentage: number;
	  }
	| {
			type: "init_complete";
			executionProvider: string;
	  }
	| {
			type: "process_progress";
			currentChunk: number;
			totalChunks: number;
			percentage: number;
	  }
	| {
			type: "process_complete";
			vocalsLeft?: Float32Array;
			vocalsRight?: Float32Array;
			instrumentalLeft?: Float32Array;
			instrumentalRight?: Float32Array;
			sampleRate: number;
			length: number;
	  }
	| {
			type: "cancelled";
	  }
	| {
			type: "error";
			message: string;
	  };
