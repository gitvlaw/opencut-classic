import {
	applyEffectPasses,
	applyMaskFeather as applyMaskFeatherWasm,
	initializeGpu,
} from "opencut-wasm";
import type { EffectPass, EffectUniformValue } from "@/effects/types";

let gpuAvailable = false;
let initPromise: Promise<void> | null = null;

export function initializeGpuRenderer(): Promise<void> {
	if (!initPromise) {
		initPromise = initializeGpu()
			.then(() => {
				gpuAvailable = true;
			})
			.catch((error: unknown) => {
				gpuAvailable = false;
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`GPU renderer unavailable: ${message}`);
			});
	}
	return initPromise;
}

export function isGpuAvailable(): boolean {
	return gpuAvailable;
}

export const gpuRenderer = {
	applyEffect({
		source,
		width,
		height,
		passes,
	}: {
		source: OffscreenCanvas;
		width: number;
		height: number;
		passes: EffectPass[];
	}): OffscreenCanvas {
		if (passes.length === 0) {
			return source;
		}
		if (!gpuAvailable) {
			return applyCpuColorFallback({ source, width, height, passes });
		}

		try {
			return applyEffectPasses({
				source,
				width,
				height,
				passes: serializeEffectPasses(passes),
			});
		} catch {
			return applyCpuColorFallback({ source, width, height, passes });
		}
	},

	applyMaskFeather({
		maskCanvas,
		width,
		height,
		feather,
	}: {
		maskCanvas: OffscreenCanvas;
		width: number;
		height: number;
		feather: number;
	}): OffscreenCanvas {
		if (!gpuAvailable) {
			return maskCanvas;
		}

		return applyMaskFeatherWasm({
			mask: maskCanvas,
			width,
			height,
			feather,
		});
	},
};

function serializeEffectPasses(passes: EffectPass[]) {
	return passes.map((pass) => ({
		shader: pass.shader,
		uniforms: Object.entries(pass.uniforms).map(([name, value]) => ({
			name,
			value: normalizeUniformValue(value),
		})),
	}));
}

function normalizeUniformValue(value: EffectUniformValue): number[] {
	return typeof value === "number" ? [value] : value;
}

/**
 * CPU fallback for color passes when WebGPU is unavailable.
 * Covers the 5 basic Adjust params via Canvas2D `filter`; advanced
 * params (temp/tint/highlights/...) need GPU and are skipped with a warn.
 */
function applyCpuColorFallback({
	source,
	width,
	height,
	passes,
}: {
	source: OffscreenCanvas;
	width: number;
	height: number;
	passes: EffectPass[];
}): OffscreenCanvas {
	try {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		if (!ctx) return source;

		let current: OffscreenCanvas | CanvasImageSource = source;
		for (const pass of passes) {
			if (pass.shader === "gaussian-blur") return source; // no CPU blur here
			const data = toDataArray(pass.uniforms.u_data);
			if (!data) continue;
			const filter = buildCssFilter(pass.shader, data);
			const frame = new OffscreenCanvas(width, height);
			const fctx = frame.getContext("2d");
			if (!fctx) continue;
			fctx.filter = filter;
			fctx.drawImage(current, 0, 0, width, height);
			fctx.filter = "none";
			current = frame;
		}
		if (current instanceof OffscreenCanvas) return current;
		ctx.drawImage(current, 0, 0, width, height);
		return canvas;
	} catch {
		return source;
	}
}

function toDataArray(v: EffectUniformValue | undefined): number[] | null {
	if (typeof v === "number") return [v];
	if (Array.isArray(v)) return v as number[];
	return null;
}

function buildCssFilter(shader: string, data: number[]): string {
	if (shader === "color-grade") {
		const exposure = data[0] ?? 0;
		const brightness = data[1] ?? 0;
		const contrast = data[2] ?? 0;
		const saturation = data[3] ?? 0;
		const hue = data[11] ?? 0;
		const b = Math.pow(2, exposure) * (1 + brightness);
		const parts = [
			`brightness(${Math.max(0, b).toFixed(3)})`,
			`contrast(${(1 + contrast).toFixed(3)})`,
			`saturate(${(1 + saturation).toFixed(3)})`,
		];
		if (Math.abs(hue) >= 0.5) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);
		return parts.join(" ");
	}
	if (shader === "hsl-shift") {
		// Approximate global sat shift by averaging band sat adjustments.
		let avg = 0;
		for (let i = 0; i < 8; i++) avg += data[i * 3 + 1] ?? 0;
		avg /= 8;
		return `saturate(${(1 + avg).toFixed(3)})`;
	}
	if (shader === "color-filter") {
		const intensity = data[0] ?? 0;
		const saturation = data[4] ?? 0;
		const contrast = data[3] ?? 0;
		if (intensity <= 0.001) return "none";
		return `saturate(${(1 + saturation * intensity).toFixed(3)}) contrast(${(1 + contrast * intensity).toFixed(3)})`;
	}
	return "none";
}
