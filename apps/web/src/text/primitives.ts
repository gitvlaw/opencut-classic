import type { TextCanvasContext, TextBlockMeasurement } from "@/text/layout";
import { DEFAULTS } from "@/timeline/defaults";
import { clamp } from "@/utils/math";
import {
	CORNER_RADIUS_MAX,
	CORNER_RADIUS_MIN,
	type TextBackgroundMode,
} from "./background";
import {
	drawTextDecoration,
	getTextBackgroundRect,
	getTextLineBackgroundRects,
	measureTextBlock,
	setCanvasLetterSpacing,
} from "./layout";
import { FONT_SIZE_SCALE_REFERENCE } from "./typography";
import { loadFullFont } from "@/fonts/google-fonts";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";

export type TextAlign = "left" | "center" | "right";
export type TextFontWeight = "normal" | "bold";
export type TextFontStyle = "normal" | "italic";
export type TextDecoration = "none" | "underline" | "line-through";

export interface TextLayoutParams {
	content: string;
	fontSize: number;
	fontFamily: string;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	textAlign: TextAlign;
	textDecoration?: TextDecoration;
	letterSpacing?: number;
	lineHeight?: number;
}

export interface ResolvedTextLayout {
	scaledFontSize: number;
	fontString: string;
	letterSpacing: number;
	lineHeightPx: number;
	fontSizeRatio: number;
	textAlign: TextAlign;
	textDecoration: TextDecoration;
}

export interface MeasuredTextLayout extends ResolvedTextLayout {
	lines: string[];
	lineMetrics: TextMetrics[];
	block: TextBlockMeasurement;
}

export interface ResolvedTextBackgroundLike {
	enabled: boolean;
	color: string;
	mode?: TextBackgroundMode;
	paddingX: number;
	paddingY: number;
	offsetX: number;
	offsetY: number;
	cornerRadius: number;
}

export interface ResolvedTextStrokeLike {
	enabled: boolean;
	color: string;
	width: number;
}

export function quoteFontFamily({ fontFamily }: { fontFamily: string }): string {
	return `"${fontFamily.replace(/"/g, '\\"')}"`;
}

export function buildTextFontString({
	fontFamily,
	fontWeight,
	fontStyle,
	scaledFontSize,
}: {
	fontFamily: string;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	scaledFontSize: number;
}): string {
	return `${fontStyle} ${fontWeight} ${scaledFontSize}px ${quoteFontFamily({ fontFamily })}, sans-serif`;
}

export function resolveTextLayout({
	text,
	canvasHeight,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
}): ResolvedTextLayout {
	const scaledFontSize =
		text.fontSize * (canvasHeight / FONT_SIZE_SCALE_REFERENCE);
	const fontWeight = text.fontWeight === "bold" ? "bold" : "normal";
	const fontStyle = text.fontStyle === "italic" ? "italic" : "normal";
	const letterSpacing = text.letterSpacing ?? DEFAULTS.text.letterSpacing;
	const lineHeightPx =
		scaledFontSize * (text.lineHeight ?? DEFAULTS.text.lineHeight);
	const fontSizeRatio = text.fontSize / 15;

	return {
		scaledFontSize,
		fontString: buildTextFontString({
			fontFamily: text.fontFamily,
			fontWeight,
			fontStyle,
			scaledFontSize,
		}),
		letterSpacing,
		lineHeightPx,
		fontSizeRatio,
		textAlign: text.textAlign,
		textDecoration: text.textDecoration ?? "none",
	};
}

export function measureTextLayout({
	text,
	canvasHeight,
	ctx,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
	ctx: TextCanvasContext;
}): MeasuredTextLayout {
	if (
		typeof document !== "undefined" &&
		text.fontFamily &&
		!SYSTEM_FONTS.has(text.fontFamily)
	) {
		loadFullFont({ family: text.fontFamily }).catch(() => {});
	}

	const resolvedLayout = resolveTextLayout({ text, canvasHeight });
	const lines = text.content.split("\n");

	ctx.save();
	ctx.font = resolvedLayout.fontString;
	ctx.textBaseline = "middle";
	setCanvasLetterSpacing({
		ctx,
		letterSpacingPx: resolvedLayout.letterSpacing,
	});
	const lineMetrics = lines.map((line) => ctx.measureText(line));
	ctx.restore();

	const block = measureTextBlock({
		lineMetrics,
		lineHeightPx: resolvedLayout.lineHeightPx,
	});

	return {
		...resolvedLayout,
		lines,
		lineMetrics,
		block,
	};
}

export function drawMeasuredTextLayout({
	ctx,
	layout,
	textColor,
	background,
	backgroundColor,
	stroke,
	strokeColor,
	strokeWidth,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	textColor: string;
	background?: ResolvedTextBackgroundLike | null;
	backgroundColor?: string;
	stroke?: ResolvedTextStrokeLike | null;
	strokeColor?: string;
	strokeWidth?: number;
	textBaseline?: CanvasTextBaseline;
}): void {
	ctx.font = layout.fontString;
	ctx.textAlign = layout.textAlign;
	ctx.textBaseline = textBaseline;
	ctx.fillStyle = textColor;
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	if (
		background?.enabled &&
		backgroundColor &&
		backgroundColor !== "transparent" &&
		layout.lines.length > 0
	) {
		const mode = background.mode ?? "line";
		const p =
			clamp({
				value: background.cornerRadius,
				min: CORNER_RADIUS_MIN,
				max: CORNER_RADIUS_MAX,
			}) / 100;

		if (mode === "line") {
			const lineRects = getTextLineBackgroundRects({
				textAlign: layout.textAlign,
				lines: layout.lines,
				lineMetrics: layout.lineMetrics,
				lineHeightPx: layout.lineHeightPx,
				visualCenterOffset: layout.block.visualCenterOffset,
				background: {
					...background,
					color: backgroundColor,
				},
				fontSizeRatio: layout.fontSizeRatio,
			});

			if (lineRects.length > 0) {
				ctx.fillStyle = backgroundColor;
				ctx.beginPath();
				for (const rect of lineRects) {
					const radius = (Math.min(rect.width, rect.height) / 2) * p;
					ctx.roundRect(rect.left, rect.top, rect.width, rect.height, radius);
				}
				ctx.fill();
				ctx.fillStyle = textColor;
			}
		} else {
			const backgroundRect = getTextBackgroundRect({
				textAlign: layout.textAlign,
				block: layout.block,
				background: {
					...background,
					color: backgroundColor,
				},
				fontSizeRatio: layout.fontSizeRatio,
			});
			if (backgroundRect) {
				const radius =
					(Math.min(backgroundRect.width, backgroundRect.height) / 2) * p;
				ctx.fillStyle = backgroundColor;
				ctx.beginPath();
				ctx.roundRect(
					backgroundRect.left,
					backgroundRect.top,
					backgroundRect.width,
					backgroundRect.height,
					radius,
				);
				ctx.fill();
				ctx.fillStyle = textColor;
			}
		}
	}

	const isStrokeEnabled =
		stroke?.enabled &&
		Boolean(strokeColor || stroke.color) &&
		(strokeColor ?? stroke.color) !== "transparent" &&
		(strokeWidth ?? stroke.width ?? 0) > 0;

	if (isStrokeEnabled) {
		const rawWidth = strokeWidth ?? stroke.width;
		const scaleFactor = layout.scaledFontSize / (layout.fontSizeRatio * 15);
		const effectiveStrokeWidth = Math.max(1, rawWidth * 2 * scaleFactor);

		ctx.save();
		ctx.strokeStyle = strokeColor ?? stroke.color;
		ctx.lineWidth = effectiveStrokeWidth;
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		for (let index = 0; index < layout.lines.length; index++) {
			const lineY =
				index * layout.lineHeightPx - layout.block.visualCenterOffset;
			ctx.strokeText(layout.lines[index], 0, lineY);
		}
		ctx.restore();
	}

	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		ctx.fillText(layout.lines[index], 0, lineY);
		drawTextDecoration({
			ctx,
			textDecoration: layout.textDecoration,
			lineWidth: layout.lineMetrics[index].width,
			lineY,
			metrics: layout.lineMetrics[index],
			scaledFontSize: layout.scaledFontSize,
			textAlign: layout.textAlign,
		});
	}
}

export function strokeMeasuredTextLayout({
	ctx,
	layout,
	strokeColor,
	strokeWidth,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	strokeColor: string;
	strokeWidth: number;
	textBaseline?: CanvasTextBaseline;
}): void {
	ctx.font = layout.fontString;
	ctx.textAlign = layout.textAlign;
	ctx.textBaseline = textBaseline;
	ctx.strokeStyle = strokeColor;
	ctx.lineWidth = strokeWidth;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		ctx.strokeText(layout.lines[index], 0, lineY);
	}
}
