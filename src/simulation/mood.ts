import type { Goblin } from '../shared/types';

export interface ThoughtDef {
  id: string;
  label: string;
  delta: number;
  duration: number; // Ticks until expiry
}

export interface MemoryDef {
  id: string;
  label: string | ((stage: number) => string);
  deltas: number[]; // e.g. [-5, -10, -15] for stages 0, 1, 2
  decayDuration: number; // Ticks before dropping a stage
}

// Map of standard thoughts
export const THOUGHT_DEFS: Record<string, ThoughtDef> = {
  'ate_raw_food': { id: 'ate_raw_food', label: 'Ate raw food', delta: -5, duration: 250 },
  'ate_tasty_meal': { id: 'ate_tasty_meal', label: 'Ate tasty meal', delta: 8, duration: 400 },
  'slept_on_ground': { id: 'slept_on_ground', label: 'Slept on ground', delta: -3, duration: 200 },
  'rested_by_hearth': { id: 'rested_by_hearth', label: 'Rested by hearth', delta: 6, duration: 250 },
  'rested_near_warmth': { id: 'rested_near_warmth', label: 'Rested near warmth', delta: 3, duration: 200 },
  'singed_by_fire': { id: 'singed_by_fire', label: 'Singed by fire', delta: -8, duration: 300 },
  'doused_fire': { id: 'doused_fire', label: 'Doused a fire', delta: 4, duration: 250 },
  'crafted_meal': { id: 'crafted_meal', label: 'Cooked a meal', delta: 4, duration: 200 },
  'built_wall': { id: 'built_wall', label: 'Built a wall', delta: 3, duration: 200 },
  'mined_ore': { id: 'mined_ore', label: 'Mined shiny ore', delta: 2, duration: 150 },
};

// Map of standard memories
export const MEMORY_DEFS: Record<string, MemoryDef> = {
  'chatted_with_ally': {
    id: 'chatted_with_ally',
    label: (stage) => `Had a nice chat x${stage + 1}`,
    deltas: [3, 5, 8, 10], // stacks up to 4 times
    decayDuration: 300,
  },
  'starving': {
    id: 'starving',
    label: (stage) => `Starving x${stage + 1}`,
    deltas: [-5, -10, -15, -20, -25], 
    decayDuration: 150,
  },
  'socially_isolated': {
    id: 'socially_isolated',
    label: (stage) => `Lonely x${stage + 1}`,
    deltas: [-3, -6, -10, -15],
    decayDuration: 250,
  },
  'exhausted_work': {
    id: 'exhausted_work',
    label: (stage) => `Exhausted from work x${stage + 1}`,
    deltas: [-4, -8, -12],
    decayDuration: 200,
  },
  'freezing': {
    id: 'freezing',
    label: (stage) => `Freezing x${stage + 1}`,
    deltas: [-5, -10, -15],
    decayDuration: 150,
  },
  'attacked_by_enemy': {
    id: 'attacked_by_enemy',
    label: (stage) => `Under attack x${stage + 1}`,
    deltas: [-8, -15, -22, -30],
    decayDuration: 350,
  }
};

export function addThought(goblin: Goblin, thoughtId: string, currentTick: number) {
  const def = THOUGHT_DEFS[thoughtId];
  if (!def) return;
  const existingIndex = goblin.thoughts.findIndex(t => t.defId === thoughtId);
  if (existingIndex !== -1) {
    goblin.thoughts[existingIndex].expiryTick = currentTick + def.duration;
  } else {
    goblin.thoughts.push({ defId: thoughtId, expiryTick: currentTick + def.duration });
  }
}

export function addMemory(goblin: Goblin, memoryId: string, currentTick: number) {
  const def = MEMORY_DEFS[memoryId];
  if (!def) return;
  const existing = goblin.memories.find(m => m.defId === memoryId);
  if (existing) {
    existing.stage = Math.min(existing.stage + 1, def.deltas.length - 1);
    existing.lastRefreshTick = currentTick;
  } else {
    goblin.memories.push({ defId: memoryId, stage: 0, lastRefreshTick: currentTick });
  }
}
