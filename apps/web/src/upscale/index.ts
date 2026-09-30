import { ShaderUpscaler } from "./shader-upscaler";
import "./ai-upscaler";
import type { Upscaler, UpscaleMethod } from "./types";

export * from "./types";
export { ShaderUpscaler } from "./shader-upscaler";

/**
 * Backend factory. "ai" is served by AiUpscaler once its worker is ready
 * (Phase 2) — until then it falls back to the realtime shader path so
 * callers never have to branch.
 */
export function resolveUpscaler(method: UpscaleMethod): Upscaler {
	switch (method) {
		case "ai":
			return resolveAiUpscaler() ?? new ShaderUpscaler();
		case "shader":
		default:
			return new ShaderUpscaler();
	}
}

// Overridden by ai-upscaler.ts (side-effect import) when bundled.
let aiFactory: (() => Upscaler) | null = null;

export function registerAiUpscaler(factory: () => Upscaler): void {
	aiFactory = factory;
}

function resolveAiUpscaler(): Upscaler | null {
	try {
		return aiFactory?.() ?? null;
	} catch {
		return null;
	}
}
