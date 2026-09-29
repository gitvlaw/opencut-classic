"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CurveChannel } from "@/effects/definitions/curves";
import { CURVE_POINTS } from "@/effects/definitions/curves";
import { cn } from "@/utils/ui";
import { Button } from "@/components/ui/button";

const CONTROL_XS = [0, 0.25, 0.5, 0.75, 1];
const W = 216;
const H = 150;
const PAD = 12;

const CHANNEL_COLORS: Record<CurveChannel, string> = {
	master: "#e8e8e8",
	red: "#ff6b6b",
	green: "#51cf66",
	blue: "#74c0fc",
};

type Control = { x: number; y: number };

/** Sample a 16-point curve at position x (linear interp). */
function samplePoints(points: number[], x: number): number {
	const scaled = Math.min(1, Math.max(0, x)) * (CURVE_POINTS - 1);
	const i = Math.min(Math.floor(scaled), CURVE_POINTS - 2);
	const f = scaled - i;
	return points[i]! + (points[i + 1]! - points[i]!) * f;
}

function controlsFromPoints(points: number[]): Control[] {
	return CONTROL_XS.map((x) => ({ x, y: samplePoints(points, x) }));
}

/** Centripetal Catmull-Rom through controls, sampled to 16 values. */
export function resampleControls(controls: Control[]): number[] {
	const pts = [...controls].sort((a, b) => a.x - b.x);
	const out: number[] = [];
	const get = (i: number): Control => {
		if (i < 0) return { x: 2 * pts[0]!.x - pts[1]!.x, y: 2 * pts[0]!.y - pts[1]!.y };
		if (i >= pts.length) {
			const n = pts.length;
			return { x: 2 * pts[n - 1]!.x - pts[n - 2]!.x, y: 2 * pts[n - 1]!.y - pts[n - 2]!.y };
		}
		return pts[i]!;
	};
	for (let s = 0; s < CURVE_POINTS; s++) {
		const x = s / (CURVE_POINTS - 1);
		let seg = 0;
		while (seg < pts.length - 2 && x > pts[seg + 1]!.x) seg++;
		const p0 = get(seg - 1);
		const p1 = get(seg);
		const p2 = get(seg + 1);
		const p3 = get(seg + 2);
		const t0 = 0;
		const t1 = t0 + Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y)) || 1;
		const t2 = t1 + Math.sqrt(Math.hypot(p2.x - p1.x, p2.y - p1.y)) || 1;
		const t3 = t2 + Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y)) || 1;
		const t = t1 + ((t2 - t1) * (x - p1.x)) / (p2.x - p1.x || 1);
		const y = catmullRom(p0.y, p1.y, p2.y, p3.y, t0, t1, t2, t3, t);
		out.push(Math.min(1, Math.max(0, y)));
	}
	return out;
}

function catmullRom(
	y0: number,
	y1: number,
	y2: number,
	y3: number,
	t0: number,
	t1: number,
	t2: number,
	t3: number,
	t: number,
): number {
	const a1 = ((t1 - t) / (t1 - t0 || 1)) * y0 + ((t - t0) / (t1 - t0 || 1)) * y1;
	const a2 = ((t2 - t) / (t2 - t1 || 1)) * y1 + ((t - t1) / (t2 - t1 || 1)) * y2;
	const a3 = ((t3 - t) / (t3 - t2 || 1)) * y2 + ((t - t2) / (t3 - t2 || 1)) * y3;
	const b1 = ((t2 - t) / (t2 - t0 || 1)) * a1 + ((t - t0) / (t2 - t0 || 1)) * a2;
	const b2 = ((t3 - t) / (t3 - t1 || 1)) * a2 + ((t - t1) / (t3 - t1 || 1)) * a3;
	return ((t2 - t) / (t2 - t1 || 1)) * b1 + ((t - t1) / (t2 - t1 || 1)) * b2;
}

const toPx = (x: number) => PAD + x * (W - PAD * 2);
const toPy = (y: number) => H - PAD - y * (H - PAD * 2);
const fromPx = (px: number) => (px - PAD) / (W - PAD * 2);
const fromPy = (py: number) => (H - PAD - py) / (H - PAD * 2);

export function CurveEditor({
	channels,
	onPreview,
	onCommit,
}: {
	channels: Record<CurveChannel, number[]>;
	onPreview: (channel: CurveChannel, points: number[]) => void;
	onCommit: () => void;
}) {
	const [active, setActive] = useState<CurveChannel>("master");
	const [controls, setControls] = useState<Record<CurveChannel, Control[]>>(() => ({
		master: controlsFromPoints(channels.master),
		red: controlsFromPoints(channels.red),
		green: controlsFromPoints(channels.green),
		blue: controlsFromPoints(channels.blue),
	}));
	const dragIndex = useRef<number | null>(null);
	const svgRef = useRef<SVGSVGElement>(null);

	// Re-sync the active channel when the user switches tabs.
	useEffect(() => {
		setControls((prev) => ({ ...prev, [active]: controlsFromPoints(channels[active]) }));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// Re-sync all channels on external changes (preset apply, undo) —
	// skipped mid-drag so the pointer gesture is never clobbered.
	const channelsKey = (Object.keys(channels) as CurveChannel[])
		.map((ch) => channels[ch].map((v) => v.toFixed(4)).join(","))
		.join("|");
	useEffect(() => {
		if (dragIndex.current !== null) return;
		setControls({
			master: controlsFromPoints(channels.master),
			red: controlsFromPoints(channels.red),
			green: controlsFromPoints(channels.green),
			blue: controlsFromPoints(channels.blue),
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [channelsKey]);

	const path = useMemo(() => {
		const pts = resampleControls(controls[active]);
		return pts.map((y, i) => `${i === 0 ? "M" : "L"}${toPx(i / (CURVE_POINTS - 1)).toFixed(1)},${toPy(y).toFixed(1)}`).join(" ");
	}, [controls, active]);

	const svgPoint = (clientX: number, clientY: number) => {
		const rect = svgRef.current?.getBoundingClientRect();
		if (!rect) return null;
		return {
			x: ((clientX - rect.left) / rect.width) * W,
			y: ((clientY - rect.top) / rect.height) * H,
		};
	};

	const handleMove = (clientX: number, clientY: number) => {
		const idx = dragIndex.current;
		if (idx === null) return;
		const p = svgPoint(clientX, clientY);
		if (!p) return;
		setControls((prev) => {
			const list = [...prev[active]];
			const cur = { ...list[idx]! };
			const prevX = idx > 0 ? list[idx - 1]!.x + 0.02 : 0;
			const nextX = idx < list.length - 1 ? list[idx + 1]!.x - 0.02 : 1;
			if (idx !== 0 && idx !== list.length - 1) {
				cur.x = Math.min(nextX, Math.max(prevX, fromPx(p.x)));
			}
			cur.y = Math.min(1, Math.max(0, fromPy(p.y)));
			list[idx] = cur;
			const points = resampleControls(list);
			onPreview(active, points);
			return { ...prev, [active]: list };
		});
	};

	return (
		<div className="flex flex-col gap-2 px-4">
			<div className="flex items-center gap-1">
				{(Object.keys(CHANNEL_COLORS) as CurveChannel[]).map((ch) => (
					<Button
						key={ch}
						variant={active === ch ? "secondary" : "ghost"}
						size="sm"
						className="h-7 px-2 text-xs capitalize"
						onClick={() => setActive(ch)}
					>
						<span
							className="mr-1.5 inline-block size-2 rounded-full"
							style={{ background: CHANNEL_COLORS[ch] }}
						/>
						{ch}
					</Button>
				))}
				<Button
					variant="ghost"
					size="sm"
					className="ml-auto h-7 px-2 text-xs"
					onClick={() => {
						const identity = Array.from({ length: CURVE_POINTS }, (_, i) => i / (CURVE_POINTS - 1));
						setControls((prev) => ({ ...prev, [active]: controlsFromPoints(identity) }));
						onPreview(active, identity);
						onCommit();
					}}
				>
					Reset
				</Button>
			</div>
			<svg
				ref={svgRef}
				viewBox={`0 0 ${W} ${H}`}
				className="w-full touch-none rounded bg-black/80"
				onPointerMove={(e) => handleMove(e.clientX, e.clientY)}
				onPointerUp={() => {
					if (dragIndex.current !== null) {
						dragIndex.current = null;
						onCommit();
					}
				}}
				onPointerLeave={() => {
					if (dragIndex.current !== null) {
						dragIndex.current = null;
						onCommit();
					}
				}}
			>
				{[0.25, 0.5, 0.75].map((f) => (
					<g key={f} stroke="rgba(255,255,255,0.12)" strokeWidth={1}>
						<line x1={toPx(f)} y1={PAD} x2={toPx(f)} y2={H - PAD} />
						<line x1={PAD} y1={toPy(f)} x2={W - PAD} y2={toPy(f)} />
					</g>
				))}
				<line x1={toPx(0)} y1={toPy(0)} x2={toPx(1)} y2={toPy(1)} stroke="rgba(255,255,255,0.25)" strokeWidth={1} strokeDasharray="4 3" />
				<path d={path} fill="none" stroke={CHANNEL_COLORS[active]} strokeWidth={2} />
				{controls[active].map((c, i) => (
					<circle
						key={i}
						cx={toPx(c.x)}
						cy={toPy(c.y)}
						r={6}
						fill={CHANNEL_COLORS[active]}
						stroke="#000"
						strokeWidth={1.5}
						className="cursor-grab"
						onPointerDown={(e) => {
							(e.target as SVGElement).setPointerCapture?.(e.pointerId);
							dragIndex.current = i;
						}}
					/>
				))}
			</svg>
		</div>
	);
}
