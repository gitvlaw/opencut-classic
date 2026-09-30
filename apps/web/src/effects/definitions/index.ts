import { effectsRegistry } from "../registry";
import { adjustEffectDefinition } from "./adjust";
import { blurEffectDefinition } from "./blur";
import { curvesEffectDefinition } from "./curves";
import { filterEffectDefinition } from "./filter";
import { hslEffectDefinition } from "./hsl";
import { lutEffectDefinition } from "./lut";
import { wheelsEffectDefinition } from "./wheels";

const defaultEffects = [
	blurEffectDefinition,
	adjustEffectDefinition,
	hslEffectDefinition,
	curvesEffectDefinition,
	filterEffectDefinition,
	lutEffectDefinition,
	wheelsEffectDefinition,
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
