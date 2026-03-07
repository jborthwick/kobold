/**
 * Tile-finding and A* pathfinding: pathNextStep, bestFoodTile, bestMaterialTile, bestWoodTile.
 */

import * as ROT from 'rot-js';
import { TileType, type Goblin, type Tile } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { isWalkable } from '../world';
import { FORAGEABLE_TILES } from './sites';

/**
 * Scan for richest forageable tile in a square radius.
 * Applies a distance penalty of 1.0 per tile so the goblin only leaves its
 * current tile for one that's meaningfully richer — prevents oscillation between
 * two adjacent patches with similar food values.
 */
export function bestFoodTile(
  goblin: Goblin,
  grid: Tile[][],
  radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 0; // start at 0 so a tile with exactly foodValue=1 at dist=0 wins (v=1>0)
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = goblin.x + dx;
      const ny = goblin.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (!FORAGEABLE_TILES.has(grid[ny][nx].type)) continue;
      if (grid[ny][nx].foodValue < 1) continue; // skip sub-threshold tiles (can't harvest)
      const dist = Math.abs(dx) + Math.abs(dy);
      const v = grid[ny][nx].foodValue - dist;
      if (v > bestValue) { bestValue = v; best = { x: nx, y: ny }; }
    }
  }
  return best;
}

export function bestMaterialTile(
  goblin: Goblin,
  grid: Tile[][],
  radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = goblin.x + dx;
      const ny = goblin.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (grid[ny][nx].type === TileType.Forest) continue;
      if (grid[ny][nx].materialValue < 1) continue;
      const dist = Math.abs(dx) + Math.abs(dy);
      const v = grid[ny][nx].materialValue - dist;
      if (v > bestValue) { bestValue = v; best = { x: nx, y: ny }; }
    }
  }
  return best;
}

export function bestWoodTile(
  goblin: Goblin,
  grid: Tile[][],
  radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = goblin.x + dx;
      const ny = goblin.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      const tile = grid[ny][nx];
      // Forest and TreeStump both provide wood; stumps yield less
      const isWoodSource = tile.type === TileType.Forest ||
        (tile.type === TileType.TreeStump && tile.materialValue >= 1);
      if (!isWoodSource) continue;
      if (tile.materialValue < 1) continue;
      const dist = Math.abs(dx) + Math.abs(dy);
      // Stumps have lower base value (50%) to prioritize full trees
      const baseValue = tile.type === TileType.TreeStump ? tile.materialValue * 0.5 : tile.materialValue;
      const v = baseValue - dist;
      if (v > bestValue) { bestValue = v; best = { x: nx, y: ny }; }
    }
  }
  return best;
}

/**
 * Next step from `from` toward `to` using rot.js A*. Exported for adventurers.
 */
export function pathNextStep(
  from: { x: number; y: number },
  to: { x: number; y: number },
  grid: Tile[][],
): { x: number; y: number } {
  if (from.x === to.x && from.y === to.y) return from;
  const path: { x: number; y: number }[] = [];
  const astar = new ROT.Path.AStar(
    to.x, to.y,
    (x, y) => (x === to.x && y === to.y) || isWalkable(grid, x, y),
    { topology: 4 },
  );
  astar.compute(from.x, from.y, (x, y) => path.push({ x, y }));
  return path[1] ?? from;
}
