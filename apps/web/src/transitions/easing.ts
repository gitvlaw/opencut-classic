export type EasingType =
	| "linear"
	| "ease-in"
	| "ease-out"
	| "ease-in-out"
	| "cubic-in-out"
	| "expo-out";

export function applyEasing(
	t: number,
	easing: EasingType | string = "ease-in-out",
): number {
	const clamped = Math.max(0, Math.min(1, t));
	switch (easing) {
		case "linear":
			return clamped;
		case "ease-in":
			return clamped * clamped;
		case "ease-out":
			return clamped * (2 - clamped);
		case "ease-in-out":
			return clamped < 0.5
				? 2 * clamped * clamped
				: -1 + (4 - 2 * clamped) * clamped;
		case "cubic-in-out":
			return clamped < 0.5
				? 4 * clamped * clamped * clamped
				: (clamped - 1) * (2 * clamped - 2) * (2 * clamped - 2) + 1;
		case "expo-out":
			return clamped === 1 ? 1 : 1 - Math.pow(2, -10 * clamped);
		default:
			return clamped < 0.5
				? 2 * clamped * clamped
				: -1 + (4 - 2 * clamped) * clamped;
	}
}
