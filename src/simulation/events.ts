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

import { TileType, type Tile, type Goblin, type Adventurer } from '../shared/types';

// ── Config ────────────────────────────────────────────────────────────────────

// Event scheduling
const EVENT_MIN_INTERVAL  = 300;  // ticks between world events (min)
const EVENT_MAX_INTERVAL  = 600;  // ticks between world events (max)

// Blight event
const BLIGHT_RADIUS       = 6;
const BLIGHT_SEVERITY     = 0.5;  // multiplier on tile maxFood

// Bounty event
const BOUNTY_RADIUS       = 5;
const BOUNTY_MULTIPLIER   = 1.5;
const BOUNTY_MAX_VALUE    = 20;

// Mushroom discovery event
const MUSHROOM_ISOLATION_RADIUS  = 4;
const MUSHROOM_SPREAD_RADIUS_MIN = 3;
const MUSHROOM_SPREAD_RADIUS_MAX = 5; // exclusive upper bound (rand(3) → 0,1,2)
const MUSHROOM_FILL_CHANCE       = 0.6;
const MUSHROOM_MAX_COUNT         = 14;
const MUSHROOM_FOOD_MIN          = 3;
const MUSHROOM_FOOD_MAX          = 5; // exclusive (rand(3) → 0,1,2 added to min)

// Ore discovery event
const ORE_DISCOVERY_RADIUS    = 3;
const ORE_DISCOVERY_MAX_TILES = 5;
const ORE_DISCOVERY_VALUE     = 15;

// Mushroom sprout (periodic)
const MUSHROOM_SPROUT_INTERVAL    = 60;
const MUSHROOM_SPROUT_RADIUS      = 2;
const MUSHROOM_SPROUT_FILL        = 0.7;
const MUSHROOM_SPROUT_MAX         = 8;

// Tension calculation weights
const TENSION_PER_THREAT   = 15;
const TENSION_PER_DEAD     = 20;

// Event distribution by tension bracket
const TENSION_EVENT_DISTRIBUTION = {
  high:   { blight: 0,    bounty: 0.45, mushroom: 0.40, ore: 0.15 },  // tension > 70: relief
  low:    { blight: 0.50, bounty: 0,    mushroom: 0.25, ore: 0.25 },  // tension < 30: challenge
  normal: { blight: 0.25, bounty: 0.25, mushroom: 0.25, ore: 0.25 },  // otherwise: uniform
} as const;

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

  const affected = coordsInRadius(grid, centre.x, centre.y, BLIGHT_RADIUS);
  for (const { x, y } of affected) {
    const t = grid[y][x];
    if (t.maxFood > 0) {
      t.maxFood   = Math.max(1, Math.floor(t.maxFood   * BLIGHT_SEVERITY));
      t.foodValue = Math.min(t.foodValue, t.maxFood);
    }
  }
  return `Blight struck at (${centre.x},${centre.y}) — food yields halved in a ${BLIGHT_RADIUS}-tile radius`;
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

  const affected = coordsInRadius(grid, centre.x, centre.y, BOUNTY_RADIUS);
  for (const { x, y } of affected) {
    const t = grid[y][x];
    if (t.maxFood > 0) {
      t.maxFood   = Math.min(BOUNTY_MAX_VALUE, Math.ceil(t.maxFood   * BOUNTY_MULTIPLIER));
      t.foodValue = Math.min(BOUNTY_MAX_VALUE, Math.ceil(t.foodValue * BOUNTY_MULTIPLIER));
    }
  }
  return `Bountiful harvest at (${centre.x},${centre.y}) — food yields boosted in a ${BOUNTY_RADIUS}-tile radius`;
}

function applyMushroomSpread(grid: Tile[][]): string | null {
  // Candidate tiles: Dirt or Grass with no mushroom already within isolation radius
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const candidates: GridCoord[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = grid[y][x];
      if (t.type !== TileType.Dirt && t.type !== TileType.Grass) continue;
      const nearMushroom = coordsInRadius(grid, x, y, MUSHROOM_ISOLATION_RADIUS)
        .some(({ x: nx, y: ny }) => grid[ny][nx].type === TileType.Mushroom);
      if (!nearMushroom) candidates.push({ x, y });
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;

  // World-event spread is deliberately large (spread radius, up to max tiles)
  // so it feels distinct from the steady per-tick growback on existing tiles.
  const radius  = MUSHROOM_SPREAD_RADIUS_MIN + Math.floor(Math.random() * (MUSHROOM_SPREAD_RADIUS_MAX - MUSHROOM_SPREAD_RADIUS_MIN));
  const affected = coordsInRadius(grid, centre.x, centre.y, radius);
  let count = 0;
  for (const { x, y } of affected) {
    const t = grid[y][x];
    if ((t.type === TileType.Dirt || t.type === TileType.Grass) && Math.random() < MUSHROOM_FILL_CHANCE && count < MUSHROOM_MAX_COUNT) {
      const fMax = MUSHROOM_FOOD_MIN + Math.floor(Math.random() * (MUSHROOM_FOOD_MAX - MUSHROOM_FOOD_MIN));
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

  const affected = coordsInRadius(grid, centre.x, centre.y, ORE_DISCOVERY_RADIUS);
  let count = 0;
  for (const { x, y } of affected) {
    const t = grid[y][x];
    if (t.type !== TileType.Water && t.type !== TileType.Ore && count < ORE_DISCOVERY_MAX_TILES) {
      t.type          = TileType.Ore;
      t.maxMaterial   = ORE_DISCOVERY_VALUE;
      t.materialValue = ORE_DISCOVERY_VALUE;
      count++;
    }
  }
  return `Ore vein discovered near (${centre.x},${centre.y}) — ${count} new ore tiles`;
}

// ── Steady mushroom sprouting ─────────────────────────────────────────────────

/**
 * Steady mushroom sprouting — fires at regular intervals.
 * Creates a moderate patch in a depleted or open area,
 * keeping the map viable after goblins strip early patches.
 *
 * Deliberately smaller than the world-event spread
 * so the world event still feels like a meaningful bonus.
 */

export function tickMushroomSprout(grid: Tile[][], tick: number): string | null {
  if (tick === 0 || tick % MUSHROOM_SPROUT_INTERVAL !== 0) return null;

  // Candidates: Dirt/Grass with no living mushroom patch within sprout radius
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const candidates: GridCoord[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = grid[y][x];
      if (t.type !== TileType.Dirt && t.type !== TileType.Grass) continue;
      const nearMushroom = coordsInRadius(grid, x, y, MUSHROOM_SPROUT_RADIUS)
        .some(({ x: nx, y: ny }) => grid[ny][nx].type === TileType.Mushroom);
      if (!nearMushroom) candidates.push({ x, y });
    }
  }
  const centre = randomItem(candidates);
  if (!centre) return null;

  const affected = coordsInRadius(grid, centre.x, centre.y, MUSHROOM_SPROUT_RADIUS);
  let count = 0;
  for (const { x, y } of affected) {
    const t = grid[y][x];
    if ((t.type === TileType.Dirt || t.type === TileType.Grass) && Math.random() < MUSHROOM_SPROUT_FILL && count < MUSHROOM_SPROUT_MAX) {
      const fMax = MUSHROOM_FOOD_MIN + Math.floor(Math.random() * (MUSHROOM_FOOD_MAX - MUSHROOM_FOOD_MIN));
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

function colonyTension(goblins?: Goblin[], adventurers?: Adventurer[]): number {
  if (!goblins || goblins.length === 0) return 50; // no data → neutral
  const alive   = goblins.filter(d => d.alive);
  if (alive.length === 0) return 100; // all dead → max tension
  const avgHunger  = alive.reduce((s, d) => s + d.hunger, 0) / alive.length;
  const avgMorale  = alive.reduce((s, d) => s + d.morale, 0) / alive.length;
  const threatMod  = (adventurers?.length ?? 0) * TENSION_PER_THREAT;
  const recentDead = goblins.filter(d => !d.alive).length * TENSION_PER_DEAD;
  // 0 = peaceful, 100 = desperate
  return Math.min(100, avgHunger + (100 - avgMorale) * 0.5 + threatMod + recentDead);
}

function chooseEvent(tension: number): EventType {
  const roll = Math.random();
  let distribution;
  if (tension > 70) {
    distribution = TENSION_EVENT_DISTRIBUTION.high;
  } else if (tension < 30) {
    distribution = TENSION_EVENT_DISTRIBUTION.low;
  } else {
    distribution = TENSION_EVENT_DISTRIBUTION.normal;
  }

  // Normalize weights and pick by cumulative probability
  const types: EventType[] = ['blight', 'bounty', 'mushroom', 'ore'];
  const weights = types.map(t => distribution[t]);
  const total = weights.reduce((s, w) => s + w, 0 as number);
  let cumulative = 0;
  for (let i = 0; i < types.length; i++) {
    cumulative += weights[i] / total;
    if (roll < cumulative) return types[i];
  }
  return types[types.length - 1];
}

export function tickWorldEvents(
  grid: Tile[][], tick: number,
  goblins?: Goblin[], adventurers?: Adventurer[],
): WorldEventResult {
  if (tick < nextEventTick) return { fired: false, message: '' };

  scheduleNext(); // always advance window first (prevents infinite loop on null returns)

  // Tension-aware event selection (storyteller)
  const tension = colonyTension(goblins, adventurers);
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
