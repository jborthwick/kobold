/**
 * cook. Requires a kitchen room; consumes food + wood to produce meals into the kitchen's
 * meal stockpile. Meals improve morale (ate_tasty_meal thought) and feed withdrawFood.
 *
 * Unified consumables model: colony-wide food safety is consumablesPressure (food+meals).
 * Cooking is gated by consumablesPressure (only cook when colony has some buffer) and
 * mealsFraction (cook when meals < MEALS_FRACTION_COOK_BELOW of total consumables); no
 * separate per-goblin meal cap.
 */
import { TileType, isHearthLit } from '../../shared/types';
import type { MealStockpile } from '../../shared/types';
import { GRID_SIZE } from '../../shared/constants';
import { inverseSigmoid, ramp } from '../utilityAI';
import { moveToward, addWorkFatigue, nearestStockpile } from './helpers';
import { addThought } from '../mood';
import type { Action, ActionContext } from './types';
import { bus } from '../../shared/events';
import { COOK_MIN_CONSUMABLES_PRESSURE, MEALS_FRACTION_COOK_BELOW } from '../resourceTuning';

const MEALS_PER_BATCH = 5;
const FOOD_COST = 5;
const WOOD_COST = 1;
const COOKING_TICKS_REQUIRED = 50;
const FIRE_CHANCE_PER_TICK = 0.001; // 0.1% chance per tick to start a fire (~5% per batch)

/** Find or auto-create a MealStockpile at the top-left corner of the given kitchen. */
function getOrCreateMealStockpile(ctx: ActionContext): MealStockpile | null {
  const kitchen = ctx.rooms?.find(r => r.type === 'kitchen');
  if (!kitchen || !ctx.mealStockpiles) return null;
  // Place in the top-left corner tile (1 in from edge) — center is reserved for the hearth
  const px = kitchen.x + 1;
  const py = kitchen.y + 1;
  let pile = ctx.mealStockpiles.find(m => m.x === px && m.y === py);
  if (!pile) {
    // maxMeals is a capacity hint for the stockpile UI; the real cap is enforced
    // by the cooking logic using a per-goblin effectiveMealsCap.
    pile = { x: px, y: py, meals: 0, maxMeals: Number.MAX_SAFE_INTEGER };
    ctx.mealStockpiles.push(pile);
  }
  return pile;
}

export const cook: Action = {
    name: 'cook',
    tags: ['work', 'cook'],
    eligible: ({ rooms, foodStockpiles, woodStockpiles, goblin, grid, mealStockpiles, resourceBalance }) => {
        if (!rooms || rooms.length === 0) return false;

        // Must have a kitchen
        const hasKitchen = rooms.some(r => r.type === 'kitchen');
        if (!hasKitchen) return false;

        // Unified consumables: only cook when colony has enough buffer (pressure above min) and meals are below target fraction
        const totalFood = foodStockpiles?.reduce((s, p) => s + p.food, 0) ?? 0;
        const totalMeals = mealStockpiles?.reduce((s, m) => s + m.meals, 0) ?? 0;
        const consumablesTotal = totalFood + totalMeals;
        const mealsFraction = consumablesTotal > 0 ? totalMeals / consumablesTotal : 0;
        const consumablesPressure = resourceBalance?.consumablesPressure ?? 0;
        if (consumablesPressure < COOK_MIN_CONSUMABLES_PRESSURE) return false;
        if (mealsFraction >= MEALS_FRACTION_COOK_BELOW) return false;

        // Must have resources OR be already cooking
        const hasFood = foodStockpiles?.some(s => s.food >= FOOD_COST);
        const hasWood = woodStockpiles?.some(s => s.wood >= WOOD_COST);

        // We also require at least one lit Hearth in or adjacent to the kitchen
        let kitchenHasHearth = false;
        for (const r of rooms) {
            if (r.type !== 'kitchen') continue;
            // check the room and a 1-tile buffer
            for (let y = Math.max(0, r.y - 1); y <= Math.min(GRID_SIZE - 1, r.y + r.h); y++) {
                for (let x = Math.max(0, r.x - 1); x <= Math.min(GRID_SIZE - 1, r.x + r.w); x++) {
                    if (grid[y]?.[x] && isHearthLit(grid[y][x])) {
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

    score: ({ goblin, foodStockpiles, woodStockpiles, resourceBalance, mealStockpiles }) => {
        // If already cooking, strong momentum to finish
        if (goblin.cookingProgress !== undefined && goblin.cookingProgress > 0) {
            return 0.95;
        }

        const totalFood = foodStockpiles?.reduce((s, p) => s + p.food, 0) ?? 0;
        const totalWood = woodStockpiles?.reduce((s, p) => s + p.wood, 0) ?? 0;
        if (totalFood < 1) return 0;
        if (totalWood < 1) return 0;

        // Input gates only; scarcity from central consumablesPressure; prefer cooking when meals fraction is low
        const foodInput = Math.min(1, ramp(totalFood, 3, 40));
        const woodInput = Math.min(1, ramp(totalWood, 2, 15));
        const hungerFactor = inverseSigmoid(goblin.hunger, 50);
        const { consumablesPressure = 0.5, foodPriority = 0 } = resourceBalance ?? {};
        const totalMeals = mealStockpiles?.reduce((s, m) => s + m.meals, 0) ?? 0;
        const consumablesTotal = totalFood + totalMeals;
        const mealsFraction = consumablesTotal > 0 ? totalMeals / consumablesTotal : 0;
        // Boost score when meals are below target fraction (e.g. below 0.5)
        const mealsRatioBoost = mealsFraction < MEALS_FRACTION_COOK_BELOW ? 1.3 : 1.0;
        const base = foodInput * woodInput * hungerFactor * 1.1 * consumablesPressure * (1 + foodPriority * 0.6) * mealsRatioBoost;
        return Math.min(1.0, base);
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
            const foodSource = nearestStockpile(goblin, foodStockpiles, s => s.food >= FOOD_COST);
            const woodSource = nearestStockpile(goblin, woodStockpiles, s => s.wood >= WOOD_COST);

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
