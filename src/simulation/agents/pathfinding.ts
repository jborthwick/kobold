/**
 * Tile-finding and A* pathfinding: pathNextStep, bestFoodTile, bestMaterialTile, bestWoodTile.
 */

import * as ROT from 'rot-js';
import { TileType, type Goblin, type Tile } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { isWalkable } from '../world';
import { FORAGEABLE_TILES } from './sites';
import { getTerrainMoveCost } from '../movementCost';

type Point = { x: number; y: number };

function keyOf(x: number, y: number): number {
  return y * GRID_SIZE + x;
}

class MinHeap<T> {
  private a: { pri: number; v: T }[] = [];
  get size(): number { return this.a.length; }
  push(pri: number, v: T): void {
    const a = this.a;
    a.push({ pri, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].pri <= a[i].pri) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): { pri: number; v: T } | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].pri < a[m].pri) m = l;
        if (r < a.length && a[r].pri < a[m].pri) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

function unweightedAStarNextStep(from: Point, to: Point, grid: Tile[][]): Point {
  if (from.x === to.x && from.y === to.y) return from;
  const path: Point[] = [];
  const astar = new ROT.Path.AStar(to.x, to.y, (x, y) => isWalkable(grid, x, y), { topology: 4 });
  astar.compute(from.x, from.y, (x, y) => path.push({ x, y }));
  return path[1] ?? from;
}

function weightedNextStep(from: Point, to: Point, grid: Tile[][]): Point | null {
  // If target isn't walkable (e.g. Water/Wall), aim for an adjacent walkable tile instead.
  const goalPoints: Point[] = isWalkable(grid, to.x, to.y)
    ? [to]
    : [
        { x: to.x + 1, y: to.y },
        { x: to.x - 1, y: to.y },
        { x: to.x, y: to.y + 1 },
        { x: to.x, y: to.y - 1 },
      ].filter(p => isWalkable(grid, p.x, p.y));

  if (goalPoints.length === 0) return null;

  const goalKeys = new Set(goalPoints.map(p => keyOf(p.x, p.y)));

  // Bound search to a reasonable box to avoid frame spikes.
  const margin = 24;
  const minX = Math.max(0, Math.min(from.x, ...goalPoints.map(p => p.x)) - margin);
  const maxX = Math.min(GRID_SIZE - 1, Math.max(from.x, ...goalPoints.map(p => p.x)) + margin);
  const minY = Math.max(0, Math.min(from.y, ...goalPoints.map(p => p.y)) - margin);
  const maxY = Math.min(GRID_SIZE - 1, Math.max(from.y, ...goalPoints.map(p => p.y)) + margin);

  const dist = new Map<number, number>();
  const prev = new Map<number, number>(); // childKey -> parentKey
  const pq = new MinHeap<Point>();

  const startKey = keyOf(from.x, from.y);
  dist.set(startKey, 0);
  pq.push(0, from);

  const MAX_EXPANDED = 8000;
  let expanded = 0;

  while (pq.size > 0) {
    const cur = pq.pop()!;
    const ck = keyOf(cur.v.x, cur.v.y);
    const best = dist.get(ck);
    if (best === undefined || cur.pri !== best) continue;

    if (goalKeys.has(ck)) {
      // Reconstruct first step by walking prev pointers from goal back to start.
      let walk = ck;
      let parent = prev.get(walk);
      while (parent !== undefined && parent !== startKey) {
        walk = parent;
        parent = prev.get(walk);
      }
      if (parent === startKey) {
        const x = walk % GRID_SIZE;
        const y = Math.floor(walk / GRID_SIZE);
        return { x, y };
      }
      return null;
    }

    expanded++;
    if (expanded > MAX_EXPANDED) return null;

    const x = cur.v.x;
    const y = cur.v.y;
    const neighbors = [
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 },
    ];

    for (const n of neighbors) {
      if (n.x < minX || n.x > maxX || n.y < minY || n.y > maxY) continue;
      if (!isWalkable(grid, n.x, n.y)) continue;
      const nk = keyOf(n.x, n.y);
      const nd = best + getTerrainMoveCost(grid[n.y][n.x].type);
      const curBest = dist.get(nk);
      if (curBest === undefined || nd < curBest) {
        dist.set(nk, nd);
        prev.set(nk, ck);
        pq.push(nd, n);
      }
    }
  }

  return null;
}

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
      if (grid[ny][nx].type !== TileType.Ore) continue;
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
  const weighted = weightedNextStep(from, to, grid);
  if (weighted) return weighted;
  // Fallback: unweighted rot.js A* (ensures we always return a step even if cost search is capped).
  return unweightedAStarNextStep(from, to, grid);
}
