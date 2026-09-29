"use client";

import { useMemo, useState } from "react";
import { Trash2, Sparkles, Wand2, Check } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEditor } from "@/editor/use-editor";
import { useTransitionsStore } from "../store";
import {
	getActiveTrackTransition,
	updateTransitionConfig,
	removeTransition,
	applyTransitionToAllCuts,
} from "../service";
import { transitionsRegistry } from "../registry";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";
import { cn } from "@/utils/ui";

const EASING_OPTIONS = [
	{ id: "ease-in-out", label: "Ease In Out" },
	{ id: "ease-in", label: "Ease In" },
	{ id: "ease-out", label: "Ease Out" },
	{ id: "linear", label: "Linear" },
	{ id: "cubic-in-out", label: "Cubic Smooth" },
	{ id: "expo-out", label: "Exponential Out" },
];

export function TransitionPropertiesPanel() {
	const editor = useEditor();
	useEditor((e) => e.scenes.getActiveSceneOrNull());
	const { selectedTransition, setSelectedTransition } = useTransitionsStore();
	const [appliedToast, setAppliedToast] = useState<string | null>(null);
	const [localDurationStr, setLocalDurationStr] = useState<string | null>(null);

	const transition = selectedTransition
		? getActiveTrackTransition(selectedTransition)
		: null;

	const definition = transition
		? transitionsRegistry.get(transition.type)
		: null;

	const allDefinitions = useMemo(() => transitionsRegistry.getAll(), []);

	if (!selectedTransition || !transition || !definition) {
		return null;
	}

	const durationSeconds = Number((transition.duration / TICKS_PER_SECOND).toFixed(2));
	const displayDuration =
		localDurationStr !== null ? localDurationStr : durationSeconds.toString();

	const handleDurationChange = (seconds: number) => {
		setLocalDurationStr(null);
		const clampedSeconds = Math.max(0.1, Math.min(3.0, seconds));
		const ticks = mediaTime({ ticks: Math.round(clampedSeconds * TICKS_PER_SECOND) });
		updateTransitionConfig({
			trackId: selectedTransition.trackId,
			transitionId: selectedTransition.transitionId,
			updates: { duration: ticks },
		});
	};

	const handleDurationInputChange = (val: string) => {
		setLocalDurationStr(val);
		const parsed = parseFloat(val);
		if (!isNaN(parsed) && parsed >= 0.05 && parsed <= 5.0) {
			const clamped = Math.max(0.1, Math.min(3.0, parsed));
			const ticks = mediaTime({ ticks: Math.round(clamped * TICKS_PER_SECOND) });
			updateTransitionConfig({
				trackId: selectedTransition.trackId,
				transitionId: selectedTransition.transitionId,
				updates: { duration: ticks },
			});
		}
	};

	const handleDurationInputBlur = () => {
		setLocalDurationStr(null);
	};

	const handleTypeChange = (newType: string) => {
		updateTransitionConfig({
			trackId: selectedTransition.trackId,
			transitionId: selectedTransition.transitionId,
			updates: { type: newType },
		});
	};

	const handleAlignmentChange = (alignment: "center" | "start" | "end") => {
		updateTransitionConfig({
			trackId: selectedTransition.trackId,
			transitionId: selectedTransition.transitionId,
			updates: { alignment },
		});
	};

	const handleDirectionChange = (direction: "left" | "right" | "up" | "down") => {
		updateTransitionConfig({
			trackId: selectedTransition.trackId,
			transitionId: selectedTransition.transitionId,
			updates: { direction },
		});
	};

	const handleEasingChange = (easing: string) => {
		updateTransitionConfig({
			trackId: selectedTransition.trackId,
			transitionId: selectedTransition.transitionId,
			updates: { easing },
		});
	};

	const handleDelete = () => {
		removeTransition(selectedTransition);
	};

	const handleApplyAll = () => {
		const count = applyTransitionToAllCuts({
			type: transition.type,
			duration: transition.duration,
		});
		setAppliedToast(`Applied to ${count} cut${count > 1 ? "s" : ""}!`);
		setTimeout(() => setAppliedToast(null), 2500);
	};

	return (
		<div className="panel bg-background flex h-full flex-col overflow-hidden rounded-sm border">
			{/* Header */}
			<div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
				<div className="flex items-center gap-2">
					<div className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
						<Sparkles className="size-4" />
					</div>
					<div>
						<h3 className="text-xs font-semibold leading-none">{definition.name}</h3>
						<span className="text-[10px] text-muted-foreground capitalize">
							{definition.category} Transition
						</span>
					</div>
				</div>

				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon"
						title="Delete Transition"
						onClick={handleDelete}
						className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive cursor-pointer"
					>
						<Trash2 className="size-3.5" />
					</Button>
				</div>
			</div>

			<ScrollArea className="flex-1 p-4">
				<div className="space-y-4">
					{/* Type Switcher */}
					<div className="space-y-1.5">
						<Label className="text-[11px] text-muted-foreground">Transition Type</Label>
						<Select value={transition.type} onValueChange={handleTypeChange}>
							<SelectTrigger className="h-8 text-xs">
								<SelectValue placeholder="Select transition" />
							</SelectTrigger>
							<SelectContent className="max-h-60">
								{allDefinitions.map((d) => (
									<SelectItem key={d.type} value={d.type} className="text-xs">
										{d.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/* Duration */}
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<Label className="text-[11px] text-muted-foreground">Duration</Label>
							<div className="flex items-center gap-1">
								<Input
									type="number"
									step="0.05"
									min="0.1"
									max="3.0"
									value={displayDuration}
									onChange={(e) => handleDurationInputChange(e.target.value)}
									onBlur={handleDurationInputBlur}
									className="h-6 w-16 px-1.5 text-right text-xs"
								/>
								<span className="text-[11px] text-muted-foreground">s</span>
							</div>
						</div>
						<Slider
							value={[durationSeconds]}
							min={0.1}
							max={2.0}
							step={0.05}
							onValueChange={([val]) => handleDurationChange(val)}
							className="py-1 cursor-pointer"
						/>
					</div>

					{/* Alignment */}
					<div className="space-y-1.5">
						<Label className="text-[11px] text-muted-foreground">Alignment</Label>
						<div className="grid grid-cols-3 gap-1">
							{(
								[
									{ id: "center", label: "Center" },
									{ id: "start", label: "Start" },
									{ id: "end", label: "End" },
								] as const
							).map((align) => (
								<button
									key={align.id}
									type="button"
									onClick={() => handleAlignmentChange(align.id)}
									className={cn(
										"py-1.5 px-2 text-xs rounded-md border font-medium transition-colors cursor-pointer text-center",
										(transition.alignment ?? "center") === align.id
											? "bg-primary text-primary-foreground border-primary"
											: "bg-muted/40 border-border/60 hover:bg-muted text-foreground",
									)}
								>
									{align.label}
								</button>
							))}
						</div>
					</div>

					{/* Direction (if applicable) */}
					{(definition.hasDirection ||
						transition.type.startsWith("slide") ||
						transition.type === "push") && (
						<div className="space-y-1.5">
							<Label className="text-[11px] text-muted-foreground">Direction</Label>
							<div className="grid grid-cols-4 gap-1">
								{(
									[
										{ id: "left", label: "Left (←)" },
										{ id: "right", label: "Right (→)" },
										{ id: "up", label: "Up (↑)" },
										{ id: "down", label: "Down (↓)" },
									] as const
								).map((dir) => (
									<button
										key={dir.id}
										type="button"
										onClick={() => handleDirectionChange(dir.id)}
										className={cn(
											"py-1 text-xs rounded-md border font-medium transition-colors cursor-pointer text-center",
											(transition.direction ?? "left") === dir.id
												? "bg-primary text-primary-foreground border-primary"
												: "bg-muted/40 border-border/60 hover:bg-muted text-foreground",
										)}
									>
										{dir.id}
									</button>
								))}
							</div>
						</div>
					)}

					{/* Easing */}
					<div className="space-y-1.5">
						<Label className="text-[11px] text-muted-foreground">Easing Curve</Label>
						<Select
							value={transition.easing ?? "ease-in-out"}
							onValueChange={handleEasingChange}
						>
							<SelectTrigger className="h-8 text-xs">
								<SelectValue placeholder="Select easing" />
							</SelectTrigger>
							<SelectContent>
								{EASING_OPTIONS.map((opt) => (
									<SelectItem key={opt.id} value={opt.id} className="text-xs">
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/* Batch Apply */}
					<div className="pt-2 border-t space-y-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleApplyAll}
							className="w-full text-xs gap-1.5 cursor-pointer h-8"
						>
							<Wand2 className="size-3.5" />
							Apply to All Video Cuts
						</Button>
						{appliedToast && (
							<div className="text-center text-xs text-primary font-medium flex items-center justify-center gap-1 animate-pulse">
								<Check className="size-3.5" /> {appliedToast}
							</div>
						)}
					</div>
				</div>
			</ScrollArea>
		</div>
	);
}
