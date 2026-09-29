import * as wasm from "opencut-wasm";
import { buildHaldStrip } from "./hald";
import { parseCube } from "./parse-cube";

export interface LutEntry {
	key: string;
	name: string;
	size: number;
	canvas: OffscreenCanvas;
	width: number;
	height: number;
	table: Float32Array;
	/** Numeric id passed to the GPU as u_data[2] (f32-exact below 2^24). */
	id: number;
}

const MAX_SESSION_LUTS = 8;

const entries = new Map<string, LutEntry>();
const byId = new Map<number, LutEntry>();
const gpuRegistered = new Set<number>();
let nextId = 1;
const listeners = new Set<() => void>();

function notify(): void {
	for (const fn of listeners) fn();
}

export function subscribeLuts(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

type WasmLutApi = {
	registerLutTexture?: (options: {
		id: number;
		source: OffscreenCanvas;
		width: number;
		height: number;
		size: number;
	}) => void;
	unregisterLutTexture?: (id: number) => void;
};

function wasmApi(): WasmLutApi {
	return wasm as unknown as WasmLutApi;
}

/** True when the deployed wasm bundle supports GPU 3D LUTs (>= 0.2.11). */
export function isLutGpuSupported(): boolean {
	return typeof wasmApi().registerLutTexture === "function";
}

export function listLuts(): LutEntry[] {
	return [...entries.values()];
}

export function getLut(key: string): LutEntry | undefined {
	return entries.get(key);
}

export function getLutById(id: number): LutEntry | undefined {
	return byId.get(id);
}

export async function importCubeFile(file: File): Promise<LutEntry> {
	const text = await file.text();
	const parsed = parseCube(text);
	const { canvas, width, height } = buildHaldStrip(parsed);
	const key = `user:${Date.now()}:${file.name}`;
	const entry: LutEntry = {
		key,
		name: parsed.title && parsed.title !== "Untitled" ? parsed.title : file.name.replace(/\.cube$/i, ""),
		size: parsed.size,
		canvas,
		width,
		height,
		table: parsed.table,
		id: nextId++,
	};
	entries.set(key, entry);
	byId.set(entry.id, entry);
	registerLutOnGpu(entry);
	evictOverflow();
	notify();
	return entry;
}

export function removeLut(key: string): void {
	const entry = entries.get(key);
	if (!entry) return;
	entries.delete(key);
	byId.delete(entry.id);
	gpuRegistered.delete(entry.id);
	try {
		wasmApi().unregisterLutTexture?.(entry.id);
	} catch {
		// registry state is already consistent; GPU cleanup is best-effort
	}
	notify();
}

function registerLutOnGpu(entry: LutEntry): void {
	if (gpuRegistered.has(entry.id)) return;
	try {
		wasmApi().registerLutTexture?.({
			id: entry.id,
			source: entry.canvas,
			width: entry.width,
			height: entry.height,
			size: entry.size,
		});
		gpuRegistered.add(entry.id);
	} catch {
		// GPU not initialized yet or old bundle — syncLutTexturesToGpu replays later
	}
}

/**
 * Re-register every session LUT. Call after GPU init and after compositor
 * (re-)init, because a fresh EffectPipeline starts with an empty LUT map.
 */
export function syncLutTexturesToGpu(): void {
	gpuRegistered.clear();
	for (const entry of entries.values()) registerLutOnGpu(entry);
}

function evictOverflow(): void {
	while (entries.size > MAX_SESSION_LUTS) {
		const oldest = entries.keys().next().value as string | undefined;
		if (!oldest) break;
		removeLut(oldest);
	}
}
