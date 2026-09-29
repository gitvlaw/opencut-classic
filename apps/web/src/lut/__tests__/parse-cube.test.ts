import { describe, expect, it } from "bun:test";
import { CubeParseError, parseCube } from "../parse-cube";

const VALID_CUBE = `# comment
TITLE "Test LUT"
LUT_3D_SIZE 2
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
1.0 1.0 0.0
0.0 0.0 1.0
1.0 0.0 1.0
0.0 1.0 1.0
1.0 1.0 1.0
`;

describe("parseCube", () => {
	it("parses a valid 2x2x2 LUT", () => {
		const parsed = parseCube(VALID_CUBE);
		expect(parsed.title).toBe("Test LUT");
		expect(parsed.size).toBe(2);
		expect(parsed.table.length).toBe(2 * 2 * 2 * 3);
		// red-fastest order: second entry is (r=1,g=0,b=0)
		expect(parsed.table[3]).toBe(1);
		expect(parsed.table[4]).toBe(0);
	});

	it("normalizes custom domains", () => {
		const parsed = parseCube(
			`LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n${"0 0 0\n".repeat(7)}2 2 2\n`,
		);
		expect(parsed.table[parsed.table.length - 1]).toBe(1);
	});

	it("rejects 1D LUTs", () => {
		expect(() => parseCube("LUT_1D_SIZE 16\n")).toThrow(CubeParseError);
	});

	it("rejects wrong entry counts", () => {
		expect(() => parseCube("LUT_3D_SIZE 2\n0 0 0\n")).toThrow(CubeParseError);
	});

	it("rejects missing size", () => {
		expect(() => parseCube("0 0 0\n")).toThrow(CubeParseError);
	});

	it("rejects non-numeric rows", () => {
		expect(() => parseCube("LUT_3D_SIZE 2\n0 0 x\n")).toThrow(CubeParseError);
	});
});
