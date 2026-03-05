import type { Room, FoodStockpile, OreStockpile, WoodStockpile } from '../../shared/types';
import { inverseSigmoid } from '../utilityAI';
import { moveTo, addWorkFatigue } from './helpers';
import type { Action, ActionContext } from './types';

/** Pick the storage type the colony needs most, avoiding duplicates with spare capacity. */
function mostNeededStockpileType(
  ctx: ActionContext,
): 'food' | 'ore' | 'wood' {
  const foodCap  = ctx.foodStockpiles?.reduce((s, sp) => s + sp.maxFood, 0) ?? 0;
  const foodAmt  = ctx.foodStockpiles?.reduce((s, sp) => s + sp.food, 0) ?? 0;
  const oreCap   = ctx.oreStockpiles?.reduce((s, sp) => s + sp.maxOre, 0) ?? 0;
  const oreAmt   = ctx.oreStockpiles?.reduce((s, sp) => s + sp.ore, 0) ?? 0;
  const woodCap  = ctx.woodStockpiles?.reduce((s, sp) => s + sp.maxWood, 0) ?? 0;
  const woodAmt  = ctx.woodStockpiles?.reduce((s, sp) => s + sp.wood, 0) ?? 0;

  const foodRatio = foodCap > 0 ? foodAmt / foodCap : 0;
  const oreRatio  = oreCap  > 0 ? oreAmt  / oreCap  : 0;
  const woodRatio = woodCap > 0 ? woodAmt / woodCap : 0;

  const rooms = ctx.rooms ?? [];

  // Rank by ratio (lower = more needed). Skip types that have an unfull room already.
  const candidates: Array<{ type: 'food' | 'ore' | 'wood'; ratio: number }> = [
    { type: 'food', ratio: foodRatio },
    { type: 'ore',  ratio: oreRatio },
    { type: 'wood', ratio: woodRatio },
  ];

  // Dedup: if a room already specializes in this type and has capacity, bump its ratio
  for (const c of candidates) {
    const hasUnfull = rooms.some(r => r.specialization === c.type);
    if (hasUnfull && c.ratio < 1) c.ratio += 10;  // push to bottom
  }

  candidates.sort((a, b) => a.ratio - b.ratio);
  return candidates[0].type;
}

export const establishStockpile: Action = {
  name: 'establishStockpile',
  eligible: ({ rooms, foodStockpiles, goblins }) => {
    if (!rooms || rooms.length === 0) return false;
    // Need at least one unspecialized room
    if (!rooms.some(r => r.specialization === undefined)) return false;
    // Colony not starving — don't divert from foraging
    const totalFood = (foodStockpiles?.reduce((s, sp) => s + sp.food, 0) ?? 0)
      + (goblins?.reduce((s, g) => g.alive ? s + g.inventory.food : s, 0) ?? 0);
    if (totalFood < 5) return false;
    return true;
  },
  score: ({ goblin }) => {
    return 0.4 * inverseSigmoid(goblin.hunger, 50);
  },
  execute: (ctx) => {
    const { goblin, grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles, onLog } = ctx;
    if (!rooms) return;

    // Find nearest unspecialized room
    let nearest: Room | null = null;
    let nearDist = Infinity;
    for (const r of rooms) {
      if (r.specialization !== undefined) continue;
      const cx = r.x + 2, cy = r.y + 2;
      const dist = Math.abs(cx - goblin.x) + Math.abs(cy - goblin.y);
      if (dist < nearDist) { nearDist = dist; nearest = r; }
    }
    if (!nearest) return;

    const cx = nearest.x + 2, cy = nearest.y + 2;

    // Navigate to room center
    if (goblin.x !== cx || goblin.y !== cy) {
      moveTo(goblin, { x: cx, y: cy }, grid);
      goblin.task = '→ storage room';
      return;
    }

    // Arrived — pick specialization and create stockpile
    const specType = mostNeededStockpileType(ctx);
    nearest.specialization = specType;

    if (specType === 'food' && foodStockpiles) {
      foodStockpiles.push({ x: cx, y: cy, food: 0, maxFood: 200 } as FoodStockpile);
    } else if (specType === 'ore' && oreStockpiles) {
      oreStockpiles.push({ x: cx, y: cy, ore: 0, maxOre: 200 } as OreStockpile);
    } else if (specType === 'wood' && woodStockpiles) {
      woodStockpiles.push({ x: cx, y: cy, wood: 0, maxWood: 200 } as WoodStockpile);
    }

    addWorkFatigue(goblin);
    goblin.task = `established ${specType} storage!`;
    onLog?.(`designated a new ${specType} storage room!`, 'info');
  },
};
