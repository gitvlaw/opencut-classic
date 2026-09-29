import { TRANSITION_DEFINITIONS } from "./definitions";
import type { TransitionCategory, TransitionDefinition } from "./types";

class TransitionsRegistry {
	private definitions = new Map<string, TransitionDefinition>();

	constructor() {
		for (const def of TRANSITION_DEFINITIONS) {
			this.definitions.set(def.type, def);
		}
	}

	get(type: string): TransitionDefinition | undefined {
		return this.definitions.get(type);
	}

	getAll(): TransitionDefinition[] {
		return Array.from(this.definitions.values());
	}

	getByCategory(category: TransitionCategory): TransitionDefinition[] {
		return this.getAll().filter((d) => d.category === category);
	}

	has(type: string): boolean {
		return this.definitions.has(type);
	}
}

export const transitionsRegistry = new TransitionsRegistry();
