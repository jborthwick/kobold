/**
 * Rain pooling system — water collects in lowlands during rain and slowly evaporates.
 *
 * "Lowlands" are approximated by proximity to permanent Water tiles (lakeshore /
 * riverbank tiles are always at low elevation in the biome system).  No elevation
 * data needs to be stored on tiles.
 *
 * During rain:
 *   Dirt / Grass / Farmland tiles adjacent to Water or Pool convert to Pool.
 *
 * After rain (or in drought):
 *   Pool tiles older than POOL_MIN_AGE evaporate back to their priorType.
 *   Drought accelerates evaporation significantly.
 */

import { TileType, type Tile, type WeatherType } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';

// Tile types that can seed new pools (permanent water sources)
const POOL_SOURCES  = new Set([TileType.Water, TileType.Pool]);
// Tile types that are eligible to become pools
const POOL_ELIGIBLE = new Set([TileType.Dirt, TileType.Grass, TileType.Farmland]);

const POOL_CHANCE_RAIN  = 0.001;  // per eligible tile per tick during rain
const POOL_MIN_AGE      = 80;     // ticks a pool must exist before it can evaporate
const POOL_EVAP_CHANCE  = 0.008;  // per pool tile per tick (not raining)
const POOL_EVAP_DROUGHT = 0.05;   // per pool tile per tick (drought — evaporates fast)

const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

function hasAdjacentSource(grid: Tile[][], x: number, y: number): boolean {
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
    if (POOL_SOURCES.has(grid[ny][nx].type)) return true;
  }
  return false;
}

export function tickPooling(
  grid: Tile[][],
  currentTick: number,
  weatherType: WeatherType,
): void {
  const isRaining  = weatherType === 'rain' || weatherType === 'storm';
  const isDrought  = weatherType === 'drought';
  const evapChance = isDrought ? POOL_EVAP_DROUGHT : POOL_EVAP_CHANCE;
  const poolChance = weatherType === 'storm' ? POOL_CHANCE_RAIN * 3 : POOL_CHANCE_RAIN;

  const newPools:  { x: number; y: number; prior: TileType }[] = [];
  const evaporate: { x: number; y: number }[] = [];

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];

      if (isRaining && POOL_ELIGIBLE.has(t.type)) {
        // Form a pool if adjacent to water/pool and roll succeeds
        if (hasAdjacentSource(grid, x, y) && Math.random() < poolChance) {
          newPools.push({ x, y, prior: t.type });
        }
      } else if (t.type === TileType.Pool) {
        const age = currentTick - (t.poolTick ?? currentTick);
        // Only evaporate once pool has settled, and not during active rain
        if (!isRaining && age >= POOL_MIN_AGE && Math.random() < evapChance) {
          evaporate.push({ x, y });
        }
      }
    }
  }

  // Apply new pools
  for (const { x, y, prior } of newPools) {
    const t = grid[y][x];
    grid[y][x] = {
      ...t,
      type:      TileType.Pool,
      foodValue: 0, maxFood: 0,
      growbackRate: 0,
      poolTick:  currentTick,
      priorType: prior,
    };
  }

  // Evaporate pools back to original tile type
  for (const { x, y } of evaporate) {
    const t = grid[y][x];
    const restored = t.priorType ?? TileType.Dirt;
    grid[y][x] = {
      type:         restored,
      foodValue:    0,
      maxFood:      restored === TileType.Grass ? 4 : 0,
      materialValue: 0,
      maxMaterial:  0,
      growbackRate: restored === TileType.Grass ? 0.04 : restored === TileType.Farmland ? 0.02 : 0,
      trafficScore: t.trafficScore,
    };
  }
}
