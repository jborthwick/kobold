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
  [TileType.Wall]: [637, 843, 844, 845, 892, 893],
  [TileType.WoodWall]: [148, 149],
  [TileType.StoneWall]: [637, 843, 844, 845, 892, 893],
  [TileType.Hearth]: [504],
  [TileType.TreeStump]: [104],
  [TileType.Fire]: [505],
  [TileType.Pool]: [253],
};

/** Single-frame sprite assignments for non-terrain game objects. */
export const SPRITE_CONFIG: Record<string, number> = {
  goblin: 123,
  goblinForaging: 129,
  goblinCooking: 178,
  goblinMining: 222,
  goblinWoodcutting: 79,
  goblinSawing: 76,
  goblinSmithing: 173,
  adventurer: 27,
  tombstone: 686,
  foodStockpile: 439,
  oreStockpile: 241,
  woodStockpile: 261,
  saw: 592,
  anvil: 401,
};
