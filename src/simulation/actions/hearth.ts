/**
 * refuelHearth: carry wood to a hearth and add fuel so it stays lit. Hearths decay 1 fuel/tick;
 * when fuel hits 0 they stop providing warmth and can't ignite. Same campfire sprite, grey tint when out.
 */
import { TileType } from '../../shared/types';
import type { Tile } from '../../shared/types';
import { GRID_SIZE, HEARTH_FUEL_MAX, HEARTH_FUEL_PER_WOOD, HEARTH_REFUEL_THRESHOLD } from '../../shared/constants';
import { ramp, inverseSigmoid } from '../utilityAI';
import { moveToward, addWorkFatigue, nearestStockpile, nearestPoint, isAdjacent, shouldLog } from './helpers';
import { getUnfurnishedKitchen } from './building';
import type { Action } from './types';

/** Hearth tiles that need refuel (fuel low or out, below threshold). */
function getRefuelableHearths(grid: Tile[][]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];
      if (t.type === TileType.Hearth && (t.hearthFuel ?? 0) < HEARTH_REFUEL_THRESHOLD) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

export const refuelHearth: Action = {
  name: 'refuelHearth',
  tags: ['work', 'comfort'],
  eligible: ({ goblin, grid, woodStockpiles }) => {
    // Need at least one refuelable hearth and a way to get wood (inventory or stockpile).
    const refuelable = getRefuelableHearths(grid);
    return refuelable.length > 0 && (
      goblin.inventory.wood >= 1 ||
      nearestStockpile(goblin, woodStockpiles ?? [], s => s.wood >= 1) !== null
    );
  },
  score: ({ goblin, grid, woodStockpiles, rooms }) => {
    const refuelable = getRefuelableHearths(grid);
    if (refuelable.length === 0) return 0;
    // Minimum fuel among refuelable hearths: urgency high when out or very low, lower when just under threshold.
    const minFuel = Math.min(...refuelable.map(p => grid[p.y][p.x].hearthFuel ?? 0));
    const fuelUrgency = inverseSigmoid(minFuel, 50, 0.1);
    // Base score from colony wood supply; boost when kitchen needs a lit hearth or goblin is cold.
    const stockpileWood = woodStockpiles?.reduce((s, w) => s + w.wood, 0) ?? 0;
    const totalWood = stockpileWood + goblin.inventory.wood;
    const woodFactor = ramp(totalWood, 0, 10);
    const kitchenNeedsLit = getUnfurnishedKitchen(rooms, grid) !== null;
    const coldFactor = inverseSigmoid(goblin.warmth ?? 100, 35, 0.12);
    let base = 0.4 * woodFactor;
    if (kitchenNeedsLit) base = Math.max(base, totalWood >= 1 ? 0.7 : 0.65 * woodFactor);
    base += 0.25 * coldFactor * woodFactor;
    base *= 0.5 + 0.5 * fuelUrgency;
    return Math.min(1.0, base);
  },
  execute: ({ goblin, grid, woodStockpiles, currentTick, onLog }) => {
    // Pick nearest refuelable hearth; path there if not adjacent.
    const target = nearestPoint(goblin, getRefuelableHearths(grid));
    if (!target) return;
    if (!isAdjacent(goblin, target)) {
      moveToward(goblin, target, grid, currentTick, 15);
      goblin.task = '→ hearth to refuel';
      return;
    }

    // Take 1 wood from inventory first, then stockpile if needed; bail if we can't get any.
    const fromInv = Math.min(goblin.inventory.wood, 1);
    const need = 1 - fromInv;
    const woodSource = need > 0 ? nearestStockpile(goblin, woodStockpiles ?? [], s => s.wood >= 1) : null;
    if (need > 0 && !woodSource) return;

    // Add fuel to hearth, deduct wood, apply fatigue and log.
    const tile = grid[target.y][target.x];
    const addFuel = Math.min(HEARTH_FUEL_MAX - (tile.hearthFuel ?? 0), HEARTH_FUEL_PER_WOOD);
    if (addFuel <= 0) return;
    goblin.inventory.wood -= fromInv;
    if (woodSource && need > 0) woodSource.wood -= need;
    tile.hearthFuel = Math.min(HEARTH_FUEL_MAX, (tile.hearthFuel ?? 0) + HEARTH_FUEL_PER_WOOD);
    addWorkFatigue(goblin);
    goblin.task = 'refueled the hearth';
    if (shouldLog(goblin, 'refuelHearth', currentTick, 120)) {
      onLog?.('🪵 refueled the hearth', 'info');
    }
  },
};
