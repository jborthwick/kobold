import { TileType, type Tile } from '../shared/types';
import { GRID_SIZE, MAX_FOOD_VALUE, MAX_MATERIAL_VALUE, GROWBACK_RATE } from '../shared/constants';

// Dual-peak Sugarscape layout.
// A diagonal river (where x + y is in [58, 65]) splits the map:
//   NW zone (x+y < 58):  food-rich farmland
//   SE zone (x+y > 65):  material-rich stone/ore
const FOOD_PEAK = { x: 12, y: 12 };
const MAT_PEAK  = { x: 52, y: 52 };
const RIVER_MIN = 58;
const RIVER_MAX = 65;

function dist(x: number, y: number, px: number, py: number) {
  return Math.sqrt((x - px) ** 2 + (y - py) ** 2);
}

function darkenColor(color: number, factor: number): number {
  const r = Math.floor(((color >> 16) & 0xff) * (1 - factor));
  const g = Math.floor(((color >> 8) & 0xff) * (1 - factor));
  const b = Math.floor((color & 0xff) * (1 - factor));
  return (r << 16) | (g << 8) | b;
}

// Exported so WorldScene can use it without importing Phaser
export { darkenColor };

export function generateWorld(): Tile[][] {
  const grid: Tile[][] = [];

  for (let y = 0; y < GRID_SIZE; y++) {
    grid[y] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      const sum = x + y;

      if (sum >= RIVER_MIN && sum <= RIVER_MAX) {
        grid[y][x] = {
          type: TileType.Water,
          foodValue: 0, materialValue: 0,
          maxFood: 0,   maxMaterial: 0,
        };
        continue;
      }

      if (sum < RIVER_MIN) {
        // NW food zone
        const d = dist(x, y, FOOD_PEAK.x, FOOD_PEAK.y);
        const foodMax = Math.max(0, MAX_FOOD_VALUE - d * 0.25);
        const type = foodMax > 5 ? TileType.Farmland
                   : foodMax > 2 ? TileType.Grass
                   : TileType.Forest;
        grid[y][x] = {
          type,
          foodValue:    foodMax * (0.7 + Math.random() * 0.3),
          materialValue: 0,
          maxFood:      foodMax,
          maxMaterial:  0,
        };
      } else {
        // SE material zone
        const d = dist(x, y, MAT_PEAK.x, MAT_PEAK.y);
        const matMax = Math.max(0, MAX_MATERIAL_VALUE - d * 0.25);
        const type = matMax > 5 ? TileType.Ore
                   : matMax > 2 ? TileType.Stone
                   : TileType.Grass;
        grid[y][x] = {
          type,
          foodValue:    0,
          materialValue: matMax * (0.7 + Math.random() * 0.3),
          maxFood:      0,
          maxMaterial:  matMax,
        };
      }
    }
  }

  return grid;
}

export function growback(grid: Tile[][]): void {
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];
      if (t.maxFood > 0 && t.foodValue < t.maxFood) {
        t.foodValue = Math.min(t.maxFood, t.foodValue + GROWBACK_RATE * t.maxFood);
      }
      if (t.maxMaterial > 0 && t.materialValue < t.maxMaterial) {
        t.materialValue = Math.min(t.maxMaterial, t.materialValue + GROWBACK_RATE * t.maxMaterial);
      }
    }
  }
}

export function isWalkable(grid: Tile[][], x: number, y: number): boolean {
  if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
  return grid[y][x].type !== TileType.Water;
}
