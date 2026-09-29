export interface ModelConfig {
	id: string;
	name: string;
	url: string;
	fallbackUrls?: string[];
	cacheKey: string;
	approxSizeMb: number;
	sampleRate: number;
	nFft: number;
	hopSize: number;
	dimF: number;
	dimT: number;
	compensate: number;
	segmentSamples: number;
}

export const VOCAL_MODEL_CONFIG: ModelConfig = {
	id: "uvr-mdx-net-voc-ft",
	name: "UVR MDX-Net Vocal FT",
	url: "/models/uvr-mdx-net-voc-ft.onnx",
	fallbackUrls: [
		"https://huggingface.co/masszhou/mdxnet/resolve/main/UVR-MDX-NET-Voc_FT.onnx",
		"https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-MDX-NET-Voc_FT.onnx",
	],
	cacheKey: "opencut-model-uvr-mdx-net-voc-ft-v2",
	approxSizeMb: 64,
	sampleRate: 44100,
	nFft: 7680,
	hopSize: 1024,
	dimF: 3072,
	dimT: 256,
	compensate: 1.035,
	segmentSamples: 1024 * (256 - 1), // 261,120 samples (~5.92 seconds)
};

export const CACHE_NAME = "opencut-vocal-models-v1";

/**
 * Check if the model is already cached in browser CacheStorage
 */
export async function isModelCached(cacheKey = VOCAL_MODEL_CONFIG.cacheKey): Promise<boolean> {
	if (typeof caches === "undefined") return false;
	try {
		const cache = await caches.open(CACHE_NAME);
		const response = await cache.match(cacheKey);
		return !!response;
	} catch {
		return false;
	}
}

/**
 * Fetch model weights with progress reporting and CacheStorage persistence
 */
export async function fetchModelWithCache(
	config: ModelConfig = VOCAL_MODEL_CONFIG,
	onProgress?: (loaded: number, total: number) => void,
	signal?: AbortSignal,
): Promise<ArrayBuffer> {
	// 1. Check CacheStorage first
	if (typeof caches !== "undefined") {
		try {
			const cache = await caches.open(CACHE_NAME);
			const cachedResponse = await cache.match(config.cacheKey);
			if (cachedResponse) {
				const buffer = await cachedResponse.arrayBuffer();
				if (buffer.byteLength > 1_000_000) {
					return buffer;
				}
			}
		} catch (err) {
			console.warn("Failed to read from CacheStorage:", err);
		}
	}

	// 2. Fetch from URL with fallback
	const origin =
		typeof self !== "undefined" && self.location?.origin
			? self.location.origin
			: typeof window !== "undefined" && window.location?.origin
				? window.location.origin
				: "";

	const rawUrls = [config.url, ...(config.fallbackUrls ?? [])];
	const urlsToTry = rawUrls.map((u) => (u.startsWith("/") && origin ? `${origin}${u}` : u));
	let lastError: Error | null = null;

	for (const url of urlsToTry) {
		if (signal?.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}

		try {
			const response = await fetch(url, { signal, mode: "cors" });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			const contentLengthHeader = response.headers.get("Content-Length");
			const totalBytes = contentLengthHeader
				? parseInt(contentLengthHeader, 10)
				: config.approxSizeMb * 1024 * 1024;

			const body = response.body;
			if (!body) {
				const buffer = await response.arrayBuffer();
				await storeInCache(config.cacheKey, buffer);
				return buffer;
			}

			const reader = body.getReader();
			const chunks: Uint8Array[] = [];
			let loadedBytes = 0;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					chunks.push(value);
					loadedBytes += value.byteLength;
					if (onProgress) {
						onProgress(loadedBytes, totalBytes);
					}
				}
			}

			// Concatenate all chunks
			const result = new Uint8Array(loadedBytes);
			let offset = 0;
			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.byteLength;
			}

			const buffer = result.buffer;
			await storeInCache(config.cacheKey, buffer);
			return buffer;
		} catch (err) {
			console.warn(`Failed to fetch model from ${url}:`, err);
			lastError = err instanceof Error ? err : new Error(String(err));
		}
	}

	throw lastError ?? new Error("Failed to download separation model from all mirrors");
}

async function storeInCache(cacheKey: string, buffer: ArrayBuffer): Promise<void> {
	if (typeof caches === "undefined") return;
	try {
		const cache = await caches.open(CACHE_NAME);
		const response = new Response(buffer, {
			headers: { "Content-Type": "application/octet-stream" },
		});
		await cache.put(cacheKey, response);
	} catch (err) {
		console.warn("Failed to store model in CacheStorage:", err);
	}
}
