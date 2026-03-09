/**
 * Firefighting action — goblins fetch water from a lake and douse nearby fire tiles.
 *
 * Two-phase loop using goblin.carryingWater:
 *   Phase 1 (not carrying): navigate to nearest Water tile; collect on arrival.
 *   Phase 2 (carrying):     navigate to nearest Fire tile; douse on arrival.
 *                           80% chance to extinguish; 20% chance to catch fire (bruise).
 *
 * Score scales with proximity to fire, so goblins respond urgently to nearby flames
 * but won't abandon critical survival needs for a distant blaze.
 */

import { TileType, type Tile } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { inverseSigmoid } from '../utilityAI';
import { effectiveVision } from '../wounds';
import { moveTo, shouldLog, addWorkFatigue, getOrSetMoveTarget } from './helpers';
import { addThought } from '../mood';
import type { Action } from './types';

const FIRE_SCAN_RADIUS = 18;   // tiles — how far to look for fire
const WATER_SCAN_RADIUS = 24;   // tiles — how far to look for water (lakes can be far)
const DOUSE_CHANCE = 0.80; // probability of extinguishing the fire tile
const SINGE_CHANCE = 0.20; // probability of taking a light wound while dousing

/** Find the nearest Fire tile within radius. Returns null if none. */
function nearestFire(
  cx: number, cy: number, grid: Tile[][], radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  const x0 = Math.max(0, cx - radius), x1 = Math.min(GRID_SIZE - 1, cx + radius);
  const y0 = Math.max(0, cy - radius), y1 = Math.min(GRID_SIZE - 1, cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (grid[y][x].type !== TileType.Fire) continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < bestDist) { bestDist = d; best = { x, y }; }
    }
  }
  return best;
}

const WATER_SOURCES = new Set([TileType.Water, TileType.Pool]);

/** Find the nearest Water or Pool tile within radius. Returns null if none. */
function nearestWater(
  cx: number, cy: number, grid: Tile[][], radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  const x0 = Math.max(0, cx - radius), x1 = Math.min(GRID_SIZE - 1, cx + radius);
  const y0 = Math.max(0, cy - radius), y1 = Math.min(GRID_SIZE - 1, cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!WATER_SOURCES.has(grid[y][x].type)) continue;
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d < bestDist) { bestDist = d; best = { x, y }; }
    }
  }
  return best;
}

export const fightFire: Action = {
  name: 'fightFire',
  tags: ['fire', 'work'],
  eligible({ goblin, grid }) {
    // Only respond to fire within scan radius
    return nearestFire(goblin.x, goblin.y, grid, FIRE_SCAN_RADIUS) !== null;
  },

  score({ goblin, grid }) {
    const fire = nearestFire(goblin.x, goblin.y, grid, FIRE_SCAN_RADIUS);
    if (!fire) return 0;

    const dist = Math.abs(fire.x - goblin.x) + Math.abs(fire.y - goblin.y);
    const vision = effectiveVision(goblin);

    // Urgency: smooth ramp based on distance, high when close, trails off at scan limit.
    // 0.8 at distance 1, 0.2 at scan limit.
    const base = 0.8 * inverseSigmoid(dist, vision, 0.2);

    // Momentum: if already fetching water or fighting fire, stay committed.
    const active = goblin.task.includes('fire') || goblin.task.includes('water') || goblin.carryingWater;
    const momentum = active ? 0.15 : 0;

    return Math.min(1.0, base + momentum);
  },

  execute({ goblin, grid, currentTick, onLog }) {

    if (!goblin.carryingWater) {
      // ── Phase 1: go fetch water ──────────────────────────────────────────────
      const water = nearestWater(goblin.x, goblin.y, grid, WATER_SCAN_RADIUS);
      if (!water) {
        // No water reachable — give up this tick
        goblin.carryingWater = false;
        goblin.task = 'looking for water (no lake?)';
        return;
      }

      const dist = Math.abs(water.x - goblin.x) + Math.abs(water.y - goblin.y);
      if (dist <= 1) {
        // Adjacent to water — fill up
        goblin.carryingWater = true;
        goblin.task = '💧 filled bucket';
        if (shouldLog(goblin, 'fillBucket', currentTick, 60)) {
          onLog?.(`💧 ${goblin.name} filled a bucket from the lake`, 'info');
        }
      } else {
        const dest = getOrSetMoveTarget(goblin, water, currentTick, 20, 1);
        moveTo(goblin, dest, grid);
        goblin.task = `→ water (${dist} tiles)`;
      }

    } else {
      // ── Phase 2: douse the fire ───────────────────────────────────────────────
      const fire = nearestFire(goblin.x, goblin.y, grid, FIRE_SCAN_RADIUS);
      if (!fire) {
        // Fire out already — drop water, mission accomplished
        goblin.carryingWater = false;
        goblin.task = 'fire already out';
        return;
      }

      const dist = Math.abs(fire.x - goblin.x) + Math.abs(fire.y - goblin.y);
      if (dist <= 1) {
        // Adjacent to fire — pour water
        goblin.carryingWater = false;
        addWorkFatigue(goblin);

        if (Math.random() < DOUSE_CHANCE) {
          // Extinguish the tile
          const t = grid[fire.y][fire.x];
          grid[fire.y][fire.x] = {
            type: TileType.Dirt,
            foodValue: 0, maxFood: 0,
            materialValue: 0, maxMaterial: 0,
            growbackRate: 0,
            trafficScore: t.trafficScore,
          };
          addThought(goblin, 'doused_fire', currentTick);
          goblin.task = '🚿 doused the fire!';
          if (shouldLog(goblin, 'dousedFire', currentTick, 30)) {
            onLog?.(`🚿 ${goblin.name} doused a fire tile!`, 'info');
          }
        } else {
          goblin.task = 'missed the fire!';
        }

        // Singe risk — being this close to fire can set the goblin alight
        if (Math.random() < SINGE_CHANCE && !goblin.onFire) {
          goblin.onFire = true;
          goblin.onFireTick = currentTick;
          addThought(goblin, 'singed_by_fire', currentTick);
          onLog?.(`🔥 ${goblin.name} caught fire while fighting the flames!`, 'warn');
        }

      } else {
        const dest = getOrSetMoveTarget(goblin, fire, currentTick, 20, 1);
        moveTo(goblin, dest, grid);
        goblin.task = `→ fire (bucket ready, ${dist} tiles)`;
      }
    }
  },
};
