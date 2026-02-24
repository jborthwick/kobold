// AUTO-MANAGED by tile picker (T key in-game → Save).
// Manual edits are safe but will be overwritten on next Save.
import { TileType } from '../shared/types';

/**
 * Frame arrays per tile type.
 * - Single entry  → that frame is always used.
 * - Multiple entries → one is chosen per-tile by position noise (variation).
 *
 * Frame index = row * 49 + col  (0-based, 49 cols × 22 rows, 16×16 px, no spacing).
 */
export const TILE_CONFIG: Partial<Record<TileType, number[]>> = {
  [TileType.Dirt]:     [0, 1, 2],  // row 0 cols 0-2: plain dark → sparse dots → denser dots
  [TileType.Grass]:    [6, 7, 8],  // row 0 cols 6-8: green tufts (38/44 GREEN px) + darker variant
  [TileType.Forest]:   [54],       // row 1, col 5  – 110 green pixels (pine tree)
  [TileType.Water]:    [204],      // row 4, col 8  – 166 blue
  [TileType.Stone]:    [72],       // row 1, col 23 – 186 gray (stone tile)
  [TileType.Farmland]: [150],      // row 3, col 3  – 150 tan (soil tile)
  [TileType.Ore]:      [513],      // row 10, col 23 – 118 yellow pixels (gold/mineral)
};

/** Single-frame sprite assignments for non-terrain game objects. */
export const SPRITE_CONFIG: Record<string, number> = {
  dwarf: 26,  // row 0, col 26 – humanoid warrior (80 GRAY)
};
