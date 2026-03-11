/**
 * Lightning strikes random tiles during storms (BASE_LIGHTNING_CHANCE per tick). Flammable →
 * ignite; Water/Pool absorb; else scorch to Dirt. Adds risk so storm weather isn't purely beneficial.
 */

import { TileType, type Tile, type WeatherType } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';

const BASE_LIGHTNING_CHANCE = 0.02;   // per tick during storm (~1 strike per 50 ticks)

const FLAMMABLE = new Set([
  TileType.Grass, TileType.Forest, TileType.Mushroom,
  TileType.Farmland, TileType.TreeStump,
]);

const ABSORB = new Set([TileType.Water, TileType.Pool, TileType.Fire]);

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

export function tickLightning(
  grid:        Tile[][],
  currentTick: number,
  weatherType: WeatherType,
  onLog?:      LogFn,
): void {
  if (weatherType !== 'storm') return;
  if (Math.random() >= BASE_LIGHTNING_CHANCE) return;

  const x = Math.floor(Math.random() * GRID_SIZE);
  const y = Math.floor(Math.random() * GRID_SIZE);
  const t = grid[y][x];

  if (ABSORB.has(t.type)) {
    // Water/pool absorbs silently; already-burning tile needs no action
    return;
  }

  if (FLAMMABLE.has(t.type)) {
    grid[y][x] = {
      ...t,
      type: TileType.Fire, foodValue: 0, maxFood: 0,
      materialValue: 0, maxMaterial: 0, growbackRate: 0,
      fireTick: currentTick,
    };
    onLog?.(`⚡ Lightning struck ${t.type} at (${x},${y}) — it's on fire!`, 'warn');
  } else {
    // Non-flammable struck tile gets scorched to Dirt
    grid[y][x] = {
      type: TileType.Dirt, foodValue: 0, maxFood: 0,
      materialValue: 0, maxMaterial: 0, growbackRate: 0,
      trafficScore: t.trafficScore,
    };
    onLog?.(`⚡ Lightning struck ${t.type} at (${x},${y}).`, 'info');
  }
}
