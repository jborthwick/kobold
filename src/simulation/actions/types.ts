import type { Goblin, Tile, LLMIntent, Adventurer, FoodStockpile, OreStockpile, WoodStockpile, ColonyGoal, WeatherType } from '../../shared/types';

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

export interface ActionContext {
  goblin:           Goblin;
  grid:            Tile[][];
  currentTick:     number;
  goblins?:        Goblin[];
  onLog?:          LogFn;
  foodStockpiles?: FoodStockpile[];
  adventurers?:        Adventurer[];
  oreStockpiles?:  OreStockpile[];
  woodStockpiles?: WoodStockpile[];
  colonyGoal?:     ColonyGoal;
  warmthField?:    Float32Array;  // diffusion field: warmth 0–100 per tile
  dangerField?:    Float32Array;  // diffusion field: danger 0–100 per tile
  weatherType?:    WeatherType;
}

export interface Action {
  name:         string;
  intentMatch?: LLMIntent;  // which LLM intent boosts this action
  eligible:     (ctx: ActionContext) => boolean;
  score:        (ctx: ActionContext) => number;
  execute:      (ctx: ActionContext) => void;
}
