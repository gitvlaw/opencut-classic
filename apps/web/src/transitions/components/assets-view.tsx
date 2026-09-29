"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Search, Sparkles, Check, Wand2, Plus } from "lucide-react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { transitionsRegistry } from "../registry";
import { applyTransitionToAllCuts, addOrUpdateTransition, updateTransitionConfig } from "../service";
import { useTransitionsStore } from "../store";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { TICKS_PER_SECOND } from "@/wasm";
import type { VideoTrack, TimelineElement } from "@/timeline";
import type { TransitionCategory, TransitionDefinition } from "../types";
import { cn } from "@/utils/ui";

function applyTransitionToNearestCut({
	type,
	currentTime,
}: {
	type: string;
	currentTime: number;
}): { success: boolean; message: string } {
	const editor = EditorCore.getInstance();
	const activeScene = editor.scenes.getActiveScene();
	const { selectedTransition, setSelectedTransition } = useTransitionsStore.getState();

	// 1. If a transition is currently selected, update its type
	if (selectedTransition) {
		updateTransitionConfig({
			trackId: selectedTransition.trackId,
			transitionId: selectedTransition.transitionId,
			updates: { type },
		});
		return { success: true, message: "Updated selected transition!" };
	}

	// 2. Look for adjacent clips on video tracks
	const allVideoTracks: VideoTrack[] = [
		activeScene.tracks.main,
		...activeScene.tracks.overlay.filter((t): t is VideoTrack => t.type === "video"),
	];

	let bestTarget: {
		trackId: string;
		elA: TimelineElement;
		elB: TimelineElement;
		distance: number;
	} | null = null;

	for (const track of allVideoTracks) {
		const elements = track.elements
			.filter((el) => !("hidden" in el && el.hidden))
			.slice()
			.sort((a, b) => a.startTime - b.startTime);

		for (let i = 0; i < elements.length - 1; i++) {
			const elA = elements[i];
			const elB = elements[i + 1];
			const cutDiff = Math.abs(elA.startTime + elA.duration - elB.startTime);
			// 3 frames tolerance
			if (cutDiff <= Math.round((TICKS_PER_SECOND / 30) * 3)) {
				const cutTime = elA.startTime + elA.duration;
				const dist = Math.abs(currentTime - cutTime);
				if (!bestTarget || dist < bestTarget.distance) {
					bestTarget = {
						trackId: track.id,
						elA,
						elB,
						distance: dist,
					};
				}
			}
		}
	}

	if (bestTarget) {
		const transitionId = addOrUpdateTransition({
			trackId: bestTarget.trackId,
			fromElementId: bestTarget.elA.id,
			toElementId: bestTarget.elB.id,
			type,
		});
		setSelectedTransition({
			trackId: bestTarget.trackId,
			transitionId,
		});
		return { success: true, message: "Added transition to cut point!" };
	}

	return {
		success: false,
		message: "Place 2 adjacent clips on a video track first.",
	};
}

const CATEGORIES: Array<{ id: TransitionCategory | "all"; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "fade", label: "Fade" },
	{ id: "basic", label: "Basic" },
	{ id: "camera", label: "Camera" },
	{ id: "slide", label: "Slide" },
	{ id: "wipe", label: "Wipe" },
	{ id: "glitch", label: "Glitch" },
];

export function TransitionsView() {
	const editor = useEditor();
	const [activeCategory, setActiveCategory] = useState<
		TransitionCategory | "all"
	>("all");
	const [searchQuery, setSearchQuery] = useState("");
	const [appliedToast, setAppliedToast] = useState<string | null>(null);

	const allTransitions = useMemo(() => transitionsRegistry.getAll(), []);

	const filteredTransitions = useMemo(() => {
		return allTransitions.filter((trans) => {
			const matchesCategory =
				activeCategory === "all" || trans.category === activeCategory;
			const matchesSearch =
				searchQuery === "" ||
				trans.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
				trans.description.toLowerCase().includes(searchQuery.toLowerCase());
			return matchesCategory && matchesSearch;
		});
	}, [allTransitions, activeCategory, searchQuery]);

	const handleAddTransition = (type: string) => {
		const res = applyTransitionToNearestCut({
			type,
			currentTime: editor.playback.getCurrentTime(),
		});
		setAppliedToast(res.message);
		setTimeout(() => setAppliedToast(null), 2500);
	};

	const handleApplyAll = (type: string) => {
		const count = applyTransitionToAllCuts({ type });
		if (count > 0) {
			setAppliedToast(`Applied to ${count} cut${count > 1 ? "s" : ""}!`);
		} else {
			setAppliedToast("No adjacent cuts found on timeline.");
		}
		setTimeout(() => setAppliedToast(null), 2500);
	};

	return (
		<PanelView
			title="Transitions"
			actions={
				appliedToast ? (
					<span className="text-xs text-primary font-medium animate-pulse flex items-center gap-1">
						<Check className="size-3.5" /> {appliedToast}
					</span>
				) : null
			}
		>
			<div className="flex flex-col gap-3 p-1">
				{/* Search & Categories */}
				<div className="relative">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
					<Input
						placeholder="Search 20+ transitions..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-8 h-8 text-xs"
					/>
				</div>

				<div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-none">
					{CATEGORIES.map((cat) => (
						<button
							key={cat.id}
							type="button"
							onClick={() => setActiveCategory(cat.id)}
							className={cn(
								"px-2.5 py-1 text-xs rounded-full font-medium transition-colors shrink-0 cursor-pointer",
								activeCategory === cat.id
									? "bg-primary text-primary-foreground"
									: "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
							)}
						>
							{cat.label}
						</button>
					))}
				</div>

				{/* Grid of Transition Cards */}
				<div
					className="grid gap-2"
					style={{
						gridTemplateColumns: "repeat(auto-fill, minmax(105px, 1fr))",
					}}
				>
					{filteredTransitions.map((trans) => (
						<TransitionCard
							key={trans.type}
							definition={trans}
							onAdd={() => handleAddTransition(trans.type)}
							onApplyToAll={() => handleApplyAll(trans.type)}
						/>
					))}
				</div>

				{filteredTransitions.length === 0 && (
					<div className="py-8 text-center text-xs text-muted-foreground">
						No transitions match your search.
					</div>
				)}
			</div>
		</PanelView>
	);
}

// Generate sample frames for previewing
function createSampleFrames(width: number, height: number): [OffscreenCanvas, OffscreenCanvas] {
	const cA = new OffscreenCanvas(width, height);
	const ctxA = cA.getContext("2d")!;
	const gradA = ctxA.createLinearGradient(0, 0, width, height);
	gradA.addColorStop(0, "#f97316"); // Orange
	gradA.addColorStop(1, "#ec4899"); // Pink
	ctxA.fillStyle = gradA;
	ctxA.fillRect(0, 0, width, height);
	ctxA.fillStyle = "#ffffff";
	ctxA.font = "bold 14px sans-serif";
	ctxA.textAlign = "center";
	ctxA.textBaseline = "middle";
	ctxA.fillText("Scene A", width / 2, height / 2);

	const cB = new OffscreenCanvas(width, height);
	const ctxB = cB.getContext("2d")!;
	const gradB = ctxB.createLinearGradient(0, 0, width, height);
	gradB.addColorStop(0, "#06b6d4"); // Cyan
	gradB.addColorStop(1, "#3b82f6"); // Blue
	ctxB.fillStyle = gradB;
	ctxB.fillRect(0, 0, width, height);
	ctxB.fillStyle = "#ffffff";
	ctxB.font = "bold 14px sans-serif";
	ctxB.textAlign = "center";
	ctxB.textBaseline = "middle";
	ctxB.fillText("Scene B", width / 2, height / 2);

	return [cA, cB];
}

function TransitionPreviewCanvas({
	definition,
	isHovered,
}: {
	definition: TransitionDefinition;
	isHovered: boolean;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const animIdRef = useRef<number | null>(null);
	const samplesRef = useRef<[OffscreenCanvas, OffscreenCanvas] | null>(null);

	const drawFrame = useCallback(
		(progress: number) => {
			const canvas = canvasRef.current;
			if (!canvas) return;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;

			if (!samplesRef.current) {
				samplesRef.current = createSampleFrames(canvas.width, canvas.height);
			}

			const [srcA, srcB] = samplesRef.current;
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			definition.render(ctx, srcA, srcB, progress, {
				width: canvas.width,
				height: canvas.height,
			});
		},
		[definition],
	);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		canvas.width = 120;
		canvas.height = 70;

		if (!isHovered) {
			if (animIdRef.current) {
				cancelAnimationFrame(animIdRef.current);
				animIdRef.current = null;
			}
			// Static poster frame at 50%
			drawFrame(0.5);
			return;
		}

		let startTime: number | null = null;
		const durationMs = 1400;

		const loop = (timestamp: number) => {
			if (!startTime) startTime = timestamp;
			const elapsed = (timestamp - startTime) % durationMs;
			const progress = elapsed / durationMs;
			drawFrame(progress);
			animIdRef.current = requestAnimationFrame(loop);
		};

		animIdRef.current = requestAnimationFrame(loop);

		return () => {
			if (animIdRef.current) {
				cancelAnimationFrame(animIdRef.current);
			}
		};
	}, [isHovered, drawFrame]);

	return (
		<canvas
			ref={canvasRef}
			className="size-full rounded-md object-cover shadow-xs border border-border/40"
		/>
	);
}

function TransitionCard({
	definition,
	onAdd,
	onApplyToAll,
}: {
	definition: TransitionDefinition;
	onAdd: () => void;
	onApplyToAll: () => void;
}) {
	const [isHovered, setIsHovered] = useState(false);

	return (
		<div
			className="group relative flex flex-col items-center gap-1.5 p-1 rounded-lg border border-border/40 bg-card hover:bg-accent/40 hover:border-border transition-all"
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			<DraggableItem
				name={definition.name}
				preview={
					<TransitionPreviewCanvas
						definition={definition}
						isHovered={isHovered}
					/>
				}
				dragData={{
					id: definition.type,
					name: definition.name,
					type: "transition",
					transitionType: definition.type,
					defaultDuration: definition.defaultDuration,
				}}
				onAddToTimeline={onAdd}
				aspectRatio={120 / 70}
				isRounded
				variant="card"
				containerClassName="w-full"
			/>

			<div className="w-full flex items-center justify-between px-1">
				<span
					className="text-[11px] font-medium text-foreground truncate max-w-[60px]"
					title={definition.name}
				>
					{definition.name}
				</span>
				<div className="flex items-center gap-0.5">
					<Button
						size="icon"
						variant="ghost"
						title={`Add ${definition.name} to cut`}
						onClick={onAdd}
						className="size-5.5 text-muted-foreground hover:bg-primary/20 hover:text-primary transition-all p-0"
					>
						<Plus className="size-3" />
					</Button>
					<Button
						size="icon"
						variant="ghost"
						title={`Apply ${definition.name} to all cuts`}
						onClick={onApplyToAll}
						className="size-5.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:bg-primary/20 hover:text-primary transition-all p-0"
					>
						<Wand2 className="size-3" />
					</Button>
				</div>
			</div>
		</div>
	);
}
