/**
 * Spatial awareness layers recomputed every tick (index: y * GRID_SIZE + x). Warmth is
 * derived per-goblin from room membership + proximity to heat (shelter-style); danger from
 * adventurers and map edges (walls block). A display-only warmth overlay shows warm zones.
 * Transient (not saved).
 */

import { GRID_SIZE } from '../shared/constants';
import { TileType, isWallType, type Tile, type Goblin, type Adventurer, type FoodStockpile, type WeatherType, type Room } from '../shared/types';

const N = GRID_SIZE * GRID_SIZE;

const WARMTH_RADIUS    = 8;
const SHELTER_PER_WALL = 0.15;   // 15% warmth bonus per adjacent wall
const SHELTER_MAX_MULT = 1.5;    // cap at +50%

/** Distance (manhattan) beyond which a heat source no longer warms a goblin. */
const WARMTH_PROXIMITY_RADIUS = 5;
/** Display-only overlay: tiles within this distance of heat get orange tint. */
const WARMTH_OVERLAY_RADIUS = 6;
/** In cold weather, being in any room adds this much warmth (out of the elements). */
const ROOM_SHELTER_WARMTH = 12;

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

/** All heat source positions (hearths + fire tiles). */
function getHeatSources(grid: Tile[][]): { x: number; y: number }[] {
  const out = findHearths(grid);
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (grid[y][x].type === TileType.Fire) out.push({ x, y });
    }
  }
  return out;
}

/** True if the room contains at least one Hearth or Fire tile. */
function roomHasHeatSource(room: Room, grid: Tile[][]): boolean {
  for (let dy = 0; dy < room.h; dy++) {
    for (let dx = 0; dx < room.w; dx++) {
      const tx = room.x + dx;
      const ty = room.y + dy;
      if (tx >= 0 && tx < GRID_SIZE && ty >= 0 && ty < GRID_SIZE) {
        const t = grid[ty][tx].type;
        if (t === TileType.Hearth || t === TileType.Fire) return true;
      }
    }
  }
  return false;
}

/** Manhattan distance from (x,y) to nearest heat source, or Infinity if none. */
function minDistanceToHeat(x: number, y: number, grid: Tile[][]): number {
  const sources = getHeatSources(grid);
  if (sources.length === 0) return Infinity;
  let min = Infinity;
  for (const s of sources) {
    const d = Math.abs(s.x - x) + Math.abs(s.y - y);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Per-goblin warmth 0–100 from context (shelter-style): in a room with a hearth/fire,
 * or within WARMTH_PROXIMITY_RADIUS of any heat source. Cold weather multiplies by 0.7.
 */
export function computeGoblinWarmth(
  goblin: Goblin,
  grid: Tile[][],
  rooms: Room[] | undefined,
  weatherType?: WeatherType,
): number {
  const sources = getHeatSources(grid);
  const currentRoom = rooms?.find(
    r => goblin.x >= r.x && goblin.x < r.x + r.w && goblin.y >= r.y && goblin.y < r.y + r.h,
  );
  const inWarmRoom = currentRoom && roomHasHeatSource(currentRoom, grid);
  const dist = minDistanceToHeat(goblin.x, goblin.y, grid);

  let raw: number;
  if (sources.length === 0) {
    raw = 0;
  } else if (inWarmRoom) {
    raw = dist <= 2 ? 70 + (2 - dist) * 15 : 70;
    raw = Math.min(100, raw);
  } else {
    raw = dist <= WARMTH_PROXIMITY_RADIUS ? Math.max(0, 100 - 20 * dist) : 0;
  }

  // In cold, being in any room adds a small warmth (out of the elements).
  if (weatherType === 'cold' && currentRoom) raw = Math.min(100, raw + ROOM_SHELTER_WARMTH);
  if (weatherType === 'cold') raw *= 0.7;
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

/**
 * Warmth 0–100 at a given position (same logic as computeGoblinWarmth).
 * Used by wander to bias toward warmer tiles when cold.
 */
export function warmthAtPosition(
  x: number,
  y: number,
  grid: Tile[][],
  rooms: Room[] | undefined,
  weatherType?: WeatherType,
): number {
  const sources = getHeatSources(grid);
  const currentRoom = rooms?.find(
    r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h,
  );
  const inWarmRoom = currentRoom && roomHasHeatSource(currentRoom, grid);
  const dist = minDistanceToHeat(x, y, grid);

  let raw: number;
  if (sources.length === 0) {
    raw = 0;
  } else if (inWarmRoom) {
    raw = dist <= 2 ? 70 + (2 - dist) * 15 : 70;
    raw = Math.min(100, raw);
  } else {
    raw = dist <= WARMTH_PROXIMITY_RADIUS ? Math.max(0, 100 - 20 * dist) : 0;
  }

  if (weatherType === 'cold' && currentRoom) raw = Math.min(100, raw + ROOM_SHELTER_WARMTH);
  if (weatherType === 'cold') raw *= 0.7;
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10));
}

/**
 * Display-only warmth field: tiles within WARMTH_OVERLAY_RADIUS of a hearth/fire get warmth.
 * Used for the orange ambient overlay; game logic uses computeGoblinWarmth instead.
 */
export function computeWarmthOverlay(grid: Tile[][], out: Float32Array): void {
  out.fill(0);
  const sources = getHeatSources(grid);
  for (const s of sources) {
    for (let dy = -WARMTH_OVERLAY_RADIUS; dy <= WARMTH_OVERLAY_RADIUS; dy++) {
      for (let dx = -WARMTH_OVERLAY_RADIUS; dx <= WARMTH_OVERLAY_RADIUS; dx++) {
        const nx = s.x + dx;
        const ny = s.y + dy;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
          const d = Math.abs(dx) + Math.abs(dy);
          if (d <= WARMTH_OVERLAY_RADIUS) {
            const i = ny * GRID_SIZE + nx;
            out[i] = Math.max(out[i], 100 - 15 * d);
          }
        }
      }
    }
  }
}

/**
 * Multi-source BFS warmth field (legacy). Kept only for optional overlay; game logic
 * uses computeGoblinWarmth. Sources: Hearth (100), food stockpiles (60), room centers (40), Fire (70).
 */
export function computeWarmth(
  grid: Tile[][],
  hearths: { x: number; y: number }[],
  foodStockpiles: FoodStockpile[],
  weatherType: WeatherType,
  out: Float32Array,
  rooms?: Room[],
): void {
  out.fill(0);

  const queue: [number, number, number][] = [];
  for (const h of hearths)       queue.push([h.x, h.y, 100]);
  for (const s of foodStockpiles) queue.push([s.x, s.y, 60]);
  for (const r of rooms ?? []) {
    const cx = r.x + Math.floor(r.w / 2);
    const cy = r.y + Math.floor(r.h / 2);
    queue.push([cx, cy, 40]);
  }
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
    if (out[i] >= strength) continue;
    out[i] = strength;

    const t = grid[y][x];
    if (isWallType(t.type) && strength < 99) continue;

    const next = strength - STEP;
    if (next <= 0) continue;

    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (out[idx(nx, ny)] < next) queue.push([nx, ny, next]);
    }
  }

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
    const step = strength > 40 ? STEP_ADV : STEP_EDGE;
    let next = strength - step;
    if (isWallType(t.type)) next *= 0.5;
    if (next <= 0) continue;

    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (fresh[idx(nx, ny)] < next) queue.push([nx, ny, next]);
    }
  }

  for (let i = 0; i < N; i++) {
    out[i] = Math.min(100, Math.max(out[i], fresh[i]));
  }
}

/**
 * Accumulate goblin foot-traffic on tile.trafficScore.
 * Decays ×0.998/tick (~350-tick half-life); +0.5 per goblin per tick.
 */
export function updateTraffic(grid: Tile[][], goblins: Goblin[]): void {
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];
      if ((t.trafficScore ?? 0) > 0) {
        t.trafficScore = (t.trafficScore!) * TRAFFIC_DECAY;
      }
    }
  }
  for (const g of goblins) {
    if (!g.alive) continue;
    const t = grid[g.y]?.[g.x];
    if (t) t.trafficScore = Math.min(TRAFFIC_CAP, (t.trafficScore ?? 0) + TRAFFIC_INCREMENT);
  }
}

/** Warmth at a tile coordinate, 0–100 (for overlay field). */
export function getWarmth(field: Float32Array, x: number, y: number): number {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return 0;
  return field[y * GRID_SIZE + x];
}

/** Danger at a tile coordinate, 0–100. */
export function getDanger(field: Float32Array, x: number, y: number): number {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return 0;
  return field[y * GRID_SIZE + x];
}
