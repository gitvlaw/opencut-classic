"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { usePropertiesStore } from "./stores/properties-store";
import { getPropertiesConfig } from "./registry";
import { cn } from "@/utils/ui";
import { EmptyView } from "./empty-view";
import { useTransitionsStore } from "@/transitions/store";
import { TransitionPropertiesPanel } from "@/transitions/components/transition-properties-panel";

export function PropertiesPanel() {
	const editor = useEditor();
	useEditor((e) => e.scenes.getActiveSceneOrNull());
	useEditor((e) => e.media.getAssets());
	const { selectedElements } = useElementSelection();
	const { activeTabPerType, setActiveTab } = usePropertiesStore();
	const { selectedTransition } = useTransitionsStore();

	if (selectedTransition) {
		return <TransitionPropertiesPanel />;
	}

	if (selectedElements.length === 0) {
		return (
			<div className="panel bg-background flex h-full flex-col items-center justify-center overflow-hidden rounded-sm border">
				<EmptyView />
			</div>
		);
	}

	const mediaAssets = editor.media.getAssets();

	const elementsWithTracks = editor.timeline.getElementsWithTracks({
		elements: selectedElements,
	});
	const elementWithTrack = elementsWithTracks[0];

	if (!elementWithTrack) return null;

	if (elementsWithTracks.length > 1) {
		const firstType = elementsWithTracks[0].element.type;
		const allSameType = elementsWithTracks.every(
			(el) => el.element.type === firstType,
		);

		if (!allSameType) {
			return (
				<div className="panel bg-background flex h-full flex-col items-center justify-center overflow-hidden rounded-sm border p-4 text-center">
					<p className="text-muted-foreground text-sm font-medium">
						{elementsWithTracks.length} elements selected
					</p>
					<p className="text-muted-foreground text-xs mt-1">
						Select elements of the same type to edit them together.
					</p>
				</div>
			);
		}
	}

	const { element, track } = elementWithTrack;
	const config = getPropertiesConfig({
		element,
		mediaAssets,
		elementsWithTracks,
	});
	const visibleTabs = config.tabs;

	const storedTabId = activeTabPerType[element.type];
	const isStoredTabVisible = visibleTabs.some((t) => t.id === storedTabId);
	const activeTabId = isStoredTabVisible ? storedTabId : config.defaultTab;
	const activeTab =
		visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[0];

	if (!activeTab) return null;

	const isMultiSelect = selectedElements.length > 1;

	return (
		<div className="panel bg-background flex h-full flex-col overflow-hidden rounded-sm border">
			{isMultiSelect && (
				<div className="px-3 py-1.5 border-b bg-muted/30 flex items-center justify-between text-xs shrink-0">
					<span className="font-medium text-foreground">
						{element.type === "text"
							? `${selectedElements.length} Captions / Texts`
							: `${selectedElements.length} Elements`}
					</span>
					<span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground bg-accent px-1.5 py-0.5 rounded">
						Batch Edit
					</span>
				</div>
			)}
			<div className="flex flex-1 min-h-0 overflow-hidden">
				<TooltipProvider delayDuration={0}>
					<div className="flex shrink-0 flex-col gap-0.5 border-r p-1 scrollbar-hidden overflow-y-auto">
						{visibleTabs.map((tab) => (
							<Tooltip key={tab.id}>
								<TooltipTrigger asChild>
									<Button
										variant={tab.id === activeTab.id ? "secondary" : "ghost"}
										size="icon"
										onClick={() =>
											setActiveTab({
												elementType: element.type,
												tabId: tab.id,
											})
										}
										aria-label={tab.label}
										className={cn(
											"shrink-0",
											"h-8 w-8",
											tab.id !== activeTab.id && "text-muted-foreground",
										)}
									>
										{tab.icon}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="right">{tab.label}</TooltipContent>
							</Tooltip>
						))}
					</div>
				</TooltipProvider>
				<ScrollArea className="flex-1 scrollbar-hidden">
					{activeTab.content({ trackId: track.id })}
				</ScrollArea>
			</div>
		</div>
	);
}
