import { sigmoid } from '../utilityAI';
import { getWarmth } from '../diffusion';
import { traitMod } from '../agents';
import { accelerateHealing } from '../wounds';
import { moveTo, shouldLog, traitText } from './helpers';
import type { Action } from './types';

// --- commandMove: player override (always wins) ---
export const commandMove: Action = {
  name: 'commandMove',
  eligible: ({ goblin }) => goblin.commandTarget !== null,
  score: ({ goblin, adventurers }) => {
    // Drop to 0.8 during extreme starvation or active raid — survival instincts can override
    const raid = adventurers && adventurers.length > 0;
    const starving = goblin.hunger >= 95 && goblin.inventory.food === 0;
    return (raid || starving) ? 0.8 : 1.0;
  },
  execute: ({ goblin, grid, onLog }) => {
    const { x: tx, y: ty } = goblin.commandTarget!;
    if (goblin.x === tx && goblin.y === ty) {
      onLog?.(`arrived at (${tx},${ty})`, 'info');
      goblin.commandTarget = null;
      goblin.task          = 'arrived';
    } else {
      moveTo(goblin, goblin.commandTarget!, grid);
      goblin.task = `→ (${tx},${ty})`;
    }
  },
};

// --- eat: consume food from inventory ---
export const eat: Action = {
  name: 'eat',
  intentMatch: 'eat',
  eligible: ({ goblin }) => goblin.inventory.food > 0,
  score: ({ goblin }) => {
    const mid = traitMod(goblin, 'eatThreshold', 70);
    return sigmoid(goblin.hunger, mid);
  },
  execute: ({ goblin, currentTick, onLog }) => {
    const wasDesperatelyHungry = goblin.hunger > 80;
    const bite = Math.min(goblin.inventory.food, 3);
    goblin.inventory.food -= bite;
    goblin.hunger = Math.max(0, goblin.hunger - bite * 20);
    goblin.task = 'eating';
    // Only log desperate eating — routine meals are too noisy
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
  execute: ({ goblin, warmthField }) => {
    const warmth = warmthField ? getWarmth(warmthField, goblin.x, goblin.y) : 0;
    if (warmth >= 40) {
      // Sheltered by hearth — best recovery
      goblin.fatigue = Math.max(0, goblin.fatigue - 2.5);
      accelerateHealing(goblin, 3);
      goblin.morale  = Math.min(100, goblin.morale + 0.3);
      goblin.task    = goblin.wound ? `resting by the hearth (healing ${goblin.wound.type})` : 'resting by the hearth';
    } else if (warmth >= 20) {
      // Mild warmth — small bonus
      goblin.fatigue = Math.max(0, goblin.fatigue - 2.0);
      accelerateHealing(goblin, 2);
      goblin.morale  = Math.min(100, goblin.morale + 0.1);
      goblin.task    = goblin.wound ? `resting near warmth (healing ${goblin.wound.type})` : 'resting near warmth';
    } else {
      // Exposed — baseline
      goblin.fatigue = Math.max(0, goblin.fatigue - 1.5);
      accelerateHealing(goblin, 2);
      goblin.task    = goblin.wound ? `resting (healing ${goblin.wound.type})` : 'resting';
    }
  },
};
