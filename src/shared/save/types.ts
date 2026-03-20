import type {
  Tile,
  Goblin,
  Adventurer,
  Chicken,
  ColonyGoal,
  FoodStockpile,
  MealStockpile,
  OreStockpile,
  WoodStockpile,
  PlankStockpile,
  BarStockpile,
  OverlayMode,
  LogEntry,
  Chapter,
  Room,
} from '../types';
import type { Weather } from '../../simulation/weather';
import type { WorkerTargets } from '../../simulation/workerTargets';

export interface SaveData {
  /**
   * Schema version within the current SAVE_COMPAT_VERSION window.
   * Bump this when you add migrations you still want to support inside the window.
   */
  version: 2;
  tick: number;
  grid: Tile[][];
  goblins: Goblin[];
  adventurers: Adventurer[];
  chickens?: Chicken[];
  colonyGoal: ColonyGoal;
  foodStockpiles: FoodStockpile[];
  oreStockpiles: OreStockpile[];
  woodStockpiles: WoodStockpile[];
  adventurerKillCount: number;
  spawnZone: { x: number; y: number; w: number; h: number };
  pendingSuccessions: { deadGoblinId: string; spawnAtTick: number }[];
  commandTile: { x: number; y: number } | null;
  speed: number;
  overlayMode: OverlayMode;
  logHistory: LogEntry[];
  nextWorldEventTick: number;
  /** Weather state — optional for backward compat with old saves. */
  weather?: Weather;
  /** World seed — optional for backward compat with old saves. */
  worldSeed?: string;
  /** Chronicle chapters — optional for backward compat with old saves. */
  chapters?: Chapter[];
  /** Tick at which the current goal started — optional for backward compat. */
  goalStartTick?: number;
  /** Player-placed rooms — optional for backward compat. */
  rooms?: Room[];
  /** Meal stockpiles inside kitchens — optional for backward compat. */
  mealStockpiles?: MealStockpile[];
  /** Plank stockpiles in lumber huts. */
  plankStockpiles?: PlankStockpile[];
  /** Bar stockpiles in blacksmiths. */
  barStockpiles?: BarStockpile[];
  /** Cumulative meals cooked this colony — optional for backward compat. */
  mealsCooked?: number;
  /** Target worker headcounts per work category — optional for backward compat. */
  workerTargets?: WorkerTargets;
}

