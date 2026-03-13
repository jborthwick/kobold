/**
 * cook. Requires a kitchen room; consumes food + wood to produce meals into the kitchen's
 * meal stockpile. Meals improve morale (ate_tasty_meal thought) and feed withdrawFood.
 */
import { TileType } from '../../shared/types';
import type { MealStockpile } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { inverseSigmoid, ramp } from '../utilityAI';
import { moveToward, addWorkFatigue, nearestFoodStockpile, nearestWoodStockpile } from './helpers';
import { addThought } from '../mood';
import type { Action, ActionContext } from './types';
import { bus } from '../../shared/events';

const MEALS_PER_BATCH = 5;
const FOOD_COST = 5;
const WOOD_COST = 1;
const COOKING_TICKS_REQUIRED = 50;
const FIRE_CHANCE_PER_TICK = 0.001; // 0.1% chance per tick to start a fire (~5% per batch)
const MAX_MEALS_STORED = 50;

/** Find or auto-create a MealStockpile at the top-left corner of the given kitchen. */
function getOrCreateMealStockpile(ctx: ActionContext): MealStockpile | null {
  const kitchen = ctx.rooms?.find(r => r.type === 'kitchen');
  if (!kitchen || !ctx.mealStockpiles) return null;
  // Place in the top-left corner tile (1 in from edge) — center is reserved for the hearth
  const px = kitchen.x + 1;
  const py = kitchen.y + 1;
  let pile = ctx.mealStockpiles.find(m => m.x === px && m.y === py);
  if (!pile) {
    pile = { x: px, y: py, meals: 0, maxMeals: MAX_MEALS_STORED };
    ctx.mealStockpiles.push(pile);
  }
  return pile;
}

export const cook: Action = {
    name: 'cook',
    tags: ['work'],
    eligible: ({ rooms, foodStockpiles, woodStockpiles, goblin, grid, mealStockpiles }) => {
        if (!rooms || rooms.length === 0) return false;

        // Must have a kitchen
        const hasKitchen = rooms.some(r => r.type === 'kitchen');
        if (!hasKitchen) return false;

        // Don't cook if meals are full
        const totalMeals = mealStockpiles?.reduce((s, m) => s + m.meals, 0) ?? 0;
        if (totalMeals >= MAX_MEALS_STORED) return false;

        // Must have resources OR be already cooking
        const hasFood = foodStockpiles?.some(s => s.food >= FOOD_COST);
        const hasWood = woodStockpiles?.some(s => s.wood >= WOOD_COST);

        // We also require at least one Hearth tile in or adjacent to the kitchen
        let kitchenHasHearth = false;
        for (const r of rooms) {
            if (r.type !== 'kitchen') continue;
            // check the room and a 1-tile buffer
            for (let y = Math.max(0, r.y - 1); y <= Math.min(GRID_SIZE - 1, r.y + r.h); y++) {
                for (let x = Math.max(0, r.x - 1); x <= Math.min(GRID_SIZE - 1, r.x + r.w); x++) {
                    if (grid[y] && grid[y][x] && grid[y][x].type === TileType.Hearth) {
                        kitchenHasHearth = true;
                        break;
                    }
                }
                if (kitchenHasHearth) break;
            }
            if (kitchenHasHearth) break;
        }

        if (!kitchenHasHearth) return false;

        // Can cook if we have both inputs, or if already cooking
        return (hasFood && hasWood) || (goblin.cookingProgress !== undefined && goblin.cookingProgress > 0);
    },

    score: ({ goblin, foodStockpiles, mealStockpiles, woodStockpiles, resourceBalance }) => {
        // If already cooking, strong momentum to finish
        if (goblin.cookingProgress !== undefined && goblin.cookingProgress > 0) {
            return 0.95;
        }

        // Score based on raw food surplus and lack of meals
        const totalFood = foodStockpiles?.reduce((s, p) => s + p.food, 0) ?? 0;
        const totalMeals = mealStockpiles?.reduce((s, p) => s + p.meals, 0) ?? 0;
        const totalWood = woodStockpiles?.reduce((s, p) => s + p.wood, 0) ?? 0;

        // Lower threshold: allow cooking with minimal resources so it can bootstrap food production
        if (totalFood < 1) return 0;
        if (totalWood < 1) return 0;

        // Base score peaks when there's lots of food and no meals
        const foodAbundance = ramp(totalFood, 3, 40);
        const mealScarcity = inverseSigmoid(totalMeals, 20);
        const woodAbundance = ramp(totalWood, 2, 15); // Factor in wood availability

        // Increased multiplier from 0.80 → 1.1, lowered hunger midpoint from 50 → 35
        const base = foodAbundance * mealScarcity * woodAbundance * 1.1 * inverseSigmoid(goblin.hunger, 35);

        // Apply resource balance modifier (boost when materials outweigh consumables)
        const { foodPriority } = resourceBalance ?? { foodPriority: 0 };

        // Centralized momentum applied in utilityAI — no per-action bonus needed
        return Math.min(1.0, base * (1 + foodPriority * 0.6));
    },

    execute: (ctx) => {
        const { goblin, grid, rooms, foodStockpiles, woodStockpiles, onLog, currentTick } = ctx;
        const kitchen = rooms!.find(r => r.type === 'kitchen');
        if (!kitchen) return;

        // 1. Walk to the kitchen
        if (goblin.x < kitchen.x || goblin.x >= kitchen.x + kitchen.w || goblin.y < kitchen.y || goblin.y >= kitchen.y + kitchen.h) {
            // Find a walkable spot inside the kitchen
            const targetX = kitchen.x + Math.floor(kitchen.w / 2);
            const targetY = kitchen.y + Math.floor(kitchen.h / 2);
            moveToward(goblin, { x: targetX, y: targetY }, grid, currentTick, 20);
            goblin.task = '→ kitchen';
            return;
        }

        // 2. Start cooking if not started
        if (goblin.cookingProgress === undefined) {
            const foodSource = nearestFoodStockpile(goblin, foodStockpiles, s => s.food >= FOOD_COST);
            const woodSource = nearestWoodStockpile(goblin, woodStockpiles, s => s.wood >= WOOD_COST);

            if (!foodSource || !woodSource) {
                goblin.task = 'kitchen is missing ingredients';
                return; // Wait for ingredients
            }

            foodSource.food -= FOOD_COST;
            woodSource.wood -= WOOD_COST;
            goblin.cookingProgress = 1;
            goblin.task = `cooking (starting...)`;
            return;
        }

        // 3. Process cooking
        goblin.cookingProgress += 1;
        goblin.cookingLastActiveTick = currentTick;

        // Cooking accident chance
        if (Math.random() < FIRE_CHANCE_PER_TICK) {
            grid[goblin.y][goblin.x].type = TileType.Fire;
            onLog?.(`🔥 ${goblin.name} started a grease fire!`, 'warn');
            // Fire mechanic will naturally interrupt them next utility sweep
        }

        const pct = Math.floor((goblin.cookingProgress / COOKING_TICKS_REQUIRED) * 100);
        goblin.task = `cooking (${pct}%)`;

        // 4. Finish cooking
        if (goblin.cookingProgress >= COOKING_TICKS_REQUIRED) {
            const mealPile = getOrCreateMealStockpile(ctx);
            if (mealPile) {
                const actualMeals = Math.min(mealPile.maxMeals - mealPile.meals, MEALS_PER_BATCH);
                mealPile.meals += actualMeals;
                bus.emit('mealsCooked', actualMeals);
                addThought(goblin, 'crafted_meal', ctx.currentTick);
                onLog?.(`🍲 ${goblin.name} cooked ${actualMeals} meals!`, 'info');
            }
            goblin.cookingProgress = undefined;
            addWorkFatigue(goblin);
        }
    }
};
