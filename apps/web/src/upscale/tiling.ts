export interface ImageTile {
	/** top-left in source pixels */
	x: number;
	y: number;
	w: number;
	h: number;
	/** true when the edge is shared with a neighbor (needsblend ramp) */
	sharedLeft: boolean;
	sharedRight: boolean;
	sharedTop: boolean;
	sharedBottom: boolean;
}

/**
 * Cover W×H with `tile`-size tiles bleeding `overlap` px into neighbors.
 * Edge tiles clamp to the frame (overlap with the last neighbor grows).
 */
export function computeTiles(
	width: number,
	height: number,
	tile: number,
	overlap: number,
): ImageTile[] {
	const tw = Math.min(tile, width);
	const th = Math.min(tile, height);
	const stepX = Math.max(1, tw - overlap);
	const stepY = Math.max(1, th - overlap);
	const nx = tw >= width ? 1 : Math.ceil((width - overlap) / stepX);
	const ny = th >= height ? 1 : Math.ceil((height - overlap) / stepY);
	const tiles: ImageTile[] = [];
	for (let iy = 0; iy < ny; iy++) {
		for (let ix = 0; ix < nx; ix++) {
			const x = nx === 1 ? 0 : Math.min(ix * stepX, width - tw);
			const y = ny === 1 ? 0 : Math.min(iy * stepY, height - th);
			tiles.push({
				x,
				y,
				w: tw,
				h: th,
				sharedLeft: ix > 0,
				sharedRight: ix < nx - 1,
				sharedTop: iy > 0,
				sharedBottom: iy < ny - 1,
			});
		}
	}
	return tiles;
}

function ramp(t: number, overlap: number): number {
	if (overlap <= 0) return 1;
	return Math.min(1, Math.max(0, t / overlap));
}

/**
 * Blend weight for a pixel at tile-local (lx, ly). Linear ramps across
 * shared edges; accumulation is weight-normalized downstream (like the
 * vocal worker's overlap-add), so any positive coverage is exact.
 */
export function tileWeight(
	tile: ImageTile,
	lx: number,
	ly: number,
	overlap: number,
): number {
	let wx = 1;
	let wy = 1;
	if (tile.sharedLeft) wx = Math.min(wx, ramp(lx + 0.5, overlap));
	if (tile.sharedRight) wx = Math.min(wx, ramp(tile.w - 0.5 - lx, overlap));
	if (tile.sharedTop) wy = Math.min(wy, ramp(ly + 0.5, overlap));
	if (tile.sharedBottom) wy = Math.min(wy, ramp(tile.h - 0.5 - ly, overlap));
	return wx * wy;
}
