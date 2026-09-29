import * as wasm from "opencut-wasm";
import type { EffectPass } from "@/effects/types";

/** Shaders understood by the last wasm bundle without color support. */
const LEGACY_SHADERS = new Set(["gaussian-blur"]);

let cached: Set<string> | null = null;
const warned = new Set<string>();

/**
 * Shader ids supported by the deployed wasm bundle. New bundles export
 * `listEffectShaders`; older ones fall back to the legacy blur-only set so
 * unknown passes can be dropped instead of breaking the frame.
 */
export function getSupportedEffectShaders(): Set<string> {
	if (cached) return cached;
	try {
		const list = (
			wasm as unknown as { listEffectShaders?: () => unknown }
		).listEffectShaders?.();
		cached =
			Array.isArray(list) && list.length > 0
				? new Set(list.filter((s): s is string => typeof s === "string"))
				: new Set(LEGACY_SHADERS);
	} catch {
		cached = new Set(LEGACY_SHADERS);
	}
	return cached;
}

/** Drop passes the deployed bundle cannot render. Pure — safe in resolve. */
export function filterEffectPasses(passes: EffectPass[]): EffectPass[] {
	const supported = getSupportedEffectShaders();
	return passes.filter((pass) => {
		if (supported.has(pass.shader)) return true;
		if (!warned.has(pass.shader)) {
			warned.add(pass.shader);
			console.warn(
				`Effect shader "${pass.shader}" is not supported by the installed opencut-wasm bundle — pass skipped. Rebuild/publish the wasm package (>= 0.2.11) to enable it.`,
			);
		}
		return false;
	});
}

/**
 * Compact groups (drop empties — an empty group errors Rust
 * `apply_with_encoder` with MissingEffectPasses) and drop unsupported
 * passes. Returns a new array; groups that become empty are removed.
 */
export function compactAndFilterGroups(groups: EffectPass[][]): EffectPass[][] {
	const out: EffectPass[][] = [];
	for (const group of groups) {
		if (group.length === 0) continue;
		const kept = filterEffectPasses(group);
		if (kept.length > 0) out.push(kept);
	}
	return out;
}
