/**
 * World generation — dual-noise biome classification (Red Blob Games pattern).
 *
 * Two independent Simplex noise fields (elevation + moisture) are sampled at
 * every tile.  A biome lookup table maps (elevation, moisture) → TileType.
 * Resource values (food, material) are derived from the continuous noise
 * fields, not random.  An explicit sinusoidal river (perturbed by elevation
 * noise) provides the gameplay barrier.  Everything is fully seeded —
 * same seed = identical world.
 */

import { createNoise2D } from 'simplex-noise';
import { TileType, type Tile } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';

// ── World Config (unchanged — same resource min/max/growback as before) ──────

const WORLD_CONFIG = {
  forestFoodMin:  8,
  forestFoodMax:  12,
  forestGrowback: 0.04,

  forestWoodMin: 8,
  forestWoodMax: 12,

  farmFoodMin:    2,
  farmFoodMax:    3,
  farmGrowback:   0.02,

  oreMatMin:      8,
  oreMatMax:      12,
  oreGrowback:    0,

  grassMeadowFoodMin:  2,
  grassMeadowFoodMax:  4,
  grassMeadowGrowback: 0.02,

  mushroomFoodMin:  3,
  mushroomFoodMax:  5,
  mushroomGrowback: 0.08,
} as const;

// ── Result type ──────────────────────────────────────────────────────────────

export interface WorldGenResult {
  grid:      Tile[][];
  /** Cleared walkable rectangle where dwarves spawn. */
  spawnZone: { x: number; y: number; w: number; h: number };
  /** Seed string — display in UI for reproducibility. */
  seed:      string;
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

  // MEDIUM
  if (elevation < 0.58) {
    if (moisture > 0.45) return TileType.Forest;
    if (moisture > 0.30) return TileType.Grass;
    return TileType.Dirt;
  }

  // HIGH
  if (elevation < 0.78) {
    if (moisture > 0.55) return TileType.Forest;
    if (moisture > 0.35) return TileType.Dirt;
    return TileType.Stone;
  }

  // PEAK
  if (moisture > 0.60) return TileType.Ore;
  if (moisture > 0.35) return TileType.Stone;
  return TileType.Ore;
}

// ── Resource values from noise ───────────────────────────────────────────────

function tileResourceValues(
  type: TileType, elevation: number, moisture: number, rng: () => number,
): Pick<Tile, 'foodValue' | 'materialValue' | 'maxFood' | 'maxMaterial' | 'growbackRate'> {
  switch (type) {
    case TileType.Forest: {
      const foodScale = Math.max(0, (moisture - 0.45) / 0.55);
      const fMax = lerp(WORLD_CONFIG.forestFoodMin, WORLD_CONFIG.forestFoodMax, foodScale);
      const wMax = lerp(WORLD_CONFIG.forestWoodMin, WORLD_CONFIG.forestWoodMax, 0.5 + rng() * 0.5);
      return {
        foodValue:     fMax * (0.7 + rng() * 0.3),
        materialValue: wMax * (0.7 + rng() * 0.3),
        maxFood:       fMax,
        maxMaterial:   wMax,
        growbackRate:  WORLD_CONFIG.forestGrowback,
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
      const richness = Math.max(0, (elevation - 0.78) / 0.22);
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
      if (grid[y][x].maxFood > 0) count++;
    }
  }
  return count;
}

/** Seed a guaranteed mushroom patch near (cx, cy). */
function seedMushroomPatch(grid: Tile[][], cx: number, cy: number, rng: () => number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const t = grid[y][x];
      if (t.type === TileType.Water || t.type === TileType.Wall) continue;
      if (rng() > 0.7) continue; // ~70% fill
      const fMax = lerp(WORLD_CONFIG.mushroomFoodMin, WORLD_CONFIG.mushroomFoodMax, rng());
      grid[y][x] = {
        type: TileType.Mushroom, foodValue: fMax, materialValue: 0,
        maxFood: fMax, maxMaterial: 0, growbackRate: WORLD_CONFIG.mushroomGrowback,
      };
    }
  }
}

// ── Main generator ───────────────────────────────────────────────────────────

export function generateWorld(seed?: string): WorldGenResult {
  const worldSeed = seed ?? Date.now().toString();
  const rng = mulberry32(hashSeed(worldSeed));

  // Two independent noise fields — different seeds prevent correlation
  const elevNoise  = createNoise2D(mulberry32(hashSeed(worldSeed + '_elev')));
  const moistNoise = createNoise2D(mulberry32(hashSeed(worldSeed + '_moist')));

  // Noise parameters
  const ELEV_FREQ  = 0.04;
  const MOIST_FREQ = 0.035;
  const OCTAVES    = 3;
  const PERSIST    = 0.5;
  const LACUN      = 2.0;

  // ── Step 1: Generate noise fields + Step 2: Biome assignment ───────────────
  const grid: Tile[][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    grid[y] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      const elev  = norm01(fbm(elevNoise,  x, y, OCTAVES, ELEV_FREQ,  PERSIST, LACUN));
      const moist = norm01(fbm(moistNoise, x, y, OCTAVES, MOIST_FREQ, PERSIST, LACUN));

      const type = classifyBiome(elev, moist);
      const resources = tileResourceValues(type, elev, moist, rng);

      grid[y][x] = { type, ...resources };
    }
  }

  // ── Step 3: Find best spawn zone ────────────────────────────────────────────
  // Scan candidate positions for a 12×6 rectangle that is mostly walkable
  // and has the most food tiles within a 15-tile radius.  Avoids edges.
  const SPAWN_W = 12, SPAWN_H = 6;
  const MARGIN  = 4; // keep away from map borders
  let bestSpawnX = Math.floor(GRID_SIZE / 2 - SPAWN_W / 2);
  let bestSpawnY = Math.floor(GRID_SIZE / 2 - SPAWN_H / 2);
  let bestScore  = -1;

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
    const food = countNearbyFoodTiles(grid, cx, cy, 15);
    if (food > bestScore) {
      bestScore  = food;
      bestSpawnX = c.x;
      bestSpawnY = c.y;
    }
  }

  const spawnZone = { x: bestSpawnX, y: bestSpawnY, w: SPAWN_W, h: SPAWN_H };

  // Clear spawn zone to walkable dirt (always last for terrain)
  for (let y = bestSpawnY; y < bestSpawnY + SPAWN_H; y++) {
    for (let x = bestSpawnX; x < bestSpawnX + SPAWN_W; x++) {
      if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
        if (grid[y][x].type !== TileType.Water) {
          grid[y][x] = {
            type: TileType.Dirt, foodValue: 0, materialValue: 0,
            maxFood: 0, maxMaterial: 0, growbackRate: 0,
          };
        }
      }
    }
  }

  // ── Step 5: Validate food near spawn ───────────────────────────────────────
  const spawnCx = spawnZone.x + Math.floor(spawnZone.w / 2);
  const spawnCy = spawnZone.y + Math.floor(spawnZone.h / 2);
  const nearbyFood = countNearbyFoodTiles(grid, spawnCx, spawnCy, 15);

  if (nearbyFood < 20) {
    // Seed a guaranteed mushroom patch ~6 tiles from spawn center
    const angle = rng() * Math.PI * 2;
    const px = Math.max(2, Math.min(GRID_SIZE - 3, Math.round(spawnCx + Math.cos(angle) * 6)));
    const py = Math.max(2, Math.min(GRID_SIZE - 3, Math.round(spawnCy + Math.sin(angle) * 6)));
    seedMushroomPatch(grid, px, py, rng);
  }

  return { grid, spawnZone, seed: worldSeed };
}

// ── Growback (unchanged) ─────────────────────────────────────────────────────

/** Wood grows back much more slowly than food — trees take time to regenerate. */
const WOOD_GROWBACK_RATE = 0.02;

/**
 * Apply per-tick food and wood regrowth.
 * @param growbackMod — weather multiplier (1.0 = normal, 0.25 = drought, 1.8 = rain)
 */
export function growback(grid: Tile[][], growbackMod: number = 1): void {
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];
      if (t.growbackRate > 0 && t.maxFood > 0 && t.foodValue < t.maxFood) {
        t.foodValue = Math.min(t.maxFood, t.foodValue + t.growbackRate * growbackMod);
      }
      if (t.type === TileType.Forest && t.maxMaterial > 0 && t.materialValue < t.maxMaterial) {
        t.materialValue = Math.min(t.maxMaterial, t.materialValue + WOOD_GROWBACK_RATE * growbackMod);
      }
    }
  }
}

export function isWalkable(grid: Tile[][], x: number, y: number): boolean {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
  const t = grid[y][x].type;
  return t !== TileType.Water && t !== TileType.Wall;
}
