"use client";

import { memo, useState } from "react";
import { Sparkles, Layers } from "lucide-react";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { timelineTimeToPixels } from "@/timeline";
import { useTransitionsStore } from "@/transitions/store";
import { addOrUpdateTransition, removeTransition } from "@/transitions/service";
import { TIMELINE_DRAG_MIME } from "@/timeline/drag-source";
import type { TrackTransition, TimelineElement } from "@/timeline";
import type { TimelineDragData } from "@/timeline/drag";

interface CutPointBadgeProps {
	trackId: string;
	elementA: TimelineElement;
	elementB: TimelineElement;
	transition?: TrackTransition;
	zoomLevel: number;
}

export const CutPointBadge = memo(function CutPointBadge({
	trackId,
	elementA,
	elementB,
	transition,
	zoomLevel,
}: CutPointBadgeProps) {
	const editor = useEditor();
	const [isDragOver, setIsDragOver] = useState(false);
	const [isHovered, setIsHovered] = useState(false);
	const { selectedTransition, setSelectedTransition } = useTransitionsStore();

	const cutTime = elementA.startTime + elementA.duration;
	const cutPx = timelineTimeToPixels({ time: cutTime, zoomLevel });
	const isSelected =
		transition &&
		selectedTransition?.trackId === trackId &&
		selectedTransition?.transitionId === transition.id;

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);

		let transitionType: string | null = null;
		const activeDrag = editor.timeline.dragSource.getActive();
		if (activeDrag && activeDrag.type === "transition") {
			transitionType = activeDrag.transitionType;
		} else {
			try {
				const rawData =
					e.dataTransfer.getData(TIMELINE_DRAG_MIME) ||
					e.dataTransfer.getData("application/json") ||
					e.dataTransfer.getData("text/plain");
				if (rawData) {
					const data = JSON.parse(rawData) as TimelineDragData;
					if (data.type === "transition") {
						transitionType = data.transitionType;
					}
				}
			} catch {
				// ignore parse errors
			}
		}

		if (transitionType) {
			const id = addOrUpdateTransition({
				trackId,
				fromElementId: elementA.id,
				toElementId: elementB.id,
				type: transitionType,
			});
			setSelectedTransition({
				trackId,
				transitionId: id,
			});
		}
	};

	const handleClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (transition) {
			setSelectedTransition({
				trackId,
				transitionId: transition.id,
			});
		} else {
			// Quick add default Cross Dissolve on click
			const id = addOrUpdateTransition({
				trackId,
				fromElementId: elementA.id,
				toElementId: elementB.id,
				type: "cross-dissolve",
			});
			setSelectedTransition({
				trackId,
				transitionId: id,
			});
		}
	};

	// When transition exists, calculate ribbon bounds
	let ribbonLeft = cutPx;
	let ribbonWidth = 24;
	if (transition) {
		const durationPx = Math.max(
			18,
			timelineTimeToPixels({ time: transition.duration, zoomLevel }),
		);
		const alignment = transition.alignment ?? "center";
		if (alignment === "start") {
			ribbonLeft = cutPx;
			ribbonWidth = durationPx;
		} else if (alignment === "end") {
			ribbonLeft = cutPx - durationPx;
			ribbonWidth = durationPx;
		} else {
			ribbonLeft = cutPx - durationPx / 2;
			ribbonWidth = durationPx;
		}

		return (
			<div
				className={cn(
					"absolute top-1 bottom-1 z-20 flex items-center justify-center rounded-xs transition-all cursor-pointer pointer-events-auto select-none overflow-hidden",
					isSelected
						? "bg-primary/35 border-2 border-primary ring-2 ring-primary/40 shadow-sm"
						: "bg-primary/20 border border-primary/60 hover:bg-primary/30 hover:border-primary",
					isDragOver && "ring-2 ring-emerald-400 bg-emerald-500/30 border-emerald-400",
				)}
				style={{
					left: `${ribbonLeft}px`,
					width: `${ribbonWidth}px`,
				}}
				title={`Transition: ${transition.type} (${(transition.duration / 30000000).toFixed(2)}s, ${transition.alignment ?? "center"})`}
				onClick={handleClick}
				onMouseEnter={() => setIsHovered(true)}
				onMouseLeave={() => setIsHovered(false)}
				onDragOver={(e) => {
					e.preventDefault();
					e.stopPropagation();
					e.dataTransfer.dropEffect = "copy";
					setIsDragOver(true);
				}}
				onDragLeave={() => setIsDragOver(false)}
				onDrop={handleDrop}
			>
				{/* Diagonal stripe pattern */}
				<div
					className="absolute inset-0 opacity-15 pointer-events-none"
					style={{
						backgroundImage:
							"repeating-linear-gradient(45deg, transparent, transparent 4px, currentColor 4px, currentColor 8px)",
					}}
				/>

				{/* Center seam guide line */}
				<div
					className="absolute top-0 bottom-0 w-[1px] bg-foreground/40 pointer-events-none"
					style={{
						left: `${Math.max(0, Math.min(ribbonWidth - 1, cutPx - ribbonLeft))}px`,
					}}
				/>

				<div className="relative z-10 flex items-center gap-1 px-1">
					<Sparkles className="size-3 shrink-0 text-foreground drop-shadow-xs" />
					{ribbonWidth > 45 && (
						<span className="text-[10px] font-medium truncate text-foreground drop-shadow-xs">
							{transition.type}
						</span>
					)}
				</div>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"absolute top-0 bottom-0 -translate-x-1/2 z-20 flex items-center justify-center pointer-events-auto transition-colors",
				isDragOver ? "w-8 bg-emerald-500/20 rounded-xs" : "w-6",
			)}
			style={{ left: `${cutPx}px` }}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			onDragOver={(e) => {
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer.dropEffect = "copy";
				setIsDragOver(true);
			}}
			onDragLeave={() => setIsDragOver(false)}
			onDrop={handleDrop}
		>
			<button
				type="button"
				onClick={handleClick}
				title="Click or drop to add transition"
				className={cn(
					"flex items-center justify-center rounded-sm transition-all cursor-pointer",
					isHovered || isDragOver
						? "size-4.5 bg-background/90 text-foreground border border-border/80 shadow-xs hover:bg-primary/20 hover:text-primary"
						: "size-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/60 rounded-full",
					isDragOver && "size-5 scale-125 bg-emerald-500 text-white ring-2 ring-emerald-400",
				)}
			>
				{isHovered || isDragOver ? (
					<Layers className="size-2.5" />
				) : null}
			</button>
		</div>
	);
});
