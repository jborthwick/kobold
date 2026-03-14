/**
 * Action contract for utility-AI. Each tick, utilityAI scores all eligible actions and runs the
 * highest-scoring one's execute(); actions mutate ctx.goblin and may call onLog. Don't replace
 * grid/stockpile array references.
 *
 * Adding a new action: (1) Define Action (name, tags, eligible, score, execute) in actions/*.ts,
 * use helpers.ts for movement/fatigue/stockpiles. (2) Add to ALL_ACTIONS in actions/index.ts —
 * order doesn't set priority, scoring does. (3) Add display label in utilityAI.ts ACTION_DISPLAY_NAMES.
 */

import type { Goblin, Tile, Adventurer, FoodStockpile, MealStockpile, OreStockpile, WoodStockpile, PlankStockpile, BarStockpile, ColonyGoal, WeatherType, Room } from '../../shared/types';

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

/** Per-tick context for each action. Built by utilityAI; optional fields may be undefined. */
export interface ActionContext {
  goblin:           Goblin;
  grid:            Tile[][];
  currentTick:     number;
  goblins?:        Goblin[];
  onLog?:          LogFn;
  foodStockpiles?: FoodStockpile[];
  mealStockpiles?: MealStockpile[];
  adventurers?:        Adventurer[];
  oreStockpiles?:  OreStockpile[];
  woodStockpiles?: WoodStockpile[];
  plankStockpiles?: PlankStockpile[];
  barStockpiles?: BarStockpile[];
  colonyGoal?:     ColonyGoal;
  dangerField?:    Float32Array;  // diffusion field: danger 0–100 per tile
  weatherType?:    WeatherType;
  rooms?:          Room[];
  /** Per-tick room context flags, computed once in utilityAI. */
  roomBonuses?: {
    hasStorage: boolean;
    hasLumberHut: boolean;
    hasBlacksmith: boolean;
    hasKitchen: boolean;
  };
  /** Cached per tick: balance (food/material priority) + tier pressures (consumables > materials > upgrades). */
  resourceBalance?: {
    foodPriority: number;
    materialPriority: number;
    consumablesPressure: number;
    materialsPressure: number;
    upgradesPressure: number;
  };
}

/** Tags for trait-based score biasing (traitActionBias.ts). */
export type ActionTag =
  | 'player'
  | 'eat'
  | 'rest'
  | 'combat'
  | 'safety'
  | 'work'
  | 'social'
  | 'explore'
  | 'comfort'
  | 'fire'
  | 'share'
  | 'withdraw';

/** One action: eligible = hard gate, score = 0–1, execute mutates ctx.goblin. */
export interface Action {
  name:         string;
  tags:         ActionTag[];
  eligible:     (ctx: ActionContext) => boolean;
  score:        (ctx: ActionContext) => number;
  execute:      (ctx: ActionContext) => void;
}
