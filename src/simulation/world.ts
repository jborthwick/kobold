import { TileType, type Tile } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';

// ── World Config ───────────────────────────────────────────────────────────────
// Tune these values to adjust scarcity pressure.
// Total NW forest food should support ~5 dwarves for ~20 minutes before
// requiring active management — if they never starve, lower forestGrowback.
const WORLD_CONFIG = {
  // NW forest peak (primary food — rich tiles, slow but meaningful regrowth)
  forestFoodMin:  8,
  forestFoodMax:  12,
  forestGrowback: 0.3,   // units/tick — slow enough to deplete under pressure

  // Farmland strip (fallback food — small patch, slow regrowth, low ceiling)
  farmFoodMin:    2,
  farmFoodMax:    3,
  farmGrowback:   0.15,

  // Sparse grass everywhere else (filler — barely worth eating)
  grassFood:      0,
  grassGrowback:  0.1,   // inert — growback() checks maxFood > 0, which is 0 for grass

  // SE ore peak (material — finite, doesn't regrow)
  oreMatMin:      8,
  oreMatMax:      12,
  oreGrowback:    0,
} as const;

// Horizontal river at y=30–32.  Two narrow crossing gaps let dwarves pass.
const RIVER_Y_MIN = 30;
const RIVER_Y_MAX = 32;
const CROSSINGS   = [
  { x: 19, w: 3 },   // west crossing  — x=19, 20, 21
  { x: 43, w: 3 },   // east crossing  — x=43, 44, 45
];

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Deterministic per-tile pseudo-noise in [0, 1].  Same (x,y) → same value. */
function tileNoise(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Linear interpolate between a and b by t∈[0,1]. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Return a bare dirt tile (barren ground, no food). */
function makeDirt(): Tile {
  return {
    type:          TileType.Dirt,
    foodValue:     WORLD_CONFIG.grassFood,
    materialValue: 0,
    maxFood:       WORLD_CONFIG.grassFood,
    maxMaterial:   0,
    growbackRate:  WORLD_CONFIG.grassGrowback,
  };
}

// ── World generation ───────────────────────────────────────────────────────────
//
// Six ordered passes on top of a noise base:
//   1. Fill everything with sparse grass
//   2. Carve horizontal river at y=30–32 (two walkable crossing gaps)
//   3. Force NW forest peak: x<28, y<30 — 60% of tiles → dense forest (8–12 food)
//   4. Force SE ore peak:    x>36, y>36 — 65% of tiles → ore/stone (8–12 material)
//   5. Farmland strip at y=41–42, x<15 — small fallback patch (2–3 food)
//   6. Clear spawn zone (18–30, 33–38) → grass — only the spawn rows, preserves y=28–29 forest

export function generateWorld(): Tile[][] {
  const grid: Tile[][] = [];

  // ── Pass 1: Sparse grass everywhere ─────────────────────────────────────────
  for (let y = 0; y < GRID_SIZE; y++) {
    grid[y] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      grid[y][x] = makeDirt();
    }
  }

  // ── Pass 2: Horizontal river ─────────────────────────────────────────────────
  for (let y = RIVER_Y_MIN; y <= RIVER_Y_MAX; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const isCrossing = CROSSINGS.some(c => x >= c.x && x < c.x + c.w);
      if (!isCrossing) {
        grid[y][x] = {
          type:          TileType.Water,
          foodValue:     0, materialValue: 0,
          maxFood:       0, maxMaterial:   0,
          growbackRate:  0,
        };
      }
    }
  }

  // ── Pass 3: NW forest peak ───────────────────────────────────────────────────
  // 60% of tiles in (x<28, y<30) become dense forest (food 8–12).
  // Extending to y<30 brings forest right to the south bank of the river so
  // dwarves with vision≥4 can see food from spawn y=33–37 after crossing.
  // 40% remain sparse grass — natural gaps and clearings.
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 28; x++) {
      const n = tileNoise(x, y);
      if (n < 0.60) {
        const foodMax = lerp(
          WORLD_CONFIG.forestFoodMin,
          WORLD_CONFIG.forestFoodMax,
          tileNoise(x + 5, y + 11),   // second sample for value variation
        );
        grid[y][x] = {
          type:          TileType.Forest,
          foodValue:     foodMax * (0.7 + Math.random() * 0.3),
          materialValue: 0,
          maxFood:       foodMax,
          maxMaterial:   0,
          growbackRate:  WORLD_CONFIG.forestGrowback,
        };
      }
      // Remaining 40% keep the grass tile from pass 1
    }
  }

  // ── Pass 4: SE ore peak ──────────────────────────────────────────────────────
  // 65% of tiles in (x>36, y>36): Ore (richer) or Stone (moderate).
  for (let y = 37; y < GRID_SIZE; y++) {
    for (let x = 37; x < GRID_SIZE; x++) {
      if (grid[y][x].type === TileType.Water) continue;
      const n = tileNoise(x, y);
      if (n < 0.65) {
        const matMax = lerp(
          WORLD_CONFIG.oreMatMin,
          WORLD_CONFIG.oreMatMax,
          tileNoise(x + 3, y + 7),
        );
        grid[y][x] = {
          type:          n < 0.35 ? TileType.Ore : TileType.Stone,
          foodValue:     0,
          materialValue: matMax * (0.7 + Math.random() * 0.3),
          maxFood:       0,
          maxMaterial:   matMax,
          growbackRate:  WORLD_CONFIG.oreGrowback,
        };
      }
    }
  }

  // ── Pass 5: Farmland strip ───────────────────────────────────────────────────
  // Small patch at y=41–42, far left (x<15) — 30 tiles total.
  // Spawn is at x=20–28, so farmland is 5–28 tiles west; forces travel to reach it.
  // Food is low, regrowth slow — barely sustainable under 5-dwarf pressure.
  for (let y = 41; y <= 42; y++) {
    for (let x = 0; x < 15; x++) {
      if (grid[y][x].type === TileType.Water) continue;
      const foodMax = lerp(
        WORLD_CONFIG.farmFoodMin,
        WORLD_CONFIG.farmFoodMax,
        tileNoise(x, y + 20),
      );
      grid[y][x] = {
        type:          TileType.Farmland,
        foodValue:     foodMax * (0.7 + Math.random() * 0.3),
        materialValue: 0,
        maxFood:       foodMax,
        maxMaterial:   0,
        growbackRate:  WORLD_CONFIG.farmGrowback,
      };
    }
  }

  // ── Pass 6: Clear spawn zone ─────────────────────────────────────────────────
  // Run LAST so any forest tiles in the spawn rectangle get cleared.
  // Only clear y=33–38 (the actual spawn rows) — y=28–29 forest rows are kept
  // so they remain visible from spawn and pull dwarves toward the river crossing.
  for (let y = 33; y <= 38; y++) {
    for (let x = 18; x <= 30; x++) {
      if (grid[y][x].type === TileType.Water) continue; // preserve river
      grid[y][x] = makeDirt();
    }
  }

  return grid;
}

// ── Growback ───────────────────────────────────────────────────────────────────
// Each tile grows back by its own growbackRate per tick.
// Materials (ore) don't regrow — oreGrowback is 0.

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
