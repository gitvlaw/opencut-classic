/**
 * Exact trilinear 3D LUT sampling in JS. Used by the CPU fallback path
 * (no GPU) and shared by tests. Table order: red fastest, then green,
 * then blue — same as .cube file order.
 */
export function sampleLutTrilinear({
	table,
	size,
	r,
	g,
	b,
}: {
	table: Float32Array | number[];
	size: number;
	r: number;
	g: number;
	b: number;
}): [number, number, number] {
	const n = size;
	const x = Math.min(1, Math.max(0, r)) * (n - 1);
	const y = Math.min(1, Math.max(0, g)) * (n - 1);
	const z = Math.min(1, Math.max(0, b)) * (n - 1);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const z0 = Math.floor(z);
	const x1 = Math.min(x0 + 1, n - 1);
	const y1 = Math.min(y0 + 1, n - 1);
	const z1 = Math.min(z0 + 1, n - 1);
	const fx = x - x0;
	const fy = y - y0;
	const fz = z - z0;

	const at = (ix: number, iy: number, iz: number): [number, number, number] => {
		const o = ((iz * n + iy) * n + ix) * 3;
		return [table[o]!, table[o + 1]!, table[o + 2]!];
	};
	const lerp = (a: number, b2: number, t: number) => a + (b2 - a) * t;
	const mix3 = (
		a: [number, number, number],
		c: [number, number, number],
		t: number,
	): [number, number, number] => [lerp(a[0], c[0], t), lerp(a[1], c[1], t), lerp(a[2], c[2], t)];

	const c00 = mix3(at(x0, y0, z0), at(x1, y0, z0), fx);
	const c10 = mix3(at(x0, y1, z0), at(x1, y1, z0), fx);
	const c01 = mix3(at(x0, y0, z1), at(x1, y0, z1), fx);
	const c11 = mix3(at(x0, y1, z1), at(x1, y1, z1), fx);
	const c0 = mix3(c00, c10, fy);
	const c1 = mix3(c01, c11, fy);
	return mix3(c0, c1, fz);
}

export function applyLutToImageData({
	img,
	table,
	size,
	intensity,
}: {
	img: ImageData;
	table: Float32Array | number[];
	size: number;
	intensity: number;
}): void {
	if (intensity <= 0.001) return;
	const t = Math.min(1, Math.max(0, intensity));
	const d = img.data;
	for (let i = 0; i < d.length; i += 4) {
		const [lr, lg, lb] = sampleLutTrilinear({
			table,
			size,
			r: d[i]! / 255,
			g: d[i + 1]! / 255,
			b: d[i + 2]! / 255,
		});
		d[i] = d[i]! + (lr * 255 - d[i]!) * t;
		d[i + 1] = d[i + 1]! + (lg * 255 - d[i + 1]!) * t;
		d[i + 2] = d[i + 2]! + (lb * 255 - d[i + 2]!) * t;
	}
}
