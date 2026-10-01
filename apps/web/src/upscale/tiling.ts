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
 * One size for every frame. RealESRGAN's receptive field is large (23
 * residual-in-dense blocks), so the quality ceiling is set by how much clean
 * interior each tile keeps — measured against full-frame inference, larger
 * tiles scored strictly better at equal overlap (tile 512/overlap 160 =
 * 66.8 dB vs tile 256/overlap 128 = 54.6 dB) AND needed fewer inferences.
 * Small frames clamp to a single tile inside computeTiles.
 */
export const TILE_SIZE = 512;
/**
 * Must stay strictly greater than 2 * TILE_MARGIN.
 *
 * Each shared edge is trimmed by TILE_MARGIN on BOTH sides, so the region
 * where two tiles still overlap is `TILE_OVERLAP - 2 * TILE_MARGIN`. At zero
 * or below, neighbours only touch, the feathering ramps run over pixels that
 * were already discarded, and every tile border becomes a hard cut between
 * two independently inferred images — a visible grid of blocks.
 *
 * 160 against a 64px margin leaves a 32px blend band. Measured: 62.4 dB on a
 * 1920x1080 frame, where anything above ~55 dB is visually seamless.
 */
export const TILE_OVERLAP = 160;
/**
 * Source pixels within this distance of a shared tile edge are reconstructed
 * from zero-padded context and are unreliable.
 *
 * Measured error against full-frame inference for a 32px zero ring: total
 * garbage inside 32px, 0.019 mean error at 32-48px, 0.0036 at 64-96px, and
 * 0.0005 past 128px. CUGAN's 8px is nowhere near enough here — at margin 8
 * the stitch scored 41-49 dB and the grid was plainly visible. 64px holds
 * every shared edge below 1/255 and is a fixed cost regardless of tile size.
 */
export const TILE_MARGIN = 64;

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

/** Horizontal blend weight factor at tile-local x (1 = full weight). */
export function tileWeightX({
	tile,
	lx,
	overlap,
}: {
	tile: ImageTile;
	lx: number;
	overlap: number;
}): number {
	let wx = 1;
	if (tile.sharedLeft) wx = Math.min(wx, ramp(lx + 0.5, overlap));
	if (tile.sharedRight) wx = Math.min(wx, ramp(tile.w - 0.5 - lx, overlap));
	return wx;
}

/** Vertical blend weight factor at tile-local y (1 = full weight). */
export function tileWeightY({
	tile,
	ly,
	overlap,
}: {
	tile: ImageTile;
	ly: number;
	overlap: number;
}): number {
	let wy = 1;
	if (tile.sharedTop) wy = Math.min(wy, ramp(ly + 0.5, overlap));
	if (tile.sharedBottom) wy = Math.min(wy, ramp(tile.h - 0.5 - ly, overlap));
	return wy;
}

/**
 * Blend weight for a pixel at tile-local (lx, ly). Linear ramps across
 * shared edges; accumulation is weight-normalized downstream (like the
 * vocal worker's overlap-add), so any positive coverage is exact.
 *
 * Separable: `tileWeight(lx, ly) === tileWeightX(lx) * tileWeightY(ly)`, so
 * hot loops can build the two 1D ramps once per tile.
 */
export function tileWeight(
	tile: ImageTile,
	lx: number,
	ly: number,
	overlap: number,
): number {
	return (
		tileWeightX({ tile, lx, overlap }) * tileWeightY({ tile, ly, overlap })
	);
}
