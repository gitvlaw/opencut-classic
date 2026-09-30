"use client";

import { useRef } from "react";

const SIZE = 128;
const RADIUS = SIZE / 2;

/** Hue wheel (conic) drag pad. Angle = hue, distance from center = saturation. */
export function WheelPad({
	hue,
	sat,
	onPreview,
	onCommit,
}: {
	/** -180..180 degrees */
	hue: number;
	/** 0..100 */
	sat: number;
	onPreview: (hue: number, sat: number) => void;
	onCommit: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);

	const marker = (() => {
		const rad = ((hue - 90) * Math.PI) / 180;
		const r = (Math.min(100, Math.max(0, sat)) / 100) * (RADIUS - 10);
		return { x: RADIUS + r * Math.cos(rad), y: RADIUS + r * Math.sin(rad) };
	})();

	const setFromPointer = (clientX: number, clientY: number) => {
		const el = ref.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const dx = clientX - (rect.left + rect.width / 2);
		const dy = clientY - (rect.top + rect.height / 2);
		const scale = RADIUS / (rect.width / 2);
		const dist = Math.min(Math.hypot(dx, dy) * scale, RADIUS - 10);
		let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
		while (deg > 180) deg -= 360;
		while (deg < -180) deg += 360;
		onPreview(
			Math.round(deg),
			Math.round((dist / (RADIUS - 10)) * 100),
		);
	};

	return (
		<div
			ref={ref}
			className="relative touch-none rounded-full"
			style={{
				width: SIZE,
				height: SIZE,
				background:
					"conic-gradient(from 90deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)",
				cursor: "crosshair",
			}}
			onPointerDown={(e) => {
				(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
				dragging.current = true;
				setFromPointer(e.clientX, e.clientY);
			}}
			onPointerMove={(e) => {
				if (dragging.current) setFromPointer(e.clientX, e.clientY);
			}}
			onPointerUp={() => {
				if (dragging.current) {
					dragging.current = false;
					onCommit();
				}
			}}
			onPointerLeave={() => {
				if (dragging.current) {
					dragging.current = false;
					onCommit();
				}
			}}
			onDoubleClick={() => {
				onPreview(0, 0);
				onCommit();
			}}
			title="Drag to tint • Double-click to reset"
		>
			<div
				className="absolute rounded-full border-2 border-white shadow"
				style={{
					width: 14,
					height: 14,
					left: marker.x - 7,
					top: marker.y - 7,
					background: sat < 1 ? "#808080" : `hsl(${hue}, 100%, 50%)`,
				}}
			/>
		</div>
	);
}
