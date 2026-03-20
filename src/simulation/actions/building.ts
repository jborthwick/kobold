/**
 * buildWoodWall, buildStoneWall, buildHearth. Walls use fortifiable room perimeters only
 * (outdoor farm zones excluded). Shared reachable-slot pipeline in wallJobs.ts.
 */
import { TileType, isWallType, isHearthLit } from '../../shared/types';
import type { Tile, Room } from '../../shared/types';
import { GRID_SIZE, HEARTH_FUEL_MAX } from '../../shared/constants';
import { inverseSigmoid, ramp } from '../utilityAI';
import { fortifiableRoomWallSlots, recordSite, pathNextStep, isWallSlotTerrain } from '../agents';
import { moveTo, addWorkFatigue, shouldLog, fatigueRate, nearestStockpile, getOrSetMoveTarget } from './helpers';
import { pickReachableWallSlot, wallCompletionFraction, markWallSlotBlocked } from './wallJobs';
import { addThought } from '../mood';
import type { Action } from './types';

const WOOD_WALL_PLANKS = 2;
const STONE_WALL_BARS = 2;
const MAX_WALL_BUILD_DISTANCE = 15;
const WALL_COMPLETE_THRESHOLD = 0.99;  // bonus until nearly every slot is filled (e.g. after 1–2 burn)
const WALL_INCOMPLETE_BOOST = 0.5;
const WALL_GAP_FLOOR = 1.2;            // minimum multiplier when any gap exists (so refinishing after fire wins)
const WALL_BASE_SCALE = 0.55;

type WallStockpile = { x: number; y: number } & Record<string, number>;

type WallActionConfig = {
  name: 'buildWoodWall' | 'buildStoneWall';
  stockpileKey: 'plankStockpiles' | 'barStockpiles';
  resourceKey: 'planks' | 'bars';
  cost: number;
  wallType: TileType.WoodWall | TileType.StoneWall;
  buildTaskLabel: string;
  moveTaskLabel: string;
};

function totalWallResource(stockpiles: WallStockpile[] | undefined, resourceKey: 'planks' | 'bars'): number {
  return stockpiles?.reduce((sum, stockpile) => sum + (stockpile[resourceKey] ?? 0), 0) ?? 0;
}

function createWallAction(config: WallActionConfig): Action {
  const {
    name,
    stockpileKey,
    resourceKey,
    cost,
    wallType,
    buildTaskLabel,
    moveTaskLabel,
  } = config;

  return {
    name,
    tags: ['work'],
    eligible: (ctx) => {
      if (!ctx.rooms || ctx.rooms.length === 0) return false;
      const stockpiles = (ctx[stockpileKey] as WallStockpile[] | undefined);
      if (totalWallResource(stockpiles, resourceKey) < cost) return false;
      const wallSlots = fortifiableRoomWallSlots(ctx.rooms, ctx.grid, ctx.goblins, ctx.goblin.id, ctx.adventurers);
      if (wallSlots.length === 0) return false;
      const job = pickReachableWallSlot(ctx.goblin, ctx.grid, wallSlots, MAX_WALL_BUILD_DISTANCE, ctx.currentTick);
      return job !== null;
    },
    score: (ctx) => {
      const stockpiles = (ctx[stockpileKey] as WallStockpile[] | undefined);
      const totalResource = totalWallResource(stockpiles, resourceKey);
      if (totalResource < cost) return 0;
      if (!ctx.rooms || ctx.rooms.length === 0) return 0;
      const wallSlots = fortifiableRoomWallSlots(ctx.rooms, ctx.grid, ctx.goblins, ctx.goblin.id, ctx.adventurers);
      if (wallSlots.length === 0) return 0;
      if (!pickReachableWallSlot(ctx.goblin, ctx.grid, wallSlots, MAX_WALL_BUILD_DISTANCE, ctx.currentTick)) return 0;
      const wallFraction = wallCompletionFraction(ctx.grid, wallSlots);
      let base = ramp(totalResource, cost, 20) * inverseSigmoid(ctx.goblin.hunger, 50) * WALL_BASE_SCALE;
      if (wallFraction < WALL_COMPLETE_THRESHOLD) {
        const scaledBoost = 1 + WALL_INCOMPLETE_BOOST * (1 - wallFraction);
        base *= Math.max(scaledBoost, WALL_GAP_FLOOR);
      }
      return Math.min(1.0, base);
    },
    execute: (ctx) => {
      if (!ctx.rooms || ctx.rooms.length === 0) return;
      const stockpiles = (ctx[stockpileKey] as WallStockpile[] | undefined) ?? [];
      const buildStockpile = nearestStockpile(ctx.goblin, stockpiles, s => (s[resourceKey] ?? 0) >= cost);
      if (!buildStockpile) return;

      const wallSlots = fortifiableRoomWallSlots(ctx.rooms, ctx.grid, ctx.goblins, ctx.goblin.id, ctx.adventurers);
      const job = pickReachableWallSlot(ctx.goblin, ctx.grid, wallSlots, MAX_WALL_BUILD_DISTANCE, ctx.currentTick);
      if (!job) {
        const mt = ctx.goblin.moveTarget;
        if (mt && wallSlots.some(s => s.x === mt.x && s.y === mt.y)) {
          ctx.goblin.moveTarget = null;
        }
        return;
      }

      const committedSlot = getOrSetMoveTarget(ctx.goblin, job, ctx.currentTick, 15);
      if (isWallType(ctx.grid[committedSlot.y][committedSlot.x].type)) {
        ctx.goblin.moveTarget = null;
        return;
      }
      if (!isWallSlotTerrain(ctx.grid[committedSlot.y][committedSlot.x].type)) {
        ctx.goblin.moveTarget = null;
        return;
      }
      const next = pathNextStep({ x: ctx.goblin.x, y: ctx.goblin.y }, committedSlot, ctx.grid);
      if (next.x === ctx.goblin.x && next.y === ctx.goblin.y) {
        markWallSlotBlocked(ctx.goblin, committedSlot.x, committedSlot.y, ctx.currentTick);
        ctx.goblin.moveTarget = null;
        return;
      }
      if (next.x === committedSlot.x && next.y === committedSlot.y) {
        const t = ctx.grid[committedSlot.y][committedSlot.x];
        ctx.grid[committedSlot.y][committedSlot.x] = {
          ...t, type: wallType,
          foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0,
        };
        buildStockpile[resourceKey] -= cost;
        addWorkFatigue(ctx.goblin);
        addThought(ctx.goblin, 'built_wall', ctx.currentTick);
        ctx.goblin.task = buildTaskLabel;
      } else {
        ctx.goblin.x = next.x;
        ctx.goblin.y = next.y;
        ctx.goblin.fatigue = Math.min(100, ctx.goblin.fatigue + 0.2 * fatigueRate(ctx.goblin));
        ctx.goblin.task = moveTaskLabel;
      }
    },
  };
}

// --- buildWoodWall: build room perimeter from planks (lumber hut) ---
export const buildWoodWall: Action = createWallAction({
  name: 'buildWoodWall',
  stockpileKey: 'plankStockpiles',
  resourceKey: 'planks',
  cost: WOOD_WALL_PLANKS,
  wallType: TileType.WoodWall,
  buildTaskLabel: 'built wood wall!',
  moveTaskLabel: '→ wood wall',
});

// --- buildStoneWall: build room perimeter from bars (blacksmith) ---
export const buildStoneWall: Action = createWallAction({
  name: 'buildStoneWall',
  stockpileKey: 'barStockpiles',
  resourceKey: 'bars',
  cost: STONE_WALL_BARS,
  wallType: TileType.StoneWall,
  buildTaskLabel: 'built stone wall!',
  moveTaskLabel: '→ stone wall',
});

// --- buildHearth: any goblin builds a hearth from 2 wood when they're cold ---
// "Near base" clustering emerges naturally: goblins spend most time near home,
// so the first fire gets built there. Once it warms that area, nearby goblins
// stay warm and won't build another. Only goblins cold in a different location build elsewhere.
const HEARTH_COVERAGE_RADIUS = 8;  // matches warmth BFS radius — if a hearth covers you, don't build
const HEARTH_BUILD_COOLDOWN = 300; // personal cooldown after placing, prevents back-to-back builds

function isStockpileTile(
  x: number,
  y: number,
  ctx: {
    foodStockpiles?: { x: number; y: number }[];
    mealStockpiles?: { x: number; y: number }[];
    oreStockpiles?: { x: number; y: number }[];
    woodStockpiles?: { x: number; y: number }[];
    plankStockpiles?: { x: number; y: number }[];
    barStockpiles?: { x: number; y: number }[];
  },
): boolean {
  return (
    (ctx.foodStockpiles?.some(s => s.x === x && s.y === y) ?? false)
    || (ctx.mealStockpiles?.some(s => s.x === x && s.y === y) ?? false)
    || (ctx.oreStockpiles?.some(s => s.x === x && s.y === y) ?? false)
    || (ctx.woodStockpiles?.some(s => s.x === x && s.y === y) ?? false)
    || (ctx.plankStockpiles?.some(s => s.x === x && s.y === y) ?? false)
    || (ctx.barStockpiles?.some(s => s.x === x && s.y === y) ?? false)
  );
}

export function getUnfurnishedKitchen(rooms: Room[] | undefined, grid: Tile[][]): Room | null {
  if (!rooms) return null;
  for (const r of rooms) {
    if (r.type !== 'kitchen') continue;
    let hasLitHearth = false;
    for (let dy = 0; dy < r.h; dy++) {
      for (let dx = 0; dx < r.w; dx++) {
        const ny = r.y + dy, nx = r.x + dx;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
          const t = grid[ny][nx];
          if (t.type === TileType.Fire || isHearthLit(t)) hasLitHearth = true;
        }
      }
    }
    if (!hasLitHearth) return r;
  }
  return null;
}

export const buildHearth: Action = {
  name: 'buildHearth',
  tags: ['work', 'comfort'],
  eligible: ({ goblin, woodStockpiles, foodStockpiles, grid, currentTick, rooms }) => {
    const totalFood = foodStockpiles?.reduce((s, f) => s + f.food, 0) ?? 0;
    if (totalFood < 20) return false;
    // Count wood in stockpiles OR goblin's own inventory — so they can build before a wood room is set up
    const stockpileWood = woodStockpiles?.reduce((s, w) => s + w.wood, 0) ?? 0;
    const totalWood = stockpileWood + goblin.inventory.wood;
    if (totalWood < 2) return false;
    
    // A kitchen always needs a hearth if it doesn't have one — bypass cooldown
    if (getUnfurnishedKitchen(rooms, grid)) return true;

    // Personal cooldown — prevents a goblin from placing one then immediately starting another
    if (currentTick - (goblin.lastLoggedTicks['builtHearth'] ?? 0) < HEARTH_BUILD_COOLDOWN) return false;
    // A lit hearth already within coverage radius means this area is served — building would be wasteful
    for (let dy = -HEARTH_COVERAGE_RADIUS; dy <= HEARTH_COVERAGE_RADIUS; dy++) {
      for (let dx = -HEARTH_COVERAGE_RADIUS; dx <= HEARTH_COVERAGE_RADIUS; dx++) {
        const nx = goblin.x + dx, ny = goblin.y + dy;
        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE
          && isHearthLit(grid[ny][nx])) return false;
      }
    }
    return true;
  },
  score: ({ goblin, woodStockpiles, rooms, grid }) => {
    const stockpileWood = woodStockpiles?.reduce((s, w) => s + w.wood, 0) ?? 0;
    const totalWood = stockpileWood + goblin.inventory.wood;
    
    let base = 0;
    if (getUnfurnishedKitchen(rooms, grid)) {
      // High priority task if a kitchen is lacking a hearth
      base = 0.8 * ramp(totalWood, 2, 20);
    } else {
      const warmth = goblin.warmth ?? 100;
      base = inverseSigmoid(warmth, 25, 0.12)
        * ramp(totalWood, 2, 20)
        * inverseSigmoid(goblin.hunger, 60)
        * 0.5;
    }

    // Centralized momentum applied in utilityAI — no per-action bonus needed
    return Math.min(1.0, base);
  },
  execute: ({
    goblin,
    grid,
    woodStockpiles,
    foodStockpiles,
    mealStockpiles,
    oreStockpiles,
    plankStockpiles,
    barStockpiles,
    currentTick,
    onLog,
    rooms,
  }) => {
    // Consume wood from inventory first, then pull from nearest stockpile
    const inventoryWood = goblin.inventory.wood;
    const needFromStockpile = Math.max(0, 2 - inventoryWood);
    const buildStockpile = needFromStockpile > 0
      ? nearestStockpile(goblin, woodStockpiles ?? [], s => s.wood >= needFromStockpile)
      : null;
    // If we need stockpile wood but don't have it, bail
    if (needFromStockpile > 0 && !buildStockpile) return;

    let buildTarget: { x: number; y: number } | null = null;
    const unfurnishedKitchen = getUnfurnishedKitchen(rooms, grid);

    if (unfurnishedKitchen) {
      // Prefer the kitchen center, but never place a hearth on top of a stockpile.
      const cx = unfurnishedKitchen.x + Math.floor(unfurnishedKitchen.w / 2);
      const cy = unfurnishedKitchen.y + Math.floor(unfurnishedKitchen.h / 2);
      let best: { x: number; y: number } | null = null;
      let bestDist = Infinity;
      for (let dy = 0; dy < unfurnishedKitchen.h; dy++) {
        for (let dx = 0; dx < unfurnishedKitchen.w; dx++) {
          const nx = unfurnishedKitchen.x + dx;
          const ny = unfurnishedKitchen.y + dy;
          if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
          const t = grid[ny][nx];
          if (t.type !== TileType.Dirt && t.type !== TileType.Grass) continue;
          if (isStockpileTile(nx, ny, { foodStockpiles, mealStockpiles, oreStockpiles, woodStockpiles, plankStockpiles, barStockpiles })) continue;
          const dist = Math.abs(nx - cx) + Math.abs(ny - cy);
          if (dist < bestDist) { bestDist = dist; best = { x: nx, y: ny }; }
        }
      }
      buildTarget = best;
    } else {
      // Find best buildable Dirt/Grass tile near goblin's current position.
      // Soft home bias: score = distToGoblin + 0.2 × distToHome, so tiles toward home are preferred
      // without being forced. When the goblin is already near home, fires cluster there naturally.
      let bestScore = Infinity;
      const RADIUS = 5;
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          const nx = goblin.x + dx, ny = goblin.y + dy;
          if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
          const t = grid[ny][nx];
          if (t.type !== TileType.Dirt && t.type !== TileType.Grass) continue;
          if (isStockpileTile(nx, ny, { foodStockpiles, mealStockpiles, oreStockpiles, woodStockpiles, plankStockpiles, barStockpiles })) continue;
          const distToGoblin = Math.abs(dx) + Math.abs(dy);
          const distToHome = Math.abs(nx - goblin.homeTile.x) + Math.abs(ny - goblin.homeTile.y);
          const siteScore = distToGoblin + 0.2 * distToHome;
          if (siteScore < bestScore) { bestScore = siteScore; buildTarget = { x: nx, y: ny }; }
        }
      }
    }
    
    if (!buildTarget) return;

    // Move toward build site
    if (goblin.x !== buildTarget.x || goblin.y !== buildTarget.y) {
      moveTo(goblin, buildTarget, grid);
      goblin.task = '→ hearth site';
      return;
    }

    // Place the hearth
    if (isStockpileTile(buildTarget.x, buildTarget.y, { foodStockpiles, mealStockpiles, oreStockpiles, woodStockpiles, plankStockpiles, barStockpiles })) return;
    const t = grid[buildTarget.y][buildTarget.x];
    grid[buildTarget.y][buildTarget.x] = {
      ...t, type: TileType.Hearth,
      foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0,
      hearthFuel: HEARTH_FUEL_MAX,
    };
    // Deduct wood: use inventory first, then pull remainder from stockpile
    const useFromInv = Math.min(goblin.inventory.wood, 2);
    goblin.inventory.wood -= useFromInv;
    const useFromStockpile = 2 - useFromInv;
    if (buildStockpile && useFromStockpile > 0) buildStockpile.wood -= useFromStockpile;
    addWorkFatigue(goblin);
    goblin.lastLoggedTicks['builtHearth'] = currentTick;
    recordSite(goblin.knownHearthSites ?? (goblin.knownHearthSites = []), buildTarget.x, buildTarget.y, 1, currentTick);
    goblin.task = 'built a hearth!';
    if (shouldLog(goblin, 'buildHearth', currentTick, 300)) {
      onLog?.('🔥 built a hearth for warmth', 'info');
    }
  },
};
