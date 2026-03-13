/**
 * saw. Requires a lumber_hut room; consumes wood from stockpile to produce planks into the
 * hut's plank stockpile. Work happens at the saw tile (room center); planks used for
 * building or future crafting.
 */
import type { PlankStockpile } from '../../shared/types';
import { inverseSigmoid, ramp } from '../utilityAI';
import { moveToward, addWorkFatigue, nearestWoodStockpile } from './helpers';
import { addThought } from '../mood';
import type { Action, ActionContext } from './types';

const WOOD_COST = 3;
const SAWING_TICKS_REQUIRED = 45;
const PLANKS_PER_BATCH = 5;
const MAX_PLANKS_PER_PILE = 80;

/** Saw tile is the center of the lumber hut. */
function getSawTile(room: { x: number; y: number; w: number; h: number }) {
  return { x: room.x + Math.floor(room.w / 2), y: room.y + Math.floor(room.h / 2) };
}

/** Find or auto-create a PlankStockpile in the lumber hut (corner tile). */
function getOrCreatePlankStockpile(ctx: ActionContext): PlankStockpile | null {
  const hut = ctx.rooms?.find(r => r.type === 'lumber_hut');
  if (!hut || !ctx.plankStockpiles) return null;
  const px = hut.x + 3;
  const py = hut.y + 1;
  let pile = ctx.plankStockpiles.find(p => p.x === px && p.y === py);
  if (!pile) {
    pile = { x: px, y: py, planks: 0, maxPlanks: MAX_PLANKS_PER_PILE };
    ctx.plankStockpiles.push(pile);
  }
  return pile;
}

export const saw: Action = {
  name: 'saw',
  tags: ['work'],
  eligible: (ctx) => {
    const { rooms, woodStockpiles, goblin, plankStockpiles } = ctx;
    if (!rooms?.some(r => r.type === 'lumber_hut')) return false;
    const totalPlanks = plankStockpiles?.reduce((s, p) => s + p.planks, 0) ?? 0;
    if (totalPlanks >= MAX_PLANKS_PER_PILE) return false;
    const hasWood = woodStockpiles?.some(s => s.wood >= WOOD_COST);
    return (hasWood ?? false) || (goblin.sawingProgress !== undefined && goblin.sawingProgress > 0);
  },
  score: (ctx) => {
    const { goblin, woodStockpiles, resourceBalance, roomBonuses, plankStockpiles } = ctx;
    if (goblin.sawingProgress !== undefined && goblin.sawingProgress > 0) return 0.95;
    const totalWood = woodStockpiles?.reduce((s, p) => s + p.wood, 0) ?? 0;
    if (totalWood < 5) return 0;
    const woodInputFactor = ramp(totalWood, 5, 25);
    const totalPlanks = plankStockpiles?.reduce((s, p) => s + p.planks, 0) ?? 0;
    const { upgradesPressure = 0.35, materialPriority = 1 } = resourceBalance ?? {};
    const hasLumberHut = roomBonuses?.hasLumberHut ?? false;
    const planksScarce = hasLumberHut && totalPlanks < MAX_PLANKS_PER_PILE * 0.4;
    let base = upgradesPressure * woodInputFactor * inverseSigmoid(goblin.hunger, 50) * (0.6 + 0.4 * materialPriority);
    if (hasLumberHut && planksScarce) {
      base *= 1.3;
    }
    return Math.min(1.0, base);
  },
  execute: (ctx) => {
    const { goblin, grid, rooms, woodStockpiles, onLog, currentTick } = ctx;
    const hut = rooms?.find(r => r.type === 'lumber_hut');
    if (!hut || !woodStockpiles) return;

    const sawTile = getSawTile(hut);

    if (goblin.x !== sawTile.x || goblin.y !== sawTile.y) {
      moveToward(goblin, sawTile, grid, currentTick, 20);
      goblin.task = '→ lumber hut';
      return;
    }

    if (goblin.sawingProgress === undefined) {
      const woodSource = nearestWoodStockpile(goblin, woodStockpiles, s => s.wood >= WOOD_COST);
      if (!woodSource) {
        goblin.task = 'lumber hut needs wood';
        return;
      }
      woodSource.wood -= WOOD_COST;
      goblin.sawingProgress = 1;
      goblin.task = 'sawing (starting...)';
      return;
    }

    goblin.sawingProgress += 1;
    goblin.sawingLastActiveTick = currentTick;
    const pct = Math.floor((goblin.sawingProgress / SAWING_TICKS_REQUIRED) * 100);
    goblin.task = `sawing (${pct}%)`;

    if (goblin.sawingProgress >= SAWING_TICKS_REQUIRED) {
      const pile = getOrCreatePlankStockpile(ctx);
      if (pile) {
        const actual = Math.min(pile.maxPlanks - pile.planks, PLANKS_PER_BATCH);
        pile.planks += actual;
        addThought(goblin, 'crafted_meal', currentTick);
        onLog?.(`🪵 ${goblin.name} sawed ${actual} planks!`, 'info');
      }
      goblin.sawingProgress = undefined;
      addWorkFatigue(goblin);
    }
  },
};
