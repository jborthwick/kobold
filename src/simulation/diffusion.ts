/**
 * Spatial awareness layers recomputed every tick (index: y * GRID_SIZE + x). Warmth from
 * hearths and stockpiles (walls add shelter); danger from adventurers and map edges (walls
 * block). Goblins seek warmth and flee danger — these fields drive seekWarmth, seekSafety,
 * and rest scoring. Transient (not saved).
 */

import { GRID_SIZE } from '../shared/constants';
import { TileType, isWallType, type Tile, type Goblin, type Adventurer, type FoodStockpile, type WeatherType } from '../shared/types';

const N = GRID_SIZE * GRID_SIZE;

const WARMTH_RADIUS    = 8;
const SHELTER_PER_WALL = 0.15;   // 15% warmth bonus per adjacent wall
const SHELTER_MAX_MULT = 1.5;    // cap at +50%

const DANGER_RADIUS_ADV  = 12;
const DANGER_RADIUS_EDGE = 4;
const DANGER_DECAY       = 0.97; // raid corridors linger ~100 ticks

const TRAFFIC_DECAY      = 0.998; // half-life ~350 ticks
const TRAFFIC_INCREMENT  = 0.5;
const TRAFFIC_CAP        = 100;

function idx(x: number, y: number): number {
  return y * GRID_SIZE + x;
}

export function createWarmthField(): Float32Array { return new Float32Array(N); }
export function createDangerField(): Float32Array { return new Float32Array(N); }

/** Scan the grid and return positions of all Hearth tiles. */
export function findHearths(grid: Tile[][]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (grid[y][x].type === TileType.Hearth) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Multi-source BFS warmth field.
 * Sources: Hearth tiles (strength 100), food stockpiles (strength 60).
 * Walls block propagation; adjacent walls add shelter bonus.
 * Cold weather multiplies all values by 0.7.
 */
export function computeWarmth(
  grid: Tile[][],
  hearths: { x: number; y: number }[],
  foodStockpiles: FoodStockpile[],
  weatherType: WeatherType,
  out: Float32Array,
): void {
  out.fill(0);

  // Queue: [x, y, strength]
  const queue: [number, number, number][] = [];
  for (const h of hearths)       queue.push([h.x, h.y, 100]);
  for (const s of foodStockpiles) queue.push([s.x, s.y, 60]);
  // Fire tiles radiate heat — visible in warmth overlay, shorter range than hearths
  for (let fy = 0; fy < GRID_SIZE; fy++) {
    for (let fx = 0; fx < GRID_SIZE; fx++) {
      if (grid[fy][fx].type === TileType.Fire) queue.push([fx, fy, 70]);
    }
  }

  const STEP = 100 / WARMTH_RADIUS;
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

  let head = 0;
  while (head < queue.length) {
    const [x, y, strength] = queue[head++];
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
    const i = idx(x, y);
    if (out[i] >= strength) continue;   // already have a stronger value here
    out[i] = strength;

    const t = grid[y][x];
    // Walls block propagation for non-source waves
    if (isWallType(t.type) && strength < 99) continue;

    const next = strength - STEP;
    if (next <= 0) continue;

    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (out[idx(nx, ny)] < next) queue.push([nx, ny, next]);
    }
  }

  // Shelter bonus — tiles adjacent to walls get warmth amplified
  const DIRS8 = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]] as const;
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const i = idx(x, y);
      if (out[i] <= 0) continue;
      let walls = 0;
      for (const [dx, dy] of DIRS8) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE && isWallType(grid[ny][nx].type)) walls++;
      }
      if (walls > 0) {
        const mult = Math.min(SHELTER_MAX_MULT, 1 + walls * SHELTER_PER_WALL);
        out[i] = Math.min(100, out[i] * mult);
      }
    }
  }

  // Cold weather dampens all warmth
  if (weatherType === 'cold') {
    for (let i = 0; i < N; i++) out[i] *= 0.7;
  }
}

/**
 * Multi-source BFS danger field.
 * Sources: adventurers (100), map edges (40).
 * Walls halve danger spread. Previous field decays at 0.97× (raid corridors linger).
 */
export function computeDanger(
  grid: Tile[][],
  adventurers: Adventurer[],
  prev: Float32Array,
  out: Float32Array,
): void {
  // Decay previous field into out
  for (let i = 0; i < N; i++) out[i] = prev[i] * DANGER_DECAY;

  // Fresh BFS for this tick
  const fresh = new Float32Array(N);
  const STEP_ADV  = 100 / DANGER_RADIUS_ADV;
  const STEP_EDGE = 40  / DANGER_RADIUS_EDGE;
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

  const queue: [number, number, number][] = [];

  for (const a of adventurers) queue.push([a.x, a.y, 100]);

  // Fire tiles as danger sources — goblins flee when fire is ~3 tiles away
  for (let fy = 0; fy < GRID_SIZE; fy++) {
    for (let fx = 0; fx < GRID_SIZE; fx++) {
      if (grid[fy][fx].type === TileType.Fire) queue.push([fx, fy, 80]);
    }
  }

  for (let x = 0; x < GRID_SIZE; x++) {
    queue.push([x, 0,             40]);
    queue.push([x, GRID_SIZE - 1, 40]);
  }
  for (let y = 0; y < GRID_SIZE; y++) {
    queue.push([0,             y, 40]);
    queue.push([GRID_SIZE - 1, y, 40]);
  }

  let head = 0;
  while (head < queue.length) {
    const [x, y, strength] = queue[head++];
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
    const i = idx(x, y);
    if (fresh[i] >= strength) continue;
    fresh[i] = strength;

    const t = grid[y][x];
    // Determine step size (adventurer vs edge source)
    const step = strength > 40 ? STEP_ADV : STEP_EDGE;
    let next = strength - step;
    // Walls halve propagated danger
    if (isWallType(t.type)) next *= 0.5;
    if (next <= 0) continue;

    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (fresh[idx(nx, ny)] < next) queue.push([nx, ny, next]);
    }
  }

  // Merge: take max of decayed old + fresh
  for (let i = 0; i < N; i++) {
    out[i] = Math.min(100, Math.max(out[i], fresh[i]));
  }
}

/**
 * Accumulate goblin foot-traffic on tile.trafficScore.
 * Decays ×0.998/tick (~350-tick half-life); +0.5 per goblin per tick.
 */
export function updateTraffic(grid: Tile[][], goblins: Goblin[]): void {
  // Decay all tiles with traffic
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];
      if ((t.trafficScore ?? 0) > 0) {
        t.trafficScore = (t.trafficScore!) * TRAFFIC_DECAY;
      }
    }
  }
  // Accumulate from living goblins
  for (const g of goblins) {
    if (!g.alive) continue;
    const t = grid[g.y]?.[g.x];
    if (t) t.trafficScore = Math.min(TRAFFIC_CAP, (t.trafficScore ?? 0) + TRAFFIC_INCREMENT);
  }
}

/** Warmth at a tile coordinate, 0–100. */
export function getWarmth(field: Float32Array, x: number, y: number): number {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return 0;
  return field[y * GRID_SIZE + x];
}

/** Danger at a tile coordinate, 0–100. */
export function getDanger(field: Float32Array, x: number, y: number): number {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return 0;
  return field[y * GRID_SIZE + x];
}
