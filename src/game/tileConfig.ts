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
  [TileType.Dirt]: [0, 1, 2],
  [TileType.Grass]: [5, 6, 7],
  [TileType.Stone]: [103],
  [TileType.Water]: [253],
  [TileType.Forest]: [49, 50, 51, 52, 53, 54, 101, 102],
  [TileType.Farmland]: [310],
  [TileType.Ore]: [522],
  [TileType.Mushroom]: [554],
  [TileType.Wall]: [103, 637, 892],
};

/** Single-frame sprite assignments for non-terrain game objects. */
export const SPRITE_CONFIG: Record<string, number> = {
  dwarf: 318,
  goblin: 124,
  tombstone: 686,
  foodStockpile: 439,
  oreStockpile: 241,
};
