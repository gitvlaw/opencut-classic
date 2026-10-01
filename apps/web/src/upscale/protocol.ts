export type UpscaleInboundMessage =
	| { type: "init"; model: ArrayBuffer }
	| {
			type: "upscale-image";
			id: number;
			width: number;
			height: number;
			imageBitmap: ImageBitmap;
			tileSize: number;
	  }
	| { type: "cancel" };

export type UpscaleOutboundMessage =
	| { type: "init_complete"; executionProvider: string }
	| { type: "tile_progress"; id: number; done: number; total: number; percentage: number }
	| {
			type: "image_complete";
			id: number;
			width: number;
			height: number;
			imageBitmap: ImageBitmap;
			avgTileMs: number;
	  }
	| { type: "cancelled"; id: number }
	| { type: "error"; message: string; id?: number };
