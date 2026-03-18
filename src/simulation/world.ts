/**
 * World generation — dual Simplex noise (elevation + moisture) → biome lookup → TileType.
 * Resource values come from the noise fields; a sinusoidal river (perturbed by elevation)
 * is the main barrier. Fully seeded: same seed gives identical world for debugging and replay.
 */

import { createNoise2D } from 'simplex-noise';
import { TileType, isWallType, type Tile } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';
import { FORAGEABLE_TILES } from './agents/sites';

// ── World Config (unchanged — same resource min/max/growback as before) ──────

const WORLD_CONFIG = {
  forestFoodMin: 8,
  forestFoodMax: 12,
  forestGrowback: 0.04,

  forestWoodMin: 28,
  forestWoodMax: 32,

  farmFoodMin: 2,
  farmFoodMax: 3,
  farmGrowback: 0.02,

  oreMatMin: 30,
  oreMatMax: 50,
  oreGrowback: 0,

  grassMeadowFoodMin: 2,
  grassMeadowFoodMax: 4,
  grassMeadowGrowback: 0.02,

  mushroomFoodMin: 10,
  mushroomFoodMax: 15,
  mushroomGrowback: 0, // mushrooms deplete to Dirt when empty, no regrow
} as const;

// ── Result type ──────────────────────────────────────────────────────────────

export interface WorldGenResult {
  grid: Tile[][];
  /** Cleared walkable rectangle where goblins spawn. */
  spawnZone: { x: number; y: number; w: number; h: number };
  /** Seed string — display in UI for reproducibility. */
  seed: string;
}

// ── Seeded PRNG ──────────────────────────────────────────────────────────────

/** Hash a string seed into a 32-bit unsigned integer (djb2-xor). */
function hashSeed(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** Mulberry32 — fast 32-bit seeded PRNG. Returns () => number in [0, 1). */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Noise helpers ────────────────────────────────────────────────────────────

type Noise2D = (x: number, y: number) => number;

/** Fractal Brownian motion — layer multiple octaves of simplex noise. */
function fbm(
  noise: Noise2D,
  x: number, y: number,
  octaves: number, frequency: number,
  persistence: number, lacunarity: number,
): number {
  let value = 0;
  let amplitude = 1;
  let maxAmplitude = 0;
  let freq = frequency;
  for (let i = 0; i < octaves; i++) {
    value += noise(x * freq, y * freq) * amplitude;
    maxAmplitude += amplitude;
    amplitude *= persistence;
    freq *= lacunarity;
  }
  return value / maxAmplitude; // approximately [-1, 1]
}

/** Normalize [-1, 1] → [0, 1]. */
function norm01(v: number): number {
  return Math.max(0, Math.min(1, (v + 1) / 2));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── Biome classification ─────────────────────────────────────────────────────

/**
 * Map (elevation, moisture) both in [0, 1] to a TileType.
 *
 * Elevation bands:
 *   < 0.22  Water (natural lakes/ponds)
 *   0.22–0.38  LOW  (valleys, floodplains)
 *   0.38–0.58  MED  (plains, gentle hills)
 *   0.58–0.78  HIGH (ridges, hills)
 *   ≥ 0.78     PEAK (mountains)
 */
function classifyBiome(elevation: number, moisture: number): TileType {
  if (elevation < 0.22) return TileType.Water;

  // LOW
  if (elevation < 0.38) {
    if (moisture > 0.72) return TileType.Mushroom;
    if (moisture > 0.52) return TileType.Farmland;
    if (moisture > 0.32) return TileType.Grass;
    return TileType.Dirt;
  }

  // MEDIUM — forest only in wetter bands (higher threshold = less forest)
  if (elevation < 0.58) {
    if (moisture > 0.58) return TileType.Forest;
    if (moisture > 0.30) return TileType.Grass;
    return TileType.Dirt;
  }

  // HIGH
  if (elevation < 0.78) {
    if (moisture > 0.68) return TileType.Forest;
    if (moisture > 0.35) return TileType.Dirt;
    return TileType.Stone; // Ore -> Stone
  }

  // PEAK
  if (moisture > 0.50) return TileType.Ore; // 0.60 -> 0.50
  if (moisture > 0.35) return TileType.Stone;
  return TileType.Ore;
}

// ── Resource values from noise ───────────────────────────────────────────────

function tileResourceValues(
  type: TileType, elevation: number, moisture: number, rng: () => number,
): Pick<Tile, 'foodValue' | 'materialValue' | 'maxFood' | 'maxMaterial' | 'growbackRate'> {
  switch (type) {
    case TileType.Forest: {
      const foodScale = Math.max(0, (moisture - 0.58) / 0.42); // 0.58 = min moisture for forest
      const fMax = lerp(WORLD_CONFIG.forestFoodMin, WORLD_CONFIG.forestFoodMax, foodScale);
      const wMax = lerp(WORLD_CONFIG.forestWoodMin, WORLD_CONFIG.forestWoodMax, 0.5 + rng() * 0.5);
      return {
        foodValue: fMax * (0.7 + rng() * 0.3),
        materialValue: wMax * (0.7 + rng() * 0.3),
        maxFood: fMax,
        maxMaterial: wMax,
        growbackRate: WORLD_CONFIG.forestGrowback,
      };
    }
    case TileType.Mushroom: {
      const richness = Math.max(0, (moisture - 0.72) / 0.28);
      const fMax = lerp(WORLD_CONFIG.mushroomFoodMin, WORLD_CONFIG.mushroomFoodMax, richness);
      return {
        foodValue: fMax * (0.7 + rng() * 0.3), materialValue: 0,
        maxFood: fMax, maxMaterial: 0, growbackRate: WORLD_CONFIG.mushroomGrowback,
      };
    }
    case TileType.Grass: {
      const fMax = lerp(WORLD_CONFIG.grassMeadowFoodMin, WORLD_CONFIG.grassMeadowFoodMax, moisture);
      return {
        foodValue: fMax * (0.7 + rng() * 0.3), materialValue: 0,
        maxFood: fMax, maxMaterial: 0, growbackRate: WORLD_CONFIG.grassMeadowGrowback,
      };
    }
    case TileType.Farmland: {
      const fMax = lerp(WORLD_CONFIG.farmFoodMin, WORLD_CONFIG.farmFoodMax, moisture);
      return {
        foodValue: fMax * (0.7 + rng() * 0.3), materialValue: 0,
        maxFood: fMax, maxMaterial: 0, growbackRate: WORLD_CONFIG.farmGrowback,
      };
    }
    case TileType.Ore: {
      const richness = elevation > 0.78
        ? Math.max(0, (elevation - 0.78) / 0.22) // PEAK richness
        : Math.max(0, (elevation - 0.58) / 0.20); // HIGH richness
      const matMax = lerp(WORLD_CONFIG.oreMatMin, WORLD_CONFIG.oreMatMax, richness);
      return {
        foodValue: 0, materialValue: matMax * (0.7 + rng() * 0.3),
        maxFood: 0, maxMaterial: matMax, growbackRate: WORLD_CONFIG.oreGrowback,
      };
    }
    default: // Dirt, Stone, Water
      return { foodValue: 0, materialValue: 0, maxFood: 0, maxMaterial: 0, growbackRate: 0 };
  }
}

// ── Spawn validation ─────────────────────────────────────────────────────────

function countNearbyFoodTiles(grid: Tile[][], cx: number, cy: number, radius: number): number {
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const t = grid[y][x];
      if (FORAGEABLE_TILES.has(t.type) && t.maxFood > 0) count++;
    }
  }
  return count;
}

// ── Main generator ───────────────────────────────────────────────────────────

/** Dual-layer Simplex noise parameters for terrain generation.
 *  elevation: low frequency → broad continents; high persistence → rugged hills
 *  moisture:  slightly lower frequency → large climate bands
 *  Increasing octaves adds detail but slows generation.
 */
const NOISE_PARAMS = {
  elevation: { frequency: 0.04, octaves: 3, persistence: 0.5, lacunarity: 2.0 },
  moisture: { frequency: 0.035, octaves: 3, persistence: 0.5, lacunarity: 2.0 },
} as const;

export function generateWorld(seed?: string): WorldGenResult {
  const worldSeed = seed ?? Date.now().toString();
  const rng = mulberry32(hashSeed(worldSeed));

  // Two independent noise fields — different seeds prevent correlation
  const elevNoise = createNoise2D(mulberry32(hashSeed(worldSeed + '_elev')));
  const moistNoise = createNoise2D(mulberry32(hashSeed(worldSeed + '_moist')));
  const spotNoise = createNoise2D(mulberry32(hashSeed(worldSeed + '_spot')));

  // ── Step 1: Generate noise fields + Step 2: Biome assignment ───────────────
  const grid: Tile[][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    grid[y] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      const elev = norm01(fbm(elevNoise, x, y, NOISE_PARAMS.elevation.octaves, NOISE_PARAMS.elevation.frequency, NOISE_PARAMS.elevation.persistence, NOISE_PARAMS.elevation.lacunarity));
      const moist = norm01(fbm(moistNoise, x, y, NOISE_PARAMS.moisture.octaves, NOISE_PARAMS.moisture.frequency, NOISE_PARAMS.moisture.persistence, NOISE_PARAMS.moisture.lacunarity));

      // Spot noise (high frequency) to break up large mushroom patches
      const spot = norm01(fbm(spotNoise, x, y, 2, 0.15, 0.5, 2.0));

      let type = classifyBiome(elev, moist);

      // Break up mushroom patches if spot noise is low
      if (type === TileType.Mushroom && spot < 0.4) {
        type = TileType.Grass;
      }

      const resources = tileResourceValues(type, elev, moist, rng);

      grid[y][x] = { type, ...resources };
    }
  }

  // ── Step 3: Find best spawn zone ────────────────────────────────────────────
  // Scan candidate positions for a rectangle that is mostly walkable
  // and has the most food tiles within a 15-tile radius.  Avoids edges.
  // (width was increased when ore stockpiles were added to the right of the
  // initial depot so the cleared area covers both food and ore storage.)
  const SPAWN_W = 24, SPAWN_H = 10;
  const MARGIN = 4; // keep away from map borders
  let bestSpawnX = Math.floor(GRID_SIZE / 2 - SPAWN_W / 2);
  let bestSpawnY = Math.floor(GRID_SIZE / 2 - SPAWN_H / 2);
  let bestScore = -1;
  const minFoodThreshold = Math.floor(20 * (GRID_SIZE / 64) ** 2);

  // Sample ~40 random candidate positions (seeded) + center fallback
  const candidates: { x: number; y: number }[] = [];
  for (let i = 0; i < 40; i++) {
    candidates.push({
      x: MARGIN + Math.floor(rng() * (GRID_SIZE - SPAWN_W - MARGIN * 2)),
      y: MARGIN + Math.floor(rng() * (GRID_SIZE - SPAWN_H - MARGIN * 2)),
    });
  }
  // Always include center as fallback
  candidates.push({ x: bestSpawnX, y: bestSpawnY });

  for (const c of candidates) {
    // Count walkable tiles in the spawn rectangle
    let walkable = 0;
    for (let dy = 0; dy < SPAWN_H; dy++) {
      for (let dx = 0; dx < SPAWN_W; dx++) {
        const t = grid[c.y + dy]?.[c.x + dx];
        if (t && t.type !== TileType.Water) walkable++;
      }
    }
    // Skip if more than 20% water
    if (walkable < SPAWN_W * SPAWN_H * 0.8) continue;

    // Score by nearby food
    const cx = c.x + Math.floor(SPAWN_W / 2);
    const cy = c.y + Math.floor(SPAWN_H / 2);
    let food = countNearbyFoodTiles(grid, cx, cy, 15);

    // CAP SCORE: preventing the picker from always prioritizing "gigantic clusters".
    // Once a site is "good enough" (2x threshold), we stop caring about MORE food.
    if (food > minFoodThreshold * 2) {
      food = minFoodThreshold * 2;
    }

    if (food > bestScore) {
      bestScore = food;
      bestSpawnX = c.x;
      bestSpawnY = c.y;
    }
  }

  const spawnZone = { x: bestSpawnX, y: bestSpawnY, w: SPAWN_W, h: SPAWN_H };

  return { grid, spawnZone, seed: worldSeed };
}

// ── Growback (unchanged) ─────────────────────────────────────────────────────

/** Wood grows back much more slowly than food — trees take time to regenerate. */
const WOOD_GROWBACK_RATE = 0.02;

/** Stump seedling growth threshold — when materialValue reaches this, seedling becomes a tree. */
const SEEDLING_GROWTH_THRESHOLD = 6;

/**
 * Ticks for one full 4-season year. Seasonal growback peaks in summer and
 * troughs in winter — a slow macro-cycle layered on top of weather variation.
 */
const YEAR_CYCLE_TICKS = 2400; // 600 ticks/season × 4 seasons

// Per-tile Dirt → Mushroom (emergent); pooled tiles dry as Grass/Farmland/Dirt — only Dirt
// gets base sprout, but Grass/Farmland with active poolDriedTick also roll (wet ground).
const MUSHROOM_SPROUT_CHANCE_PER_TICK   = 0.002;
const POOLED_MUSHROOM_BONUS_TICKS       = 300;
const POOLED_MUSHROOM_BONUS_MULTIPLIER  = 15;
const MUSHROOM_ISOLATION_RADIUS         = 2;

function hasMushroomInRadius(grid: Tile[][], x: number, y: number, radius: number): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (grid[ny][nx].type === TileType.Mushroom) return true;
    }
  }
  return false;
}

/**
 * Apply per-tick food and wood regrowth.
 * @param growbackMod — weather multiplier (1.0 = normal, 0.25 = drought, 1.8 = rain)
 * @param tick — current game tick, used for seasonal sine cycle (±30% over a full year)
 */
export function growback(grid: Tile[][], growbackMod: number = 1, tick: number = 0): void {
  // Seasonal cycle: sin peaks at summer (tick≈600), troughs at winter (tick≈1800)
  const seasonalMod = 1 + 0.3 * Math.sin((tick / YEAR_CYCLE_TICKS) * 2 * Math.PI);
  const effectiveMod = growbackMod * seasonalMod;
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];
      if (t.growbackRate > 0 && t.maxFood > 0 && t.foodValue < t.maxFood) {
        t.foodValue = Math.min(t.maxFood, t.foodValue + t.growbackRate * effectiveMod);
      }
      if (t.type === TileType.Forest && t.maxMaterial > 0 && t.materialValue < t.maxMaterial) {
        t.materialValue = Math.min(t.maxMaterial, t.materialValue + WOOD_GROWBACK_RATE * effectiveMod);
      }
      // Stump seedlings regrow into Forest when mature
      if (t.type === TileType.TreeStump && t.growbackRate > 0 && t.materialValue < t.maxMaterial) {
        t.materialValue = Math.min(t.maxMaterial, t.materialValue + t.growbackRate * effectiveMod);
        // Once seedling reaches threshold, it becomes a young Forest
        if (t.materialValue >= SEEDLING_GROWTH_THRESHOLD) {
          t.type = TileType.Forest;
          t.maxMaterial = 10;  // Young tree max
          t.materialValue = Math.min(t.materialValue, t.maxMaterial);
          t.growbackRate = WORLD_CONFIG.forestGrowback;  // Normal forest growback
        }
      }
    }
  }

  // Per-tile → Mushroom: Dirt (any); Grass/Farmland only while poolDriedTick bonus active
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];
      const pooledActive = t.poolDriedTick !== undefined &&
        tick - t.poolDriedTick <= POOLED_MUSHROOM_BONUS_TICKS;
      if (t.poolDriedTick !== undefined && !pooledActive) {
        delete t.poolDriedTick;
      }
      const isDirt = t.type === TileType.Dirt;
      const isPooledGround = (t.type === TileType.Grass || t.type === TileType.Farmland) && pooledActive;
      if (!isDirt && !isPooledGround) continue;
      if (hasMushroomInRadius(grid, x, y, MUSHROOM_ISOLATION_RADIUS)) continue;
      let chance = MUSHROOM_SPROUT_CHANCE_PER_TICK * effectiveMod;
      if (pooledActive) chance *= POOLED_MUSHROOM_BONUS_MULTIPLIER;
      if (Math.random() >= chance) continue;
      const fMax = WORLD_CONFIG.mushroomFoodMin + Math.random() * (WORLD_CONFIG.mushroomFoodMax - WORLD_CONFIG.mushroomFoodMin);
      const foodVal = fMax * (0.7 + Math.random() * 0.3);
      grid[y][x] = {
        type:          TileType.Mushroom,
        foodValue:     foodVal,
        maxFood:       fMax,
        materialValue: 0,
        maxMaterial:   0,
        growbackRate:  0,
      };
    }
  }
}

export function isWalkable(grid: Tile[][], x: number, y: number): boolean {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
  const t = grid[y][x].type;
  return t !== TileType.Water && !isWallType(t);
}
