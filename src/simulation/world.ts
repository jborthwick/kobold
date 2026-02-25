import { TileType, type Tile } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';

// ── World Config ───────────────────────────────────────────────────────────────
const WORLD_CONFIG = {
  // Forest (primary food — rich tiles, very slow regrowth)
  forestFoodMin:  8,
  forestFoodMax:  12,
  forestGrowback: 0.04,

  // Farmland (fallback food — small patches, very slow regrowth)
  farmFoodMin:    2,
  farmFoodMax:    3,
  farmGrowback:   0.02,

  // Bare dirt (no food)
  grassFood:      0,
  grassGrowback:  0,

  // Ore deposits (material — no regrowth)
  oreMatMin:      8,
  oreMatMax:      12,
  oreGrowback:    0,

  // Grass meadow (light scattered food)
  grassMeadowFoodMin:  2,
  grassMeadowFoodMax:  4,
  grassMeadowGrowback: 0.02,

  // Mushroom hotspots — scarce by design to force exploration between patches
  mushroomFoodMin:  3,
  mushroomFoodMax:  5,
  mushroomGrowback: 0.02,
} as const;

// ── Result type ────────────────────────────────────────────────────────────────

export interface WorldGenResult {
  grid:      Tile[][];
  /** Cleared walkable rectangle where dwarves spawn. */
  spawnZone: { x: number; y: number; w: number; h: number };
}

// ── Seeded noise ───────────────────────────────────────────────────────────────

let _worldSeed = 0;

function tileNoise(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + _worldSeed) * 43758.5453;
  return n - Math.floor(n);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── Tile constructors ──────────────────────────────────────────────────────────

function makeDirt(): Tile {
  return { type: TileType.Dirt, foodValue: 0, materialValue: 0, maxFood: 0, maxMaterial: 0, growbackRate: 0 };
}

function makeWater(): Tile {
  return { type: TileType.Water, foodValue: 0, materialValue: 0, maxFood: 0, maxMaterial: 0, growbackRate: 0 };
}

// ── Cluster helpers ────────────────────────────────────────────────────────────

/**
 * Stamp a forest food blob around (cx, cy).
 * Density falls off from centre so blobs look organic, not square.
 * Skip Water and Ore/Stone tiles.
 */
function placeForestCluster(
  grid:        Tile[][],
  cx:          number,
  cy:          number,
  radius:      number,
  foodMin:     number,
  foodMax:     number,
  growback:    number,
) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const t = grid[y][x];
      if (t.type === TileType.Water || t.type === TileType.Ore || t.type === TileType.Stone) continue;

      const dist    = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      // Threshold: near centre ~0.85 chance, at edge ~0.35 chance
      if (tileNoise(x + 5, y + 7) > 0.35 + falloff * 0.50) continue;

      const fMax = lerp(foodMin, foodMax, falloff * (0.6 + tileNoise(x + 3, y + 11) * 0.4));
      grid[y][x] = {
        type:          TileType.Forest,
        foodValue:     fMax * (0.7 + Math.random() * 0.3),
        materialValue: 0,
        maxFood:       fMax,
        maxMaterial:   0,
        growbackRate:  growback,
      };
    }
  }
}

/**
 * Stamp an ore/stone blob around (cx, cy).
 * Skip Water and Forest tiles — ore deposits sit among dirt/grass.
 */
function placeOreCluster(grid: Tile[][], cx: number, cy: number, radius: number) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const t = grid[y][x];
      if (t.type === TileType.Water || t.type === TileType.Forest) continue;

      const dist    = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      if (tileNoise(x + 2, y + 17) > 0.30 + falloff * 0.55) continue;

      const matMax = lerp(WORLD_CONFIG.oreMatMin, WORLD_CONFIG.oreMatMax, falloff * (0.5 + tileNoise(x, y + 5) * 0.5));
      grid[y][x] = {
        type:          tileNoise(x + 1, y + 1) < 0.45 ? TileType.Ore : TileType.Stone,
        foodValue:     0,
        materialValue: matMax * (0.7 + Math.random() * 0.3),
        maxFood:       0,
        maxMaterial:   matMax,
        growbackRate:  WORLD_CONFIG.oreGrowback,
      };
    }
  }
}

/**
 * Stamp a mushroom cluster (radius 2, ~75% fill).
 * Skip Water, Forest, Ore, Stone.
 */
function placeMushroomCluster(grid: Tile[][], cx: number, cy: number) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const t = grid[y][x];
      if (t.type === TileType.Water  || t.type === TileType.Forest ||
          t.type === TileType.Ore    || t.type === TileType.Stone)  continue;
      if (tileNoise(x + 23, y + 41) > 0.75) continue;

      const fMax = lerp(WORLD_CONFIG.mushroomFoodMin, WORLD_CONFIG.mushroomFoodMax, tileNoise(x + 3, y + 13));
      grid[y][x] = {
        type:          TileType.Mushroom,
        foodValue:     fMax * (0.7 + Math.random() * 0.3),
        materialValue: 0,
        maxFood:       fMax,
        maxMaterial:   0,
        growbackRate:  WORLD_CONFIG.mushroomGrowback,
      };
    }
  }
}

/**
 * Stamp a small farmland rectangle. Skip Water tiles.
 */
function placeFarmland(grid: Tile[][], x0: number, y0: number, w: number, h: number) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      if (grid[y][x].type === TileType.Water) continue;
      const fMax = lerp(WORLD_CONFIG.farmFoodMin, WORLD_CONFIG.farmFoodMax, tileNoise(x, y + 20));
      grid[y][x] = {
        type:          TileType.Farmland,
        foodValue:     fMax * (0.7 + Math.random() * 0.3),
        materialValue: 0,
        maxFood:       fMax,
        maxMaterial:   0,
        growbackRate:  WORLD_CONFIG.farmGrowback,
      };
    }
  }
}

// ── Main generator ─────────────────────────────────────────────────────────────
//
// Ordered passes — later passes can overwrite earlier ones; spawn clear always last.
//   1. Fill everything with bare dirt
//   2. Carve river (random y, 2 tiles wide, 2 guaranteed crossings)
//   3. Forest clusters  — 2–3 large blobs on the far side, 1 small on spawn side
//   4. Ore clusters     — 1–2 blobs anywhere not in river/forest
//   5. Grass meadow     — ~25% of remaining bare dirt across the whole map
//   6. Mushroom clusters— 5–8 random positions anywhere (skips forest/ore/water)
//   7. Farmland patches — 1–2 small rectangles near spawn
//   8. Clear spawn zone — always LAST to guarantee walkable start area

export function generateWorld(): WorldGenResult {
  _worldSeed = Math.random() * 10000;

  // ── Geometry decisions ───────────────────────────────────────────────────────

  // River: organic horizontal band with sinusoidal wiggle.
  // Base centre sits in the middle 35–55% of the map; two overlapping sine waves
  // shift the centre ±wiggleAmp tiles as x increases, giving an S-curve feel.
  const riverBaseY  = Math.floor(GRID_SIZE * (0.35 + Math.random() * 0.20)); // 22–35
  const riverW      = 2;   // width at each column
  const wiggleAmp   = 4;   // max deviation from base centre, in tiles

  // Per-column centre: two sin waves with different frequencies and phases
  const riverCenterAt = (x: number): number => {
    const w1 = Math.sin(x * 0.07  + _worldSeed * 0.31) * wiggleAmp * 0.65;
    const w2 = Math.sin(x * 0.18  + _worldSeed * 0.77) * wiggleAmp * 0.35;
    return Math.round(riverBaseY + w1 + w2);
  };

  // Extreme y-extent of the river across the whole map (for placing features)
  const riverBandMin = riverBaseY - wiggleAmp - 1;
  const riverBandMax = riverBaseY + riverW + wiggleAmp + 1;

  // 2 crossings — divide map into left and right halves, one crossing per half
  const crossings = [
    { x:  4 + Math.floor(Math.random() * 20), w: 3 },  // left  half: x 4–23
    { x: 34 + Math.floor(Math.random() * 22), w: 3 },  // right half: x 34–55
  ];

  // Spawn side: north of river or south, chosen randomly
  const spawnInNorth = Math.random() < 0.5;
  const spawnSideMin = spawnInNorth ? 2                    : riverBandMax + 2;
  const spawnSideMax = spawnInNorth ? riverBandMin - 2     : GRID_SIZE - 3;

  // Spawn zone: 12 × 6, centered horizontally in the map, centered vertically on spawn side
  const SPAWN_W = 12, SPAWN_H = 6;
  const spawnX  = Math.floor(GRID_SIZE / 2 - SPAWN_W / 2);
  const spawnY  = Math.max(
    spawnSideMin,
    Math.min(spawnSideMax - SPAWN_H, Math.floor((spawnSideMin + spawnSideMax) / 2 - SPAWN_H / 2)),
  );
  const spawnZone = { x: spawnX, y: spawnY, w: SPAWN_W, h: SPAWN_H };

  // Far side (opposite spawn) — main food zone lives here
  const farSideMin  = spawnInNorth ? riverBandMax + 2  : 2;
  const farSideMax  = spawnInNorth ? GRID_SIZE - 2      : riverBandMin - 3;
  const farSideSpan = farSideMax - farSideMin;

  // ── Pass 1: Bare dirt ────────────────────────────────────────────────────────
  const grid: Tile[][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    grid[y] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      grid[y][x] = makeDirt();
    }
  }

  // ── Pass 2: River ────────────────────────────────────────────────────────────
  // Carve column by column so each x column uses its own wiggly centre y.
  // Crossing columns are skipped entirely, creating natural fords.
  for (let x = 0; x < GRID_SIZE; x++) {
    if (crossings.some(c => x >= c.x && x < c.x + c.w)) continue;
    const cy = riverCenterAt(x);
    for (let y = cy; y < cy + riverW; y++) {
      if (y >= 0 && y < GRID_SIZE) grid[y][x] = makeWater();
    }
  }

  // ── Pass 3: Forest clusters ──────────────────────────────────────────────────
  // 2–3 large blobs on the far side of the river (forces crossing to reach food)
  const numFarForest = 2 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < numFarForest; i++) {
    const cx = 5 + Math.floor(Math.random() * (GRID_SIZE - 10));
    const cy = farSideMin + Math.floor(Math.random() * farSideSpan);
    placeForestCluster(grid, cx, cy, 8 + Math.floor(Math.random() * 7),
      WORLD_CONFIG.forestFoodMin, WORLD_CONFIG.forestFoodMax, WORLD_CONFIG.forestGrowback);
  }
  // 1 smaller blob on the spawn side — just enough to survive without crossing immediately
  {
    const cx = 5 + Math.floor(Math.random() * (GRID_SIZE - 10));
    const cy = spawnSideMin + Math.floor(Math.random() * (spawnSideMax - spawnSideMin));
    placeForestCluster(grid, cx, cy, 5 + Math.floor(Math.random() * 4),
      WORLD_CONFIG.forestFoodMin - 2, WORLD_CONFIG.forestFoodMax - 2, WORLD_CONFIG.forestGrowback);
  }

  // ── Pass 4: Ore clusters ─────────────────────────────────────────────────────
  // 1–2 blobs placed anywhere, avoiding spawn zone vicinity (keeps ore as a
  // destination to seek, not a starting gift)
  const numOre = 1 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < numOre; i++) {
    const cx = 4 + Math.floor(Math.random() * (GRID_SIZE - 8));
    const cy = 4 + Math.floor(Math.random() * (GRID_SIZE - 8));
    placeOreCluster(grid, cx, cy, 6 + Math.floor(Math.random() * 6));
  }

  // ── Pass 5: Grass meadow scatter ─────────────────────────────────────────────
  // ~25% of bare dirt tiles get light food — provides thin sustenance while
  // exploring and gives visual texture to otherwise empty regions.
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (grid[y][x].type !== TileType.Dirt) continue;
      if (tileNoise(x + 13, y + 3) >= 0.25) continue;
      const fMax = lerp(WORLD_CONFIG.grassMeadowFoodMin, WORLD_CONFIG.grassMeadowFoodMax, tileNoise(x + 7, y + 19));
      grid[y][x] = {
        type:          TileType.Grass,
        foodValue:     fMax * (0.7 + Math.random() * 0.3),
        materialValue: 0,
        maxFood:       fMax,
        maxMaterial:   0,
        growbackRate:  WORLD_CONFIG.grassMeadowGrowback,
      };
    }
  }

  // ── Pass 6: Mushroom clusters ────────────────────────────────────────────────
  const numMushrooms = 5 + Math.floor(Math.random() * 4);
  for (let i = 0; i < numMushrooms; i++) {
    placeMushroomCluster(
      grid,
      3 + Math.floor(Math.random() * (GRID_SIZE - 6)),
      3 + Math.floor(Math.random() * (GRID_SIZE - 6)),
    );
  }

  // ── Pass 7: Farmland patches ─────────────────────────────────────────────────
  // 1–2 small farmland rectangles on the spawn side, offset from spawn center
  const numFarm = 1 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < numFarm; i++) {
    const fx = Math.max(1, Math.min(GRID_SIZE - 8, spawnX - 12 + Math.floor(Math.random() * 24)));
    const fy = Math.max(spawnSideMin, Math.min(spawnSideMax - 2, spawnSideMin + Math.floor(Math.random() * (spawnSideMax - spawnSideMin))));
    placeFarmland(grid, fx, fy, 7, 2);
  }

  // ── Pass 8: Clear spawn zone (always LAST) ───────────────────────────────────
  for (let y = spawnY; y < spawnY + SPAWN_H; y++) {
    for (let x = spawnX; x < spawnX + SPAWN_W; x++) {
      if (grid[y][x].type !== TileType.Water) grid[y][x] = makeDirt();
    }
  }

  return { grid, spawnZone };
}

// ── Growback ───────────────────────────────────────────────────────────────────

export function growback(grid: Tile[][]): void {
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];
      if (t.growbackRate > 0 && t.maxFood > 0 && t.foodValue < t.maxFood) {
        t.foodValue = Math.min(t.maxFood, t.foodValue + t.growbackRate);
      }
    }
  }
}

export function isWalkable(grid: Tile[][], x: number, y: number): boolean {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
  return grid[y][x].type !== TileType.Water;
}
