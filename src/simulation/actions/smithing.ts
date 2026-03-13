/**
 * smith. Requires a blacksmith room; consumes ore from stockpile to produce bars into the
 * blacksmith's bar stockpile. Work at the anvil (room center); bars used for building
 * or future crafting.
 */
import type { BarStockpile } from '../../shared/types';
import { inverseSigmoid, ramp } from '../utilityAI';
import { moveToward, addWorkFatigue, nearestOreStockpile } from './helpers';
import { addThought } from '../mood';
import type { Action, ActionContext } from './types';

const ORE_COST = 5; // increased from 3 to make smithing more resource-constrained
const SMITHING_TICKS_REQUIRED = 50;
const BARS_PER_BATCH = 5;
const MAX_BARS_PER_PILE = 80;

/** Anvil tile is the center of the blacksmith. */
function getAnvilTile(room: { x: number; y: number; w: number; h: number }) {
  return { x: room.x + Math.floor(room.w / 2), y: room.y + Math.floor(room.h / 2) };
}

/** Find or auto-create a BarStockpile in the blacksmith (corner tile). */
function getOrCreateBarStockpile(ctx: ActionContext): BarStockpile | null {
  const smith = ctx.rooms?.find(r => r.type === 'blacksmith');
  if (!smith || !ctx.barStockpiles) return null;
  const px = smith.x + 3;
  const py = smith.y + 1;
  let pile = ctx.barStockpiles.find(p => p.x === px && p.y === py);
  if (!pile) {
    pile = { x: px, y: py, bars: 0, maxBars: MAX_BARS_PER_PILE };
    ctx.barStockpiles.push(pile);
  }
  return pile;
}

export const smith: Action = {
  name: 'smith',
  tags: ['work'],
  eligible: (ctx) => {
    const { rooms, oreStockpiles, goblin, barStockpiles } = ctx;
    if (!rooms?.some(r => r.type === 'blacksmith')) return false;
    const totalBars = barStockpiles?.reduce((s, p) => s + p.bars, 0) ?? 0;
    if (totalBars >= MAX_BARS_PER_PILE) return false;
    const hasOre = oreStockpiles?.some(s => s.ore >= ORE_COST);
    return (hasOre ?? false) || (goblin.smithingProgress !== undefined && goblin.smithingProgress > 0);
  },
  score: (ctx) => {
    const { goblin, oreStockpiles, barStockpiles } = ctx;
    if (goblin.smithingProgress !== undefined && goblin.smithingProgress > 0) return 0.95;
    const totalOre = oreStockpiles?.reduce((s, p) => s + p.ore, 0) ?? 0;
    const totalBars = barStockpiles?.reduce((s, p) => s + p.bars, 0) ?? 0;
    if (totalOre < 5) return 0;
    const oreAbundance = ramp(totalOre, 10, 50);
    const barScarcity = inverseSigmoid(totalBars, 20); // lowered from 30 to satisfy sooner
    return Math.min(1.0, oreAbundance * barScarcity * 0.40 * inverseSigmoid(goblin.hunger, 50)); // reduced from 0.45 to 0.40
  },
  execute: (ctx) => {
    const { goblin, grid, rooms, oreStockpiles, onLog, currentTick } = ctx;
    const smith = rooms?.find(r => r.type === 'blacksmith');
    if (!smith || !oreStockpiles) return;

    const anvilTile = getAnvilTile(smith);

    if (goblin.x !== anvilTile.x || goblin.y !== anvilTile.y) {
      moveToward(goblin, anvilTile, grid, currentTick, 20);
      goblin.task = '→ blacksmith';
      return;
    }

    if (goblin.smithingProgress === undefined) {
      const oreSource = nearestOreStockpile(goblin, oreStockpiles, s => s.ore >= ORE_COST);
      if (!oreSource) {
        goblin.task = 'blacksmith needs ore';
        return;
      }
      oreSource.ore -= ORE_COST;
      goblin.smithingProgress = 1;
      goblin.task = 'smithing (starting...)';
      return;
    }

    goblin.smithingProgress += 1;
    goblin.smithingLastActiveTick = currentTick;
    const pct = Math.floor((goblin.smithingProgress / SMITHING_TICKS_REQUIRED) * 100);
    goblin.task = `smithing (${pct}%)`;

    if (goblin.smithingProgress >= SMITHING_TICKS_REQUIRED) {
      const pile = getOrCreateBarStockpile(ctx);
      if (pile) {
        const actual = Math.min(pile.maxBars - pile.bars, BARS_PER_BATCH);
        pile.bars += actual;
        addThought(goblin, 'crafted_meal', currentTick);
        onLog?.(`⚒ ${goblin.name} forged ${actual} bars!`, 'info');
      }
      goblin.smithingProgress = undefined;
      addWorkFatigue(goblin);
    }
  },
};
