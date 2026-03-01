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

import { TileType, type Tile, type Dwarf, type Goblin } from '../shared/types';

// ── Config ────────────────────────────────────────────────────────────────────

const EVENT_MIN_INTERVAL = 300;
const EVENT_MAX_INTERVAL = 600;

// ── Module state ──────────────────────────────────────────────────────────────

let nextEventTick = EVENT_MIN_INTERVAL; // first event fires somewhere in the first window

function scheduleNext(): void {
  nextEventTick += EVENT_MIN_INTERVAL +
    Math.floor(Math.random() * (EVENT_MAX_INTERVAL - EVENT_MIN_INTERVAL));
}

/** Returns the tick at which the next world event is scheduled — save this value. */
export function getNextEventTick(): number { return nextEventTick; }

/** Restores the world event schedule from a saved value. */
export function setNextEventTick(tick: number): void { nextEventTick = tick; }

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

function applyMushroomSpread(grid: Tile[][]): string | null {
  // Candidate tiles: Dirt or Grass with no mushroom already within 4 tiles
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const candidates: GridCoord[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = grid[y][x];
      if (t.type !== TileType.Dirt && t.type !== TileType.Grass) continue;
      const nearMushroom = coordsInRadius(grid, x, y, 4)
        .some(({ x: nx, y: ny }) => grid[ny][nx].type === TileType.Mushroom);
      if (!nearMushroom) candidates.push({ x, y });
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;

  // World-event spread is deliberately large (3–5 tile radius, up to 14 tiles)
  // so it feels distinct from the steady per-tick growback on existing tiles.
  const radius  = 3 + Math.floor(Math.random() * 3); // 3–5 tiles
  const affected = coordsInRadius(grid, centre.x, centre.y, radius);
  let count = 0;
  for (const { x, y } of affected) {
    const t = grid[y][x];
    if ((t.type === TileType.Dirt || t.type === TileType.Grass) && Math.random() < 0.6 && count < 14) {
      const fMax = 3 + Math.floor(Math.random() * 3); // 3–5
      grid[y][x] = { type: TileType.Mushroom, foodValue: fMax, maxFood: fMax, materialValue: 0, maxMaterial: 0, growbackRate: 0.08 };
      count++;
    }
  }
  if (count === 0) return null;
  return `Mushrooms sprouted near (${centre.x},${centre.y}) — ${count} new patches`;
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

// ── Steady mushroom sprouting ─────────────────────────────────────────────────

/**
 * Steady mushroom sprouting — fires every 60 ticks (~8 s at 7 tps).
 * Creates a moderate patch (radius 2, up to 8 tiles) in a depleted or open area,
 * keeping the map viable after dwarves strip early patches.
 *
 * Deliberately smaller than the world-event spread (radius 3–5, up to 14 tiles)
 * so the world event still feels like a meaningful bonus.
 */
const MUSHROOM_SPROUT_INTERVAL = 60;

export function tickMushroomSprout(grid: Tile[][], tick: number): string | null {
  if (tick === 0 || tick % MUSHROOM_SPROUT_INTERVAL !== 0) return null;

  // Candidates: Dirt/Grass with no living mushroom patch within 2 tiles
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const candidates: GridCoord[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = grid[y][x];
      if (t.type !== TileType.Dirt && t.type !== TileType.Grass) continue;
      const nearMushroom = coordsInRadius(grid, x, y, 2)
        .some(({ x: nx, y: ny }) => grid[ny][nx].type === TileType.Mushroom);
      if (!nearMushroom) candidates.push({ x, y });
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;

  const affected = coordsInRadius(grid, centre.x, centre.y, 2); // radius 2 — moderate patch
  let count = 0;
  for (const { x, y } of affected) {
    const t = grid[y][x];
    if ((t.type === TileType.Dirt || t.type === TileType.Grass) && Math.random() < 0.7 && count < 8) {
      const fMax = 3 + Math.floor(Math.random() * 3); // 3–5
      grid[y][x] = { type: TileType.Mushroom, foodValue: fMax, maxFood: fMax, materialValue: 0, maxMaterial: 0, growbackRate: 0.08 };
      count++;
    }
  }
  if (count === 0) return null;
  return `A mushroom patch sprouted near (${centre.x},${centre.y})`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface WorldEventResult {
  fired:   boolean;
  message: string;
}

// ── Tension-aware storyteller ─────────────────────────────────────────────────
// Monitors colony health and biases event selection for dramatic pacing.
// High tension → helpful events (bounty, mushrooms).  Low tension → challenges (blight).
// Medium → unpredictable.  This is the simplest version of RimWorld's AI Storyteller.

type EventType = 'blight' | 'bounty' | 'ore' | 'mushroom';

function colonyTension(dwarves?: Dwarf[], goblins?: Goblin[]): number {
  if (!dwarves || dwarves.length === 0) return 50; // no data → neutral
  const alive   = dwarves.filter(d => d.alive);
  if (alive.length === 0) return 100; // all dead → max tension
  const avgHunger  = alive.reduce((s, d) => s + d.hunger, 0) / alive.length;
  const avgMorale  = alive.reduce((s, d) => s + d.morale, 0) / alive.length;
  const threatMod  = (goblins?.length ?? 0) * 15;
  const recentDead = dwarves.filter(d => !d.alive).length * 20;
  // 0 = peaceful, 100 = desperate
  return Math.min(100, avgHunger + (100 - avgMorale) * 0.5 + threatMod + recentDead);
}

function chooseEvent(tension: number): EventType {
  const roll = Math.random();
  if (tension > 70) {
    // Colony is suffering → mostly helpful events
    return roll < 0.45 ? 'bounty' : roll < 0.85 ? 'mushroom' : 'ore';
  } else if (tension < 30) {
    // Colony is thriving → challenge them
    return roll < 0.50 ? 'blight' : roll < 0.75 ? 'ore' : 'mushroom';
  }
  // Medium tension → keep it unpredictable (original uniform distribution)
  return roll < 0.25 ? 'blight' : roll < 0.50 ? 'bounty' : roll < 0.75 ? 'ore' : 'mushroom';
}

export function tickWorldEvents(
  grid: Tile[][], tick: number,
  dwarves?: Dwarf[], goblins?: Goblin[],
): WorldEventResult {
  if (tick < nextEventTick) return { fired: false, message: '' };

  scheduleNext(); // always advance window first (prevents infinite loop on null returns)

  // Tension-aware event selection (storyteller)
  const tension = colonyTension(dwarves, goblins);
  const event   = chooseEvent(tension);
  let msg: string | null = null;

  switch (event) {
    case 'blight':   msg = applyBlight(grid); break;
    case 'bounty':   msg = applyBounty(grid); break;
    case 'ore':      msg = applyOreDiscovery(grid); break;
    case 'mushroom': msg = applyMushroomSpread(grid); break;
  }

  if (!msg) return { fired: false, message: '' };
  return { fired: true, message: msg };
}
