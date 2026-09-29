"use client";

import { useEffect, useRef } from "react";
import type { ParamValues } from "@/params";
import { effectPreviewService } from "@/services/renderer/effect-preview";

const HIST_W = 156;
const HIST_H = 56;
const BINS = 64;

/**
 * RGB histogram of the graded effect-preview thumbnail (160px test image).
 * Representative (not frame-accurate) scope — runs fully in TS via 2D
 * canvas so no Rust/GPU readback is needed.
 */
export function EffectHistogram({
	effectType,
	params,
}: {
	effectType: string;
	params: ParamValues;
}) {
	const sourceRef = useRef<HTMLCanvasElement>(null);
	const histRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const source = sourceRef.current;
		const hist = histRef.current;
		if (!source || !hist) return;

		let cancelled = false;
		const render = () => {
			if (cancelled) return;
			try {
				effectPreviewService.renderPreview({
					effectType,
					params,
					targetCanvas: source,
				});
				const sctx = source.getContext("2d");
				const hctx = hist.getContext("2d");
				if (!sctx || !hctx) return;
				const { width, height } = source;
				if (!width || !height) return;
				const img = sctx.getImageData(0, 0, width, height);
				const bins = computeBins(img);
				drawHistogram(hctx, bins);
			} catch {
				// keep previous frame on error
			}
		};

		render();
		const off = effectPreviewService.onPreviewImageReady({ callback: render });
		return () => {
			cancelled = true;
			off();
		};
	}, [effectType, JSON.stringify(params)]);

	return (
		<div className="px-4">
			<canvas ref={sourceRef} width={160} height={160} className="hidden" aria-hidden />
			<canvas
				ref={histRef}
				width={HIST_W}
				height={HIST_H}
				className="h-14 w-full rounded bg-black/80"
			/>
		</div>
	);
}

function computeBins(img: ImageData): [number[], number[], number[]] {
	const r = new Array(BINS).fill(0);
	const g = new Array(BINS).fill(0);
	const b = new Array(BINS).fill(0);
	const d = img.data;
	for (let i = 0; i < d.length; i += 4) {
		r[Math.min(BINS - 1, (d[i]! * BINS) >> 8)]!++;
		g[Math.min(BINS - 1, (d[i + 1]! * BINS) >> 8)]!++;
		b[Math.min(BINS - 1, (d[i + 2]! * BINS) >> 8)]!++;
	}
	return [r, g, b];
}

function drawHistogram(
	ctx: CanvasRenderingContext2D,
	[r, g, b]: [number[], number[], number[]],
) {
	ctx.clearRect(0, 0, HIST_W, HIST_H);
	const max = Math.max(1, ...r, ...g, ...b);
	const bw = HIST_W / BINS;
	const series: Array<{ bins: number[]; color: string }> = [
		{ bins: r, color: "rgba(255,90,90,0.85)" },
		{ bins: g, color: "rgba(90,220,120,0.85)" },
		{ bins: b, color: "rgba(90,150,255,0.85)" },
	];
	ctx.globalCompositeOperation = "lighter";
	for (const { bins, color } of series) {
		ctx.fillStyle = color;
		for (let i = 0; i < BINS; i++) {
			const h = (bins[i]! / max) * HIST_H;
			ctx.fillRect(i * bw, HIST_H - h, Math.max(1, bw - 0.5), h);
		}
	}
	ctx.globalCompositeOperation = "source-over";
}
