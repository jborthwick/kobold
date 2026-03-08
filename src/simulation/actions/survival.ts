import { sigmoid } from '../utilityAI';
import { getWarmth } from '../diffusion';
import { traitMod, FORAGEABLE_TILES } from '../agents';
import { accelerateHealing } from '../wounds';
import { moveTo, shouldLog, traitText } from './helpers';
import { addThought } from '../mood';
import type { Action } from './types';

// --- commandMove: player override (always wins) ---
export const commandMove: Action = {
  name: 'commandMove',
  eligible: ({ goblin }) => goblin.commandTarget !== null,
  score: ({ goblin, adventurers }) => {
    // Drop to 0.8 during extreme starvation or active raid — survival instincts can override
    const raid = adventurers && adventurers.length > 0;
    const starving = goblin.hunger >= 95 && goblin.inventory.food === 0 && goblin.inventory.meals === 0;
    return (raid || starving) ? 0.8 : 1.0;
  },
  execute: ({ goblin, grid, onLog }) => {
    const { x: tx, y: ty } = goblin.commandTarget!;
    if (goblin.x === tx && goblin.y === ty) {
      onLog?.(`arrived at (${tx},${ty})`, 'info');
      goblin.commandTarget = null;
      goblin.task = 'arrived';
    } else {
      moveTo(goblin, goblin.commandTarget!, grid);
      goblin.task = `→ (${tx},${ty})`;
    }
  },
};

// --- eat: consume food from inventory, or graze from tile underfoot ---
export const eat: Action = {
  name: 'eat',
  intentMatch: 'eat',
  eligible: ({ goblin, grid }) => {
    if (goblin.inventory.food > 0 || goblin.inventory.meals > 0) return true;
    // Graze: standing on a forageable tile with food
    const tile = grid[goblin.y]?.[goblin.x];
    return !!tile && FORAGEABLE_TILES.has(tile.type) && tile.foodValue >= 1;
  },
  score: ({ goblin }) => {
    const mid = traitMod(goblin, 'eatThreshold', 50); // was 70
    const score = sigmoid(goblin.hunger, mid);
    // Survival priority boost: if starving, jump to the front of the queue
    return goblin.hunger > 80 ? Math.min(1.0, score * 1.5) : score;
  },
  execute: ({ goblin, grid, currentTick, onLog }) => {
    const wasDesperatelyHungry = goblin.hunger > 80;

    if (goblin.inventory.meals > 0) {
      // Eat a meal
      goblin.inventory.meals -= 1;
      goblin.hunger = Math.max(0, goblin.hunger - 50);
      addThought(goblin, 'ate_tasty_meal', currentTick);
      goblin.task = 'eating a meal';
    } else if (goblin.inventory.food > 0) {
      // Eat from inventory (normal path)
      const bite = Math.min(goblin.inventory.food, 3);
      goblin.inventory.food -= bite;
      goblin.hunger = Math.max(0, goblin.hunger - bite * 20);
      addThought(goblin, 'ate_raw_food', currentTick);
      goblin.task = 'eating';
    } else {
      // Graze directly from the tile underfoot
      const tile = grid[goblin.y]?.[goblin.x];
      if (!tile || tile.foodValue < 1) return;
      const bite = Math.min(tile.foodValue, 2);
      tile.foodValue -= bite;
      goblin.hunger = Math.max(0, goblin.hunger - bite * 20);
      addThought(goblin, 'ate_raw_food', currentTick);
      goblin.task = 'grazing';
    }

    if (wasDesperatelyHungry && shouldLog(goblin, 'eat', currentTick, 200)) {
      onLog?.(`🍖 ${traitText(goblin, 'eat')} — was starving`, 'warn');
    }
  },
};

// --- rest: stay still, recover fatigue; warmth tiers bonus ---
export const rest: Action = {
  name: 'rest',
  intentMatch: 'rest',
  eligible: ({ goblin }) => goblin.hunger < 95,
  score: ({ goblin }) => {
    // Lower midpoint (50 instead of 60) makes resting more attractive earlier
    const base = sigmoid(goblin.fatigue, 50);
    // Momentum: once resting, stay committed until fatigue < 30 (hysteresis)
    const momentum = (goblin.task.includes('resting') && goblin.fatigue > 30) ? 0.15 : 0;
    return Math.min(1.0, base + momentum);
  },
  execute: ({ goblin, warmthField, currentTick }) => {
    const warmth = warmthField ? getWarmth(warmthField, goblin.x, goblin.y) : 0;
    if (warmth >= 40) {
      // Sheltered by hearth — best recovery
      goblin.fatigue = Math.max(0, goblin.fatigue - 2.5);
      accelerateHealing(goblin, 3);
      addThought(goblin, 'rested_by_hearth', currentTick);
      goblin.task = goblin.wound ? `resting by the hearth (healing ${goblin.wound.type})` : 'resting by the hearth';
    } else if (warmth >= 20) {
      // Mild warmth — small bonus
      goblin.fatigue = Math.max(0, goblin.fatigue - 2.0);
      accelerateHealing(goblin, 2);
      addThought(goblin, 'rested_near_warmth', currentTick);
      goblin.task = goblin.wound ? `resting near warmth (healing ${goblin.wound.type})` : 'resting near warmth';
    } else {
      // Exposed — baseline
      goblin.fatigue = Math.max(0, goblin.fatigue - 1.5);
      accelerateHealing(goblin, 2);
      addThought(goblin, 'slept_on_ground', currentTick);
      goblin.task = goblin.wound ? `resting (healing ${goblin.wound.type})` : 'resting';
    }
  },
};
