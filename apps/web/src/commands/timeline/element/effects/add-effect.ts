import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { isVisualElement, updateElementInSceneTracks } from "@/timeline";
import type { SceneTracks, VisualElement } from "@/timeline";
import type { ParamValues } from "@/params";
import { buildDefaultEffectInstance } from "@/effects";

function addEffectToElement({
	element,
	effectType,
	initialParams,
}: {
	element: VisualElement;
	effectType: string;
	initialParams?: ParamValues;
}): VisualElement {
	const instance = buildDefaultEffectInstance({ effectType });
	if (initialParams) {
		instance.params = { ...instance.params, ...initialParams };
	}
	const currentEffects = element.effects ?? [];
	return { ...element, effects: [...currentEffects, instance] };
}

export class AddClipEffectCommand extends Command {
	private savedState: SceneTracks | null = null;
	private effectId: string | null = null;
	private readonly trackId: string;
	private readonly elementId: string;
	private readonly effectType: string;
	private readonly initialParams?: ParamValues;

	constructor({
		trackId,
		elementId,
		effectType,
		initialParams,
	}: {
		trackId: string;
		elementId: string;
		effectType: string;
		initialParams?: ParamValues;
	}) {
		super();
		this.trackId = trackId;
		this.elementId = elementId;
		this.effectType = effectType;
		this.initialParams = initialParams;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const updatedTracks = updateElementInSceneTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			elementId: this.elementId,
			elementPredicate: isVisualElement,
			update: (element) => {
			const updated = addEffectToElement({
				element: element as VisualElement,
				effectType: this.effectType,
				initialParams: this.initialParams,
			});
				const effects = updated.effects ?? [];
				this.effectId = effects[effects.length - 1]?.id ?? null;
				return updated;
			},
		});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getEffectId(): string | null {
		return this.effectId;
	}
}
