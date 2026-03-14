/**
 * establishStockpile. Goblin picks food/ore/wood/meals/planks/bars by which type the colony
 * is shortest on (fill ratio, colony-wide); places a new pile in the correct room type.
 * Storage: food, ore, wood. Kitchen: meals. Lumber hut: planks. Blacksmith: bars.
 */
import type {
  Room,
  RoomType,
  FoodStockpile,
  OreStockpile,
  WoodStockpile,
  MealStockpile,
  PlankStockpile,
  BarStockpile,
} from '../../shared/types';
import { inverseSigmoid } from '../utilityAI';
import { moveTo, addWorkFatigue } from './helpers';
import {
  countStockpilesInRoom,
  findRoomStockpileSlotPreferClustering,
  pilesInRoom,
} from '../rooms';
import type { Action, ActionContext } from './types';

const MAX_STOCKPILES_PER_STORAGE_ROOM = 20;
const MAX_PILES_PER_SPECIAL_ROOM = 5;
const MAX_FOOD_ORE_WOOD = 200;
const MAX_MEALS_STORED = 50;
const MAX_PLANKS_PER_PILE = 80;
const MAX_BARS_PER_PILE = 80;

export const ESTABLISHABLE_STOCKPILE_TYPES = [
  'food',
  'ore',
  'wood',
  'meals',
  'planks',
  'bars',
] as const;
export type EstablishableKind = (typeof ESTABLISHABLE_STOCKPILE_TYPES)[number];

/** Colony-wide fill ratios for all six types (0 when no capacity). */
export function getColonyFillRatios(
  ctx: ActionContext,
): Record<EstablishableKind, number> {
  const foodCap = ctx.foodStockpiles?.reduce((s, sp) => s + sp.maxFood, 0) ?? 0;
  const foodAmt = ctx.foodStockpiles?.reduce((s, sp) => s + sp.food, 0) ?? 0;
  const oreCap = ctx.oreStockpiles?.reduce((s, sp) => s + sp.maxOre, 0) ?? 0;
  const oreAmt = ctx.oreStockpiles?.reduce((s, sp) => s + sp.ore, 0) ?? 0;
  const woodCap = ctx.woodStockpiles?.reduce((s, sp) => s + sp.maxWood, 0) ?? 0;
  const woodAmt = ctx.woodStockpiles?.reduce((s, sp) => s + sp.wood, 0) ?? 0;
  const mealCap = ctx.mealStockpiles?.reduce((s, sp) => s + sp.maxMeals, 0) ?? 0;
  const mealAmt = ctx.mealStockpiles?.reduce((s, sp) => s + sp.meals, 0) ?? 0;
  const plankCap = ctx.plankStockpiles?.reduce((s, sp) => s + sp.maxPlanks, 0) ?? 0;
  const plankAmt = ctx.plankStockpiles?.reduce((s, sp) => s + sp.planks, 0) ?? 0;
  const barCap = ctx.barStockpiles?.reduce((s, sp) => s + sp.maxBars, 0) ?? 0;
  const barAmt = ctx.barStockpiles?.reduce((s, sp) => s + sp.bars, 0) ?? 0;

  return {
    food: foodCap > 0 ? foodAmt / foodCap : 0,
    ore: oreCap > 0 ? oreAmt / oreCap : 0,
    wood: woodCap > 0 ? woodAmt / woodCap : 0,
    meals: mealCap > 0 ? mealAmt / mealCap : 0,
    planks: plankCap > 0 ? plankAmt / plankCap : 0,
    bars: barCap > 0 ? barAmt / barCap : 0,
  };
}

function canAddInRoom(kind: EstablishableKind, room: Room, ctx: ActionContext): boolean {
  const food = ctx.foodStockpiles ?? [];
  const ore = ctx.oreStockpiles ?? [];
  const wood = ctx.woodStockpiles ?? [];
  const meals = ctx.mealStockpiles ?? [];
  const planks = ctx.plankStockpiles ?? [];
  const bars = ctx.barStockpiles ?? [];

  switch (kind) {
    case 'food':
    case 'ore':
    case 'wood': {
      if (room.type !== 'storage') return false;
      if (countStockpilesInRoom(room, food, ore, wood) >= MAX_STOCKPILES_PER_STORAGE_ROOM)
        return false;
      const inRoom =
        kind === 'food'
          ? pilesInRoom(room, food)
          : kind === 'ore'
            ? pilesInRoom(room, ore)
            : pilesInRoom(room, wood);
      if (inRoom.length === 0) return true;
      const last = inRoom[inRoom.length - 1];
      if (kind === 'food')
        return (last as FoodStockpile).food >= (last as FoodStockpile).maxFood;
      if (kind === 'ore')
        return (last as OreStockpile).ore >= (last as OreStockpile).maxOre;
      return (last as WoodStockpile).wood >= (last as WoodStockpile).maxWood;
    }
    case 'meals': {
      if (room.type !== 'kitchen' || !ctx.mealStockpiles) return false;
      const inRoom = pilesInRoom(room, meals);
      if (inRoom.length >= MAX_PILES_PER_SPECIAL_ROOM) return false;
      if (inRoom.length === 0) return true;
      const last = inRoom[inRoom.length - 1];
      return last.meals >= last.maxMeals;
    }
    case 'planks': {
      if (room.type !== 'lumber_hut' || !ctx.plankStockpiles) return false;
      const inRoom = pilesInRoom(room, planks);
      if (inRoom.length >= MAX_PILES_PER_SPECIAL_ROOM) return false;
      if (inRoom.length === 0) return true;
      const last = inRoom[inRoom.length - 1];
      return last.planks >= last.maxPlanks;
    }
    case 'bars': {
      if (room.type !== 'blacksmith' || !ctx.barStockpiles) return false;
      const inRoom = pilesInRoom(room, bars);
      if (inRoom.length >= MAX_PILES_PER_SPECIAL_ROOM) return false;
      if (inRoom.length === 0) return true;
      const last = inRoom[inRoom.length - 1];
      return last.bars >= last.maxBars;
    }
  }
}

function getSameTypeCoords(
  kind: EstablishableKind,
  room: Room,
  ctx: ActionContext,
): { x: number; y: number }[] {
  const arr = getArrayForKind(kind, ctx);
  return pilesInRoom(room, arr).map(s => ({ x: s.x, y: s.y }));
}

function createPileForKind(
  kind: EstablishableKind,
  pos: { x: number; y: number },
): FoodStockpile | OreStockpile | WoodStockpile | MealStockpile | PlankStockpile | BarStockpile {
  switch (kind) {
    case 'food':
      return { x: pos.x, y: pos.y, food: 0, maxFood: MAX_FOOD_ORE_WOOD };
    case 'ore':
      return { x: pos.x, y: pos.y, ore: 0, maxOre: MAX_FOOD_ORE_WOOD };
    case 'wood':
      return { x: pos.x, y: pos.y, wood: 0, maxWood: MAX_FOOD_ORE_WOOD };
    case 'meals':
      return { x: pos.x, y: pos.y, meals: 0, maxMeals: MAX_MEALS_STORED };
    case 'planks':
      return { x: pos.x, y: pos.y, planks: 0, maxPlanks: MAX_PLANKS_PER_PILE };
    case 'bars':
      return { x: pos.x, y: pos.y, bars: 0, maxBars: MAX_BARS_PER_PILE };
  }
}

function getArrayForKind(
  kind: EstablishableKind,
  ctx: ActionContext,
): (FoodStockpile | OreStockpile | WoodStockpile | MealStockpile | PlankStockpile | BarStockpile)[] {
  switch (kind) {
    case 'food':
      return ctx.foodStockpiles ?? [];
    case 'ore':
      return ctx.oreStockpiles ?? [];
    case 'wood':
      return ctx.woodStockpiles ?? [];
    case 'meals':
      return ctx.mealStockpiles ?? [];
    case 'planks':
      return ctx.plankStockpiles ?? [];
    case 'bars':
      return ctx.barStockpiles ?? [];
  }
}

function getAllowedRoomType(kind: EstablishableKind): RoomType {
  switch (kind) {
    case 'food':
    case 'ore':
    case 'wood':
      return 'storage';
    case 'meals':
      return 'kitchen';
    case 'planks':
      return 'lumber_hut';
    case 'bars':
      return 'blacksmith';
  }
}

/** Most-needed establishable type (colony-wide ratio) that we can add in at least one room. */
function mostNeededAddableType(ctx: ActionContext): EstablishableKind | null {
  const ratios = getColonyFillRatios(ctx);
  const candidates = [...ESTABLISHABLE_STOCKPILE_TYPES].sort(
    (a, b) => ratios[a] - ratios[b],
  );
  const rooms = ctx.rooms ?? [];
  for (const kind of candidates) {
    if (rooms.some(r => getAllowedRoomType(kind) === r.type && canAddInRoom(kind, r, ctx)))
      return kind;
  }
  return null;
}

/** All pile positions in the room from all six types (for occupied set). */
function occupiedInRoom(room: Room, ctx: ActionContext): Set<string> {
  const set = new Set<string>();
  for (const kind of ESTABLISHABLE_STOCKPILE_TYPES) {
    const arr = getArrayForKind(kind, ctx);
    for (const p of pilesInRoom(room, arr)) set.add(`${p.x},${p.y}`);
  }
  return set;
}

export const establishStockpile: Action = {
  name: 'establishStockpile',
  tags: ['work'],
  eligible: (ctx) => {
    const { rooms, foodStockpiles, goblins } = ctx;
    if (!rooms || rooms.length === 0) return false;
    const specType = mostNeededAddableType(ctx);
    if (specType === null) return false;
    const food = foodStockpiles ?? [];
    const totalFood =
      food.reduce((s, sp) => s + sp.food, 0) +
      (goblins?.reduce((s, g) => (g.alive ? s + g.inventory.food : s), 0) ?? 0);
    if (totalFood < 5) return false;
    return true;
  },
  score: ({ goblin }) => {
    return 0.5 * inverseSigmoid(goblin.hunger, 50);
  },
  execute: (ctx) => {
    const { goblin, grid, rooms, onLog } = ctx;
    if (!rooms) return;

    const specType = mostNeededAddableType(ctx);
    if (specType === null) return;

    const allowedType = getAllowedRoomType(specType);
    let nearest: Room | null = null;
    let nearDist = Infinity;
    for (const r of rooms) {
      if (r.type !== allowedType || !canAddInRoom(specType, r, ctx)) continue;
      const cx = r.x + 2;
      const cy = r.y + 2;
      const dist = Math.abs(cx - goblin.x) + Math.abs(cy - goblin.y);
      if (dist < nearDist) {
        nearDist = dist;
        nearest = r;
      }
    }
    if (!nearest) return;

    const cx = nearest.x + 2;
    const cy = nearest.y + 2;
    const roomLabel =
      allowedType === 'storage'
        ? 'storage room'
        : allowedType === 'kitchen'
          ? 'kitchen'
          : allowedType === 'lumber_hut'
            ? 'lumber hut'
            : 'blacksmith';

    if (goblin.x !== cx || goblin.y !== cy) {
      moveTo(goblin, { x: cx, y: cy }, grid);
      goblin.task = `→ ${roomLabel}`;
      return;
    }

    const sameTypeCoords = getSameTypeCoords(specType, nearest, ctx);
    const allOccupied = occupiedInRoom(nearest, ctx);
    const pos = findRoomStockpileSlotPreferClustering(
      grid,
      nearest,
      allOccupied,
      sameTypeCoords,
    );
    if (!pos) return;

    const pile = createPileForKind(specType, pos);
    const arr = getArrayForKind(specType, ctx);
    if (
      (specType === 'meals' && !ctx.mealStockpiles) ||
      (specType === 'planks' && !ctx.plankStockpiles) ||
      (specType === 'bars' && !ctx.barStockpiles)
    )
      return;
    arr.push(pile as FoodStockpile & OreStockpile & WoodStockpile & MealStockpile & PlankStockpile & BarStockpile);

    addWorkFatigue(goblin);
    goblin.task = `established ${specType} storage!`;
    onLog?.(`established a new ${specType} stockpile!`, 'info');
  },
};
