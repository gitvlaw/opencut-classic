import type { ParamValues } from "@/params";
import { GRADE_PARAM_KEYS } from "@/effects/definitions/adjust";

export interface UserGradePreset {
	id: string;
	name: string;
	createdAt: number;
	/** Only the 14 Adjust keys — never UI state or effect ids. */
	params: ParamValues;
}

/** Minimal storage surface so tests can inject a fake (bun has no DOM). */
export interface GradePresetStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export const USER_GRADE_PRESETS_KEY = "opencut:user-grade-presets:v1";
export const MAX_USER_GRADE_PRESETS = 24;

function defaultStore(): GradePresetStorage | null {
	try {
		if (typeof localStorage !== "undefined") return localStorage;
	} catch {
		// private mode / non-browser
	}
	return null;
}

function parseList(raw: string | null): UserGradePreset[] {
	if (!raw) return [];
	try {
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr)) return [];
		return arr.filter(isUserGradePreset);
	} catch {
		return [];
	}
}

function isUserGradePreset(v: unknown): v is UserGradePreset {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		typeof o.name === "string" &&
		typeof o.createdAt === "number" &&
		typeof o.params === "object" &&
		o.params !== null
	);
}

/** Keep only numeric Adjust keys — forward-compatible if keys grow. */
export function pickGradeParams(params: ParamValues): ParamValues {
	const out: ParamValues = {};
	for (const key of GRADE_PARAM_KEYS) {
		const v = params[key];
		if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
	}
	return out;
}

function readAll(store?: GradePresetStorage): UserGradePreset[] {
	const s = store ?? defaultStore();
	if (!s) return [];
	return parseList(s.getItem(USER_GRADE_PRESETS_KEY));
}

function writeAll(store: GradePresetStorage | undefined, list: UserGradePreset[]): void {
	const s = store ?? defaultStore();
	if (!s) return;
	try {
		s.setItem(USER_GRADE_PRESETS_KEY, JSON.stringify(list));
	} catch {
		// quota exceeded — keep in-memory state, drop silently
	}
}

export function listGradePresets(store?: GradePresetStorage): UserGradePreset[] {
	return readAll(store);
}

function newId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return crypto.randomUUID();
	}
	return `gp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function saveGradePreset(
	name: string,
	params: ParamValues,
	store?: GradePresetStorage,
): UserGradePreset | null {
	const clean = name.trim().slice(0, 60);
	if (!clean) return null;
	const entry: UserGradePreset = {
		id: newId(),
		name: clean,
		createdAt: Date.now(),
		params: pickGradeParams(params),
	};
	const list = [entry, ...readAll(store)].slice(0, MAX_USER_GRADE_PRESETS);
	writeAll(store, list);
	return entry;
}

export function deleteGradePreset(id: string, store?: GradePresetStorage): void {
	writeAll(store, readAll(store).filter((p) => p.id !== id));
}

export function renameGradePreset(
	id: string,
	name: string,
	store?: GradePresetStorage,
): boolean {
	const clean = name.trim().slice(0, 60);
	if (!clean) return false;
	let found = false;
	const list = readAll(store).map((p) => {
		if (p.id !== id) return p;
		found = true;
		return { ...p, name: clean };
	});
	if (!found) return false;
	writeAll(store, list);
	return true;
}
