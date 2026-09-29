export type TransitionCategory =
	| "basic"
	| "fade"
	| "camera"
	| "slide"
	| "wipe"
	| "glitch";

export interface TransitionRenderContext {
	width: number;
	height: number;
	params?: Record<string, any>;
	direction?: "left" | "right" | "up" | "down";
}

export type TransitionRenderFn = (
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	sourceA: CanvasImageSource,
	sourceB: CanvasImageSource,
	progress: number,
	context: TransitionRenderContext,
) => void;

export interface TransitionDefinition {
	type: string;
	name: string;
	category: TransitionCategory;
	description: string;
	defaultDuration: number; // in seconds
	hasDirection?: boolean;
	render: TransitionRenderFn;
}
