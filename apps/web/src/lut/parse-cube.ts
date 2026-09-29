export interface ParsedCube {
	title: string;
	size: number;
	domainMin: [number, number, number];
	domainMax: [number, number, number];
	/**
	 * Normalized 0..1 RGB triples in .cube file order (red fastest,
	 * then green, then blue). Length = size^3 * 3.
	 */
	table: Float32Array;
}

export class CubeParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CubeParseError";
	}
}

const MAX_LUT_SIZE = 64;

/**
 * Parse an Adobe .cube 3D LUT file. 1D LUTs are rejected — convert them
 * to curves instead.
 */
export function parseCube(text: string): ParsedCube {
	let title = "Untitled";
	let size = 0;
	let domainMin: [number, number, number] = [0, 0, 0];
	let domainMax: [number, number, number] = [1, 1, 1];
	const values: number[] = [];

	const lines = text.split(/\r?\n/);
	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const line = lines[lineNo]!.trim();
		if (!line || line.startsWith("#")) continue;
		const parts = line.split(/\s+/);
		const keyword = parts[0]!.toUpperCase();

		if (keyword === "TITLE") {
			const m = line.match(/"(.*)"/);
			title = m?.[1] ?? parts.slice(1).join(" ") ?? "Untitled";
			continue;
		}
		if (keyword === "LUT_1D_SIZE" || keyword === "LUT_1D_INPUT_RANGE") {
			throw new CubeParseError("1D LUTs are not supported — use Curves instead.");
		}
		if (keyword === "LUT_3D_SIZE") {
			size = Number.parseInt(parts[1] ?? "", 10);
			if (!Number.isInteger(size) || size < 2 || size > MAX_LUT_SIZE) {
				throw new CubeParseError(`Invalid LUT_3D_SIZE: ${parts[1] ?? "(missing)"}.`);
			}
			continue;
		}
		if (keyword === "DOMAIN_MIN" || keyword === "DOMAIN_MAX") {
			const nums = parts.slice(1, 4).map(Number);
			if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) {
				throw new CubeParseError(`Invalid ${keyword} on line ${lineNo + 1}.`);
			}
			if (keyword === "DOMAIN_MIN") domainMin = [nums[0]!, nums[1]!, nums[2]!];
			else domainMax = [nums[0]!, nums[1]!, nums[2]!];
			continue;
		}
		if (keyword === "LUT_3D_INPUT_RANGE") continue;

		// Table row: r g b
		if (parts.length < 3) {
			throw new CubeParseError(`Unexpected line ${lineNo + 1}: "${line}".`);
		}
		const rgb = [parts[0], parts[1], parts[2]].map(Number);
		if (rgb.some((n) => !Number.isFinite(n))) {
			throw new CubeParseError(`Non-numeric table value on line ${lineNo + 1}.`);
		}
		values.push(rgb[0]!, rgb[1]!, rgb[2]!);
	}

	if (!size) throw new CubeParseError("Missing LUT_3D_SIZE header.");
	if (values.length !== size * size * size * 3) {
		throw new CubeParseError(
			`Table has ${values.length / 3} entries but LUT_3D_SIZE ${size} needs ${size ** 3}.`,
		);
	}

	const table = new Float32Array(values.length);
	for (let i = 0; i < values.length; i += 3) {
		table[i] = normalize(values[i]!, domainMin[0]!, domainMax[0]!);
		table[i + 1] = normalize(values[i + 1]!, domainMin[1]!, domainMax[1]!);
		table[i + 2] = normalize(values[i + 2]!, domainMin[2]!, domainMax[2]!);
	}

	return { title, size, domainMin, domainMax, table };
}

function normalize(v: number, min: number, max: number): number {
	if (max === min) return Math.min(1, Math.max(0, v));
	return Math.min(1, Math.max(0, (v - min) / (max - min)));
}
