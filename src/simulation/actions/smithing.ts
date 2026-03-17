/**
 * smith. Requires a blacksmith room; consumes ore from stockpile to produce bars into the
 * blacksmith's bar stockpile. Work at the anvil (room center); bars used for building
 * or future crafting.
 */
import type { BarStockpile } from '../../shared/types';
import { inverseSigmoid, ramp } from '../utilityAI';
import { grantXp } from '../skills';
import { moveToward, addWorkFatigue, nearestStockpile } from './helpers';
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
  tags: ['work', 'forge'],
  eligible: (ctx) => {
    const { rooms, oreStockpiles, goblin, barStockpiles } = ctx;
    if (!rooms?.some(r => r.type === 'blacksmith')) return false;
    const totalBars = barStockpiles?.reduce((s, p) => s + p.bars, 0) ?? 0;
    if (totalBars >= MAX_BARS_PER_PILE) return false;
    const hasOre = oreStockpiles?.some(s => s.ore >= ORE_COST);
    return (hasOre ?? false) || (goblin.smithingProgress !== undefined && goblin.smithingProgress > 0);
  },
  score: (ctx) => {
    const { goblin, oreStockpiles, resourceBalance, rooms, goblins, roomBonuses, barStockpiles } = ctx;
    if (goblin.smithingProgress !== undefined && goblin.smithingProgress > 0) return 0.58;
    const totalOre = oreStockpiles?.reduce((s, p) => s + p.ore, 0) ?? 0;
    if (totalOre < 5) return 0;
    const oreInputFactor = ramp(totalOre, 5, 25);
    const totalBars = barStockpiles?.reduce((s, p) => s + p.bars, 0) ?? 0;
    const { upgradesPressure = 0.35, materialPriority = 1 } = resourceBalance ?? {};
    const hasBlacksmith = roomBonuses?.hasBlacksmith ?? (rooms?.some(r => r.type === 'blacksmith') ?? false);
    const barsScarce = hasBlacksmith && totalBars < MAX_BARS_PER_PILE * 0.4;
    let base = upgradesPressure * oreInputFactor * inverseSigmoid(goblin.hunger, 50) * (0.6 + 0.4 * materialPriority);
    if (hasBlacksmith && barsScarce) {
      base *= 1.25;
    }

    const smithRoom = rooms?.find(r => r.type === 'blacksmith');
    if (smithRoom && goblins) {
      const anvil = getAnvilTile(smithRoom);
      const othersAtAnvilOrSmithing = goblins.filter(
        g => g.alive && g.id !== goblin.id && (g.smithingProgress !== undefined || (g.x === anvil.x && g.y === anvil.y))
      );
      if (othersAtAnvilOrSmithing.length >= 1) base *= 0.5;
    }
    return Math.min(1.0, base);
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
      const oreSource = nearestStockpile(goblin, oreStockpiles, s => s.ore >= ORE_COST);
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
      grantXp(goblin, 'smith', currentTick, onLog);
    }
  },
};
