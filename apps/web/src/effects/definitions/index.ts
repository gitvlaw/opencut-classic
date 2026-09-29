import { effectsRegistry } from "../registry";
import { adjustEffectDefinition } from "./adjust";
import { blurEffectDefinition } from "./blur";
import { curvesEffectDefinition } from "./curves";
import { filterEffectDefinition } from "./filter";
import { hslEffectDefinition } from "./hsl";
import { lutEffectDefinition } from "./lut";

const defaultEffects = [
	blurEffectDefinition,
	adjustEffectDefinition,
	hslEffectDefinition,
	curvesEffectDefinition,
	filterEffectDefinition,
	lutEffectDefinition,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
