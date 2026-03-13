/**
 * establishStockpile. Goblin picks food/ore/wood by which type the colony is shortest on
 * (fill ratio); places a new pile in a storage room slot. Lets storage rooms grow with
 * demand instead of fixed layouts.
 */
import type { Room, FoodStockpile, OreStockpile, WoodStockpile } from '../../shared/types';
import { inverseSigmoid } from '../utilityAI';
import { moveTo, addWorkFatigue } from './helpers';
import { countStockpilesInRoom, findRoomStockpileSlotPreferClustering } from '../rooms';
import type { Action, ActionContext } from './types';

const MAX_STOCKPILES_PER_STORAGE_ROOM = 20;

/** Pick the storage type the colony needs most (by fill ratio). */
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

  const candidates: Array<{ type: 'food' | 'ore' | 'wood'; ratio: number }> = [
    { type: 'food', ratio: foodRatio },
    { type: 'ore',  ratio: oreRatio },
    { type: 'wood', ratio: woodRatio },
  ];
  candidates.sort((a, b) => a.ratio - b.ratio);
  return candidates[0].type;
}

function stockpilesInRoom(room: Room, food: FoodStockpile[], ore: OreStockpile[], wood: WoodStockpile[]) {
  const inR = (x: number, y: number) =>
    x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
  return {
    food: food.filter(s => inR(s.x, s.y)),
    ore: ore.filter(s => inR(s.x, s.y)),
    wood: wood.filter(s => inR(s.x, s.y)),
  };
}

/** True if we're allowed to add one more stockpile of type T in this room: room has capacity, and either no pile of type T yet or the last one is full. */
function roomCanAddStockpileOfType(
  room: Room,
  type: 'food' | 'ore' | 'wood',
  food: FoodStockpile[],
  ore: OreStockpile[],
  wood: WoodStockpile[],
): boolean {
  if (room.type !== 'storage') return false;
  const total = countStockpilesInRoom(room, food, ore, wood);
  if (total >= MAX_STOCKPILES_PER_STORAGE_ROOM) return false;
  const inRoom = stockpilesInRoom(room, food, ore, wood);
  if (type === 'food') {
    if (inRoom.food.length === 0) return true;
    const last = inRoom.food[inRoom.food.length - 1];
    return last.food >= last.maxFood;
  }
  if (type === 'ore') {
    if (inRoom.ore.length === 0) return true;
    const last = inRoom.ore[inRoom.ore.length - 1];
    return last.ore >= last.maxOre;
  }
  if (inRoom.wood.length === 0) return true;
  const last = inRoom.wood[inRoom.wood.length - 1];
  return last.wood >= last.maxWood;
}

export const establishStockpile: Action = {
  name: 'establishStockpile',
  tags: ['work'],
  eligible: (ctx) => {
    const { rooms, foodStockpiles, oreStockpiles, woodStockpiles, goblins } = ctx;
    if (!rooms || rooms.length === 0) return false;
    const food = foodStockpiles ?? [];
    const ore = oreStockpiles ?? [];
    const wood = woodStockpiles ?? [];
    const specType = mostNeededStockpileType(ctx);
    const canAddSomewhere = rooms.some(r => roomCanAddStockpileOfType(r, specType, food, ore, wood));
    if (!canAddSomewhere) return false;
    const totalFood = food.reduce((s, sp) => s + sp.food, 0) + (goblins?.reduce((s, g) => g.alive ? s + g.inventory.food : s, 0) ?? 0);
    if (totalFood < 5) return false;
    return true;
  },
  // Score when not hungry so establishing stockpiles can compete with other work
  score: ({ goblin }) => {
    return 0.5 * inverseSigmoid(goblin.hunger, 50);
  },
  execute: (ctx) => {
    const { goblin, grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles, onLog } = ctx;
    if (!rooms || !foodStockpiles || !oreStockpiles || !woodStockpiles) return;

    const specType = mostNeededStockpileType(ctx);
    // Find nearest storage room where we're allowed to add a pile of specType (last of that type full, or none yet)
    let nearest: Room | null = null;
    let nearDist = Infinity;
    for (const r of rooms) {
      if (!roomCanAddStockpileOfType(r, specType, foodStockpiles, oreStockpiles, woodStockpiles)) continue;
      const cx = r.x + 2, cy = r.y + 2;
      const dist = Math.abs(cx - goblin.x) + Math.abs(cy - goblin.y);
      if (dist < nearDist) { nearDist = dist; nearest = r; }
    }
    if (!nearest) return;

    const cx = nearest.x + 2, cy = nearest.y + 2;

    if (goblin.x !== cx || goblin.y !== cy) {
      moveTo(goblin, { x: cx, y: cy }, grid);
      goblin.task = '→ storage room';
      return;
    }

    const inRoom = stockpilesInRoom(nearest, foodStockpiles, oreStockpiles, woodStockpiles);
    const sameTypeCoords = specType === 'food'
      ? inRoom.food.map(s => ({ x: s.x, y: s.y }))
      : specType === 'ore'
        ? inRoom.ore.map(s => ({ x: s.x, y: s.y }))
        : inRoom.wood.map(s => ({ x: s.x, y: s.y }));
    const allOccupied = new Set([
      ...foodStockpiles.map(s => `${s.x},${s.y}`),
      ...oreStockpiles.map(s => `${s.x},${s.y}`),
      ...woodStockpiles.map(s => `${s.x},${s.y}`),
    ]);
    const pos = findRoomStockpileSlotPreferClustering(grid, nearest, allOccupied, sameTypeCoords);
    if (!pos) return;

    if (specType === 'food') {
      foodStockpiles.push({ x: pos.x, y: pos.y, food: 0, meals: 0, maxFood: 200 } as FoodStockpile);
    } else if (specType === 'ore') {
      oreStockpiles.push({ x: pos.x, y: pos.y, ore: 0, maxOre: 200 } as OreStockpile);
    } else {
      woodStockpiles.push({ x: pos.x, y: pos.y, wood: 0, maxWood: 200 } as WoodStockpile);
    }

    addWorkFatigue(goblin);
    goblin.task = `established ${specType} storage!`;
    onLog?.(`established a new ${specType} stockpile!`, 'info');
  },
};
