/**
 * World events — blight, bounty, ore_discovery.
 *
 * Layout-agnostic: all event types scan the live grid to find eligible tiles
 * rather than relying on hardcoded coordinate zones.  Works regardless of
 * world-gen changes.
 *
 * Fires once every EVENT_MIN_INTERVAL–EVENT_MAX_INTERVAL ticks (random window
 * scheduled after each event so they don't cluster).
 */

import { TileType, type Tile } from '../shared/types';

// ── Config ────────────────────────────────────────────────────────────────────

const EVENT_MIN_INTERVAL = 300;
const EVENT_MAX_INTERVAL = 600;

// ── Module state ──────────────────────────────────────────────────────────────

let nextEventTick = EVENT_MIN_INTERVAL; // first event fires somewhere in the first window

function scheduleNext(): void {
  nextEventTick += EVENT_MIN_INTERVAL +
    Math.floor(Math.random() * (EVENT_MAX_INTERVAL - EVENT_MIN_INTERVAL));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface GridCoord { x: number; y: number }

function randomItem<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : undefined;
}

function coordsInRadius(
  grid: Tile[][],
  cx: number, cy: number, radius: number,
): GridCoord[] {
  const result: GridCoord[] = [];
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < cols && y >= 0 && y < rows) {
        result.push({ x, y });
      }
    }
  }
  return result;
}

// ── Event implementations ─────────────────────────────────────────────────────

function applyBlight(grid: Tile[][]): string | null {
  // Collect all food-bearing tile coordinates as candidate centres
  const candidates: GridCoord[] = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < (grid[0]?.length ?? 0); x++) {
      if (grid[y][x].maxFood > 0) candidates.push({ x, y });
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;

  const affected = coordsInRadius(grid, centre.x, centre.y, 6);
  for (const { x, y } of affected) {
    const t = grid[y][x];
    if (t.maxFood > 0) {
      t.maxFood   = Math.max(1, Math.floor(t.maxFood   * 0.5));
      t.foodValue = Math.min(t.foodValue, t.maxFood);
    }
  }
  return `Blight struck at (${centre.x},${centre.y}) — food yields halved in a 6-tile radius`;
}

function applyBounty(grid: Tile[][]): string | null {
  const candidates: GridCoord[] = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < (grid[0]?.length ?? 0); x++) {
      if (grid[y][x].maxFood > 0) candidates.push({ x, y });
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;

  const affected = coordsInRadius(grid, centre.x, centre.y, 5);
  for (const { x, y } of affected) {
    const t = grid[y][x];
    if (t.maxFood > 0) {
      t.maxFood   = Math.min(20, Math.ceil(t.maxFood   * 1.5));
      t.foodValue = Math.min(20, Math.ceil(t.foodValue * 1.5));
    }
  }
  return `Bountiful harvest at (${centre.x},${centre.y}) — food yields boosted in a 5-tile radius`;
}

function applyOreDiscovery(grid: Tile[][]): string | null {
  // Pick from walkable (non-water) non-ore tiles as spawn centre
  const candidates: GridCoord[] = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < (grid[0]?.length ?? 0); x++) {
      const t = grid[y][x];
      if (t.type !== TileType.Water && t.type !== TileType.Ore) {
        candidates.push({ x, y });
      }
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;

  const affected = coordsInRadius(grid, centre.x, centre.y, 3);
  let count = 0;
  for (const { x, y } of affected) {
    const t = grid[y][x];
    if (t.type !== TileType.Water && t.type !== TileType.Ore && count < 5) {
      t.type          = TileType.Ore;
      t.maxMaterial   = 15;
      t.materialValue = 15;
      count++;
    }
  }
  return `Ore vein discovered near (${centre.x},${centre.y}) — ${count} new ore tiles`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface WorldEventResult {
  fired:   boolean;
  message: string;
}

export function tickWorldEvents(grid: Tile[][], tick: number): WorldEventResult {
  if (tick < nextEventTick) return { fired: false, message: '' };

  scheduleNext(); // always advance window first (prevents infinite loop on null returns)

  // Pick event type uniformly at random
  const roll = Math.random();
  let msg: string | null = null;

  if (roll < 0.35) {
    msg = applyBlight(grid);
  } else if (roll < 0.7) {
    msg = applyBounty(grid);
  } else {
    msg = applyOreDiscovery(grid);
  }

  if (!msg) return { fired: false, message: '' };
  return { fired: true, message: msg };
}
