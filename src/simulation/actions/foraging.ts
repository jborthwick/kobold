/**
 * Forage (scan for food, pathfind, harvest), depositFood, withdrawFood.
 * Hunger-driven; uses knownFoodSites when no patch in range. When colony is short on food,
 * forage gets a score floor so goblins "stock the larder" even when not hungry. depositFood
 * scores with modest surplus (ramp + hunger gate) so stockpiles fill. Foragers get 2 food/tile, others 1.
 */
import { TileType } from '../../shared/types';
import type { Goblin, ResourceSite, Tile } from '../../shared/types';
import { GRID_SIZE, MAX_INVENTORY_CAPACITY } from '../../shared/constants';
import { sigmoid, inverseSigmoid, ramp } from '../utilityAI';
import {
  bestFoodTile, recordSite, FORAGEABLE_TILES, SITE_RECORD_THRESHOLD, PATCH_MERGE_RADIUS, traitMod,
} from '../agents';
import { grantXp, skillYieldBonus, xpToLevel } from '../skills';
import { effectiveVision, woundYieldMultiplier } from '../wounds';
import { moveTo, moveToward, addWorkFatigue, shouldLog, totalLoad, nearestStockpile, getWalkableAdjacent } from './helpers';
import type { Action, ActionContext } from './types';

/** Total stored food below which forage/deposit "stock the larder" nudges apply (one place). */
const LARDER_TARGET = 80;
/** consumablesPressure above this → "stock the larder" score floor (aligned with utilityAI consumables midpoint). */
const CONSUMABLES_STOCK_LARDER = 0.5;

function getForageRadius(goblin: Goblin): number {
  const vision = effectiveVision(goblin);
  const maxSearch = traitMod(goblin, 'maxSearchRadius', 15);
  return goblin.hunger > 20
    ? maxSearch
    : Math.round(Math.min(vision * (1 + sigmoid(goblin.hunger, 60) * 0.8), maxSearch));
}

function getFoodTarget(goblin: Goblin, grid: Tile[][]): { x: number; y: number } | null {
  return bestFoodTile(goblin, grid, getForageRadius(goblin));
}

function larderContext(ctx: Pick<ActionContext, 'foodStockpiles' | 'rooms' | 'roomBonuses'>): { totalStoredFood: number; storageHungry: boolean } {
  const hasStorageRoom = ctx.roomBonuses?.hasStorage ?? (ctx.rooms?.some(r => r.type === 'storage') ?? false);
  const totalStoredFood = ctx.foodStockpiles?.reduce((s, sp) => s + sp.food, 0) ?? 0;
  return { totalStoredFood, storageHungry: hasStorageRoom && totalStoredFood < LARDER_TARGET };
}

// --- forage: scan for food, pathfind, harvest ---
export const forage: Action = {
  name: 'forage',
  tags: ['work'],
  eligible: ({ goblin }) => totalLoad(goblin.inventory) < MAX_INVENTORY_CAPACITY,
  score: (ctx) => {
    const { goblin, grid, resourceBalance } = ctx;
    const { storageHungry } = larderContext(ctx);
    const target = getFoodTarget(goblin, grid);
    const { foodPriority = 0, consumablesPressure = 0.5 } = resourceBalance ?? {};
    const colonyFoodBlend = 0.5 + 0.5 * consumablesPressure;
    const noFood = goblin.inventory.food === 0 && goblin.inventory.meals === 0;
    const survivalBoost = noFood && goblin.hunger > 65 ? 1.3 : 1.0;
    const stockTheLarder = consumablesPressure > CONSUMABLES_STOCK_LARDER;

    if (!target) {
      if (goblin.knownFoodSites.length > 0) {
        let s = sigmoid(goblin.hunger, 40) * 0.4 * (1 + foodPriority * 0.8) * survivalBoost * colonyFoodBlend;
        if (storageHungry) s *= 1.3;
        if (stockTheLarder) s = Math.max(s, 0.35);
        return Math.min(1.0, s);
      }
      return 0;
    }
    let base = sigmoid(goblin.hunger, 40);
    if (storageHungry) base *= 1.2;
    if (stockTheLarder) base = Math.max(base, 0.35);
    // When carrying food, prefer eat over forage at extreme hunger; when no food, keep foraging (can't eat)
    const finalScore = goblin.hunger > 85 ? (noFood ? base : base * 0.4) : base;
    return Math.min(1.0, finalScore * (1 + foodPriority * 0.8) * survivalBoost * colonyFoodBlend);
  },
  execute: (ctx) => {
    const { goblin, grid, currentTick, goblins, onLog } = ctx;
    const foodTarget = getFoodTarget(goblin, grid);

    if (!foodTarget) {
      if (goblin.knownFoodSites.length > 0) {
        const best = goblin.knownFoodSites.reduce((a, b) => b.value > a.value ? b : a);
        if (goblin.x === best.x && goblin.y === best.y) {
          const tileHere = grid[goblin.y][goblin.x];
          const stillGood = tileHere.foodValue >= 1 && FORAGEABLE_TILES.has(tileHere.type);
          if (!stillGood) {
            let better: ResourceSite | null = null;
            for (let dy = -PATCH_MERGE_RADIUS; dy <= PATCH_MERGE_RADIUS; dy++) {
              for (let dx = -PATCH_MERGE_RADIUS; dx <= PATCH_MERGE_RADIUS; dx++) {
                const nx = best.x + dx, ny = best.y + dy;
                if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
                const t = grid[ny][nx];
                if (!FORAGEABLE_TILES.has(t.type) || t.foodValue < 1) continue;
                if (!better || t.foodValue > better.value) {
                  better = { x: nx, y: ny, value: t.foodValue, tick: currentTick };
                }
              }
            }
            if (better) {
              const replacement = better;
              goblin.knownFoodSites = goblin.knownFoodSites.map(
                s => (s.x === best.x && s.y === best.y) ? replacement : s,
              );
            } else {
              goblin.knownFoodSites = goblin.knownFoodSites.filter(
                s => !(s.x === best.x && s.y === best.y),
              );
            }
            goblin.task = 'searching for food';
          } else {
            recordSite(goblin.knownFoodSites, best.x, best.y, tileHere.foodValue, currentTick);
            goblin.task = 'at patch (harvesting)';
          }
        } else {
          moveToward(goblin, best, grid, currentTick);
          goblin.task = '→ remembered patch';
        }
      } else {
        goblin.task = 'searching for food';
      }
      return;
    }

    const targetTile = grid[foodTarget.y][foodTarget.x];
    if (targetTile.foodValue >= SITE_RECORD_THRESHOLD) {
      recordSite(goblin.knownFoodSites, foodTarget.x, foodTarget.y, targetTile.foodValue, currentTick);
    }

    if (goblin.x !== foodTarget.x || goblin.y !== foodTarget.y) {
      moveToward(goblin, foodTarget, grid, currentTick);
      goblin.task = `foraging → (${foodTarget.x},${foodTarget.y})`;
      return;
    }

    const here = grid[goblin.y][goblin.x];
    const contestPriority = (g: Goblin) => g.hunger + xpToLevel(g.skills.forage) * 5;
    const rival = goblins?.find(d =>
      d.alive && d.id !== goblin.id &&
      d.x === goblin.x && d.y === goblin.y &&
      contestPriority(d) > contestPriority(goblin),
    );
    if (rival) {
      const relation = goblin.relations[rival.id] ?? 50;
      if (relation >= 60) {
        goblin.relations[rival.id] = Math.min(100, relation + 2);
        goblin.task = `sharing tile with ${rival.name}`;
        return;
      }
      const penalty = traitMod(goblin, 'contestPenalty', -5);
      const newRel = Math.max(0, relation + penalty);
      goblin.relations[rival.id] = newRel;
      if (relation >= 20 && newRel < 20 && shouldLog(goblin, `rival_${rival.id}`, currentTick, 300)) {
        onLog?.(`💢 growing rivalry with ${rival.name}`, 'warn');
      }
      const escapeOpen = getWalkableAdjacent(grid, goblin.x, goblin.y);
      if (escapeOpen.length > 0) {
        const step = escapeOpen[Math.floor(Math.random() * escapeOpen.length)];
        goblin.x = step.x; goblin.y = step.y;
      }
      goblin.task = `yielding to ${rival.name}`;
      return;
    }

    const headroom = MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory);
    if (FORAGEABLE_TILES.has(here.type) && here.foodValue >= 1) {
      const gatherBonus = traitMod(goblin, 'gatheringPower', 0);
      const depletionRate = 5 + gatherBonus;
      const baseYield = 1 + gatherBonus + skillYieldBonus(goblin);
      const moraleScale = 0.5 + (goblin.morale / 100) * 0.5;
      const fatigueScale = 1.0 - inverseSigmoid(goblin.fatigue, 70, 0.12) * 0.5;
      const woundScale = woundYieldMultiplier(goblin);
      const harvestYield = Math.max(1, Math.round(baseYield * moraleScale * fatigueScale * woundScale));
      const hadFood = here.foodValue;
      const depleted = Math.min(hadFood, depletionRate);
      here.foodValue = Math.max(0, hadFood - depleted);
      if (here.foodValue === 0) { here.type = TileType.Dirt; here.maxFood = 0; }
      const amount = Math.min(harvestYield, depleted, headroom);
      goblin.inventory.food += amount;
      addWorkFatigue(goblin);
      grantXp(goblin, 'forage', currentTick, onLog);
      goblin.task = `harvesting (food: ${goblin.inventory.food.toFixed(0)})`;
    } else {
      goblin.task = `foraging → (${foodTarget.x},${foodTarget.y})`;
    }
  },
};

// --- depositFood: carry surplus food to stockpile ---
// Score grows with inventory surplus; suppressed when hungry so they eat first. Ramp and base tuned so deposit wins with modest surplus.
const DEPOSIT_KEEP_FOOD = 6; // food kept after deposit (prevents depositing everything)
export const depositFood: Action = {
  name: 'depositFood',
  tags: ['work'],
  eligible: ({ goblin, foodStockpiles }) => {
    if (goblin.inventory.food <= DEPOSIT_KEEP_FOOD) return false;
    return nearestStockpile(goblin, foodStockpiles, s => s.food < s.maxFood) !== null;
  },
  score: (ctx) => {
    const { goblin, foodStockpiles, resourceBalance } = ctx;
    const { storageHungry } = larderContext(ctx);
    const onStockpile = foodStockpiles?.some(s => s.x === goblin.x && s.y === goblin.y) ?? false;
    const { foodPriority = 0, consumablesPressure = 0.5 } = resourceBalance ?? {};
    const stockTheLarder = consumablesPressure > CONSUMABLES_STOCK_LARDER;
    // Ramp 3–12 so deposit scores with less carried food; hunger gate at 58 so they still haul when moderately hungry
    let base = ramp(goblin.inventory.food, 3, 12) * inverseSigmoid(goblin.hunger, 58) * 0.65 * (onStockpile ? 2.5 : 1.0) * (1 + foodPriority * 0.4);
    if (storageHungry) {
      base *= 1.25;
      base = Math.max(base, 0.25);  // nudge to keep filling until LARDER_TARGET
    }
    if (stockTheLarder) base = Math.max(base, 0.35);
    return Math.min(1.0, base);
  },
  execute: ({ goblin, grid, foodStockpiles }) => {
    const target = nearestStockpile(goblin, foodStockpiles, s => s.food < s.maxFood);
    if (!target) return;
    if (goblin.x === target.x && goblin.y === target.y) {
      const amount = goblin.inventory.food - DEPOSIT_KEEP_FOOD;
      const stored = Math.min(amount, target.maxFood - target.food);
      if (stored > 0) {
        target.food += stored;
        goblin.inventory.food -= stored;
        goblin.task = `deposited ${stored.toFixed(0)} → stockpile`;
      } else {
        goblin.task = 'at stockpile';
      }
    } else {
      moveTo(goblin, target, grid);
      goblin.task = '→ home (deposit)';
    }
  },
};

// --- withdrawFood: run to stockpile when hungry and low on food ---
export const withdrawFood: Action = {
  name: 'withdrawFood',
  tags: ['withdraw'],
  eligible: ({ goblin, foodStockpiles, mealStockpiles }) => {
    if (goblin.inventory.food >= 4 || goblin.inventory.meals >= 4) return false; // already have enough
    const hasMeals = mealStockpiles?.some(m => m.meals > 0) ?? false;
    const hasFood = nearestStockpile(goblin, foodStockpiles, s => s.food > 0) !== null;
    return hasMeals || hasFood;
  },
  score: ({ goblin, foodStockpiles, mealStockpiles, resourceBalance }) => {
    const onFoodStockpile = foodStockpiles?.some(s => s.x === goblin.x && s.y === goblin.y) ?? false;
    const onMealStockpile = mealStockpiles?.some(m => m.x === goblin.x && m.y === goblin.y) ?? false;
    const onStockpile = onFoodStockpile || onMealStockpile;
    const { foodPriority = 0, consumablesPressure = 0.5 } = resourceBalance ?? {};
    const colonyFoodBlend = 0.5 + 0.5 * consumablesPressure;
    let score = sigmoid(goblin.hunger, 35) * 0.9 * (onStockpile ? 2.5 : 1.0) * (1 + foodPriority * 0.4) * colonyFoodBlend;
    const noFood = goblin.inventory.food === 0 && goblin.inventory.meals === 0;
    if (noFood && goblin.hunger > 65) score = Math.min(1.0, score * 1.3);
    return score;
  },
  execute: ({ goblin, grid, foodStockpiles, mealStockpiles }) => {
    if (mealStockpiles && goblin.inventory.meals < 4) {
      const nearestMeal = nearestStockpile(goblin, mealStockpiles, m => m.meals > 0);
      if (nearestMeal) {
        if (goblin.x === nearestMeal.x && goblin.y === nearestMeal.y) {
          const amount = Math.min(4, nearestMeal.meals);
          nearestMeal.meals -= amount;
          goblin.inventory.meals += Math.min(amount, MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory));
          goblin.task = `withdrew ${amount.toFixed(0)} meals`;
          return;
        }
        moveTo(goblin, nearestMeal, grid);
        goblin.task = `→ kitchen (${nearestMeal.meals.toFixed(0)} meals)`;
        return;
      }
    }

    const target = nearestStockpile(goblin, foodStockpiles, s => s.food > 0);
    if (!target) return;
    if (goblin.x === target.x && goblin.y === target.y) {
      const amount = Math.min(4, target.food);
      target.food -= amount;
      goblin.inventory.food += Math.min(amount, MAX_INVENTORY_CAPACITY - totalLoad(goblin.inventory));
      goblin.task = `withdrew ${amount.toFixed(0)} food`;
    } else {
      moveTo(goblin, target, grid);
      goblin.task = `→ stockpile (${target.food.toFixed(0)} food)`;
    }
  },
};
