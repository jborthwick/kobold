/**
 * refuelHearth: carry wood to a hearth and add fuel so it stays lit. Hearths decay 1 fuel/tick;
 * when fuel hits 0 they stop providing warmth and can't ignite. Same campfire sprite, grey tint when out.
 */
import { TileType } from '../../shared/types';
import type { Tile } from '../../shared/types';
import { GRID_SIZE, HEARTH_FUEL_MAX, HEARTH_FUEL_PER_WOOD } from '../../shared/constants';
import { ramp, inverseSigmoid } from '../utilityAI';
import { moveToward, addWorkFatigue, nearestStockpile, shouldLog } from './helpers';
import { getUnfurnishedKitchen } from './building';
import type { Action } from './types';

/** Hearth tiles that can accept more fuel (fuel < max). */
function getRefuelableHearths(grid: Tile[][]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const t = grid[y][x];
      if (t.type === TileType.Hearth && (t.hearthFuel ?? 0) < HEARTH_FUEL_MAX) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

function nearestRefuelableHearth(
  gx: number,
  gy: number,
  grid: Tile[][],
): { x: number; y: number } | null {
  const candidates = getRefuelableHearths(grid);
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (const h of candidates) {
    const d = Math.abs(h.x - gx) + Math.abs(h.y - gy);
    if (d < bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return best;
}

function isAdjacent(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
}

export const refuelHearth: Action = {
  name: 'refuelHearth',
  tags: ['work', 'comfort'],
  eligible: ({ goblin, grid, woodStockpiles }) => {
    const refuelable = getRefuelableHearths(grid);
    if (refuelable.length === 0) return false;
    const hasWood = goblin.inventory.wood >= 1 ||
      (woodStockpiles && nearestStockpile(goblin, woodStockpiles, s => s.wood >= 1) !== null);
    return hasWood;
  },
  score: ({ goblin, grid, woodStockpiles, rooms }) => {
    const refuelable = getRefuelableHearths(grid);
    if (refuelable.length === 0) return 0;
    const stockpileWood = woodStockpiles?.reduce((s, w) => s + w.wood, 0) ?? 0;
    const totalWood = stockpileWood + goblin.inventory.wood;
    // Use 0 as min so 1 wood (enough to refuel) gives a positive score — otherwise refuel never wins when low on wood
    const woodFactor = ramp(totalWood, 0, 10);
    const kitchenNeedsLit = getUnfurnishedKitchen(rooms, grid) !== null;
    const coldFactor = inverseSigmoid(goblin.warmth ?? 100, 35, 0.12);
    let base = 0.4 * woodFactor;
    // When kitchen has no lit hearth, strong floor so goblins relight even with only 1 wood
    if (kitchenNeedsLit) base = Math.max(base, totalWood >= 1 ? 0.7 : 0.65 * woodFactor);
    base += 0.25 * coldFactor * woodFactor;
    return Math.min(1.0, base);
  },
  execute: ({ goblin, grid, woodStockpiles, currentTick, onLog }) => {
    const target = nearestRefuelableHearth(goblin.x, goblin.y, grid);
    if (!target) return;

    if (!isAdjacent(goblin.x, goblin.y, target.x, target.y)) {
      moveToward(goblin, target, grid, currentTick, 15);
      goblin.task = '→ hearth to refuel';
      return;
    }

    const needFromStockpile = goblin.inventory.wood >= 1 ? 0 : 1;
    const woodSource = needFromStockpile > 0
      ? nearestStockpile(goblin, woodStockpiles ?? [], s => s.wood >= 1)
      : null;
    if (needFromStockpile > 0 && !woodSource) return;

    const tile = grid[target.y][target.x];
    const addFuel = Math.min(HEARTH_FUEL_MAX - (tile.hearthFuel ?? 0), HEARTH_FUEL_PER_WOOD);
    if (addFuel <= 0) return;

    const useFromInv = Math.min(goblin.inventory.wood, 1);
    goblin.inventory.wood -= useFromInv;
    const useFromStockpile = 1 - useFromInv;
    if (woodSource && useFromStockpile > 0) woodSource.wood -= useFromStockpile;

    tile.hearthFuel = Math.min(HEARTH_FUEL_MAX, (tile.hearthFuel ?? 0) + HEARTH_FUEL_PER_WOOD);
    addWorkFatigue(goblin);
    goblin.task = 'refueled the hearth';
    if (shouldLog(goblin, 'refuelHearth', currentTick, 120)) {
      onLog?.('🪵 refueled the hearth', 'info');
    }
  },
};
