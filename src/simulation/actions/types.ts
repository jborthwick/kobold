import type { Goblin, Tile, Adventurer, FoodStockpile, MealStockpile, OreStockpile, WoodStockpile, ColonyGoal, WeatherType, Room } from '../../shared/types';

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

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
  colonyGoal?:     ColonyGoal;
  warmthField?:    Float32Array;  // diffusion field: warmth 0–100 per tile
  dangerField?:    Float32Array;  // diffusion field: danger 0–100 per tile
  weatherType?:    WeatherType;
  rooms?:          Room[];
}

/** Tags for trait-based action score biasing. Traits multiply scores by tag. */
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

export interface Action {
  name:         string;
  tags:         ActionTag[];
  eligible:     (ctx: ActionContext) => boolean;
  score:        (ctx: ActionContext) => number;
  execute:      (ctx: ActionContext) => void;
}
