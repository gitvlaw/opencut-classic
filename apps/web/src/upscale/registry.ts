import type { Upscaler } from "./types";

let aiFactory: (() => Upscaler) | null = null;

export function registerAiUpscaler(factory: () => Upscaler): void {
	aiFactory = factory;
}

export function resolveAiUpscaler(): Upscaler | null {
	try {
		return aiFactory?.() ?? null;
	} catch {
		return null;
	}
}
