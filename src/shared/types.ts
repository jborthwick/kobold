/**
 * Single source of truth for game and simulation state: tiles, goblins, stockpiles, rooms, UI.
 * Don't duplicate these shapes elsewhere.
 *
 * Adding new persisted fields: add to the interface, then add migration in save.ts loadGame()
 * (e.g. if (d.newField === undefined) d.newField = default). See existing migrations as template.
 */

export enum TileType {
  Dirt = 'dirt',
  Grass = 'grass',
  Stone = 'stone',
  Water = 'water',
  Forest = 'forest',
  Farmland = 'farmland',
  Ore = 'ore',
  Mushroom = 'mushroom',
  Wall = 'wall',       // legacy; new builds use WoodWall/StoneWall
  WoodWall = 'woodwall',  // built from planks
  StoneWall = 'stonewall', // built from bars
  Hearth = 'hearth',  // goblin-built warmth source; walkable
  TreeStump = 'treestump',
  Fire = 'fire',
  Pool = 'pool',     // temporary rain puddle in lowlands; evaporates after rain
}

export interface Tile {
  type: TileType;
  foodValue: number;      // current food on tile
  materialValue: number;  // current material on tile
  maxFood: number;        // growback ceiling
  maxMaterial: number;
  growbackRate: number;   // food units restored per tick (0 = doesn't regrow)
  fireTick?: number;      // tick when fire started; undefined means tile is not burning
  poolTick?: number;      // tick when rain pool formed; undefined means not pooled
  priorType?: TileType;   // tile type before pooling (restored on evaporation)
  trafficScore?: number;  // 0–100; goblin foot-traffic accumulation (diffusion field, not persisted)
  hearthFuel?: number;    // 0 = extinguished, >0 = lit; decay 1/tick (hearths only)
}

/** True for any wall tile (Wall legacy, WoodWall, StoneWall). Use for blocking, diffusion, rendering. */
export function isWallType(type: TileType): boolean {
  return type === TileType.Wall || type === TileType.WoodWall || type === TileType.StoneWall;
}

export function isWall(tile: Tile): boolean {
  return isWallType(tile.type);
}

/** True if tile is a Hearth with fuel (lit). After save migration, lit = hearthFuel > 0. */
export function isHearthLit(tile: Tile): boolean {
  return tile.type === TileType.Hearth && (tile.hearthFuel === undefined || tile.hearthFuel > 0);
}

export interface Inventory {
  food: number;
  meals: number;  // cooked from food by cooking action
  ore: number;   // mined by miners; deposited to ore stockpiles
  wood: number;   // chopped by lumberjacks; deposited to wood stockpiles
}

/** Hostile NPC — spawns in raids from map edges. */
export interface Adventurer {
  id: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  targetId: string | null;  // id of the goblin currently being chased
  staggeredUntil?: number;         // tick until which the adventurer cannot move (post-hit stagger)
}

// Permanent personality trait assigned at spawn
export type GoblinTrait = 'lazy' | 'forgetful' | 'helpful' | 'mean' | 'paranoid' | 'brave' | 'greedy' | 'cheerful' | 'curious' | 'stubborn' | 'cowardly' | 'glutton' | 'crafty';

// A tile location a goblin has seen or visited — used for resource routing
export interface ResourceSite {
  x: number;
  y: number;
  value: number;  // tile foodValue or materialValue when last seen
  tick: number;  // currentTick when last seen/updated
}

export interface ActiveThought {
  defId: string;
  expiryTick: number;
}

export interface ActiveMemory {
  defId: string;
  stage: number;
  lastRefreshTick: number;
}

// One entry per significant event or decision; shown in HUD history and copied on succession
export interface MemoryEntry {
  tick: number;
  crisis: string;   // e.g. 'combat', 'arrival', 'inheritance'
  action: string;   // short description of what happened
  reasoning?: string;   // optional (e.g. successor arrival thought)
  outcome?: string;   // optional; copied on inheritance or for future use
}

// ─ Skills system (replacing roles) ─────────────────────────────────────────
export interface SkillSet {
  forage: number;  // XP accumulated
  mine: number;
  chop: number;
  combat: number;
  scout: number;
  cook: number;
  saw: number;
  smith: number;
}

// Injury system — single wound slot, heals over time
export type WoundType = 'bruised' | 'leg' | 'arm' | 'eye';

export interface Wound {
  type: WoundType;
  healTick: number;    // tick at which the wound automatically heals
}

export interface Goblin {
  id: string;
  name: string;
  x: number;  // tile coords
  y: number;
  health: number;
  maxHealth: number;
  hunger: number;      // 0–100, 100 = starving
  metabolism: number;  // hunger added per tick
  vision: number;      // radius in tiles
  inventory: Inventory;
  morale: number;      // 0–100
  alive: boolean;
  task: string;
  commandTarget: { x: number; y: number } | null;  // player-issued move order
  memory: MemoryEntry[];    // rolling history of events/decisions (uncapped)
  thoughts: ActiveThought[]; // rimworld-style timed buffs
  memories: ActiveMemory[];  // rimworld-style staged accumulation
  wanderTarget: { x: number; y: number } | null;  // persistent explore waypoint
  wanderExpiry: number;           // tick at which to repick a new wander waypoint
  moveTarget?: { x: number; y: number } | null;  // committed nav waypoint (cooking, flee, firefighting)
  moveExpiry?: number;                             // tick at which to re-pick a new target
  knownFoodSites: ResourceSite[];   // remembered food patches (cap: 5)
  knownOreSites: ResourceSite[];   // remembered ore veins (cap: 5)
  knownWoodSites: ResourceSite[];   // remembered forest wood sites (cap: 5)
  knownHearthSites: ResourceSite[];   // remembered hearth locations (cap: 5)
  homeTile: { x: number; y: number };  // fort/stockpile center — the colony's home base
  relations: Record<string, number>;  // keyed by goblin.id; 0–100 (50 = neutral)
  trait: GoblinTrait;  // permanent personality trait
  bio: string;      // quirky backstory blurb
  goal: string;      // personal objective
  baseName: string;      // name without roman numeral suffix (e.g. "Bomer")
  generation: number;      // 1 for original goblins, increments for each succession
  adventurerKills: number;      // lifetime count of adventurers slain by this goblin
  causeOfDeath?: string;      // set when goblin dies; shown in HUD + passed to successor
  fatigue: number;      // 0–100; rises with movement/work, decays when resting
  social: number;      // 0–100; rises when isolated from friendly goblins
  lastSocialTick: number;      // tick when goblin last had a friend within proximity
  lastLoggedTicks: Record<string, number>;  // cooldown tracking for event log (key = event type, value = tick)
  carryingWater?: boolean;                 // true when goblin has fetched water and is heading to douse fire
  onFire?: boolean;                 // goblin is currently burning
  onFireTick?: number;                  // tick when they caught fire
  skills: SkillSet;      // XP per skill category (forage, mine, chop, combat, scout)
  wound?: Wound;       // active wound (undefined = healthy); heals at wound.healTick
  warmth?: number;      // warmth field value at goblin's tile (0–100); recomputed each tick, not saved
  cookingProgress?: number;     // ticks spent accumulating progress while cooking
  cookingLastActiveTick?: number;  // tick when cooking action last executed
  sawingProgress?: number;      // ticks spent sawing (wood → planks)
  sawingLastActiveTick?: number;
  smithingProgress?: number;    // ticks spent smithing (ore → bars)
  smithingLastActiveTick?: number;
  lastActionName?: string;  // name of action that won last tick; drives momentum bonus
  lastWorkCategory?: import('../simulation/workerTargets').WorkCategoryId;  // for headcount; set when doing category action
  lastWorkCategoryTick?: number;  // when lastWorkCategory was set; used to expire persistence
  /** Optional role affinity assigned at spawn; small score bonus for actions in this category. */
  preferredWorkCategory?: import('../simulation/workerTargets').WorkCategoryId;
}

export interface LogEntry {
  tick: number;
  goblinId: string;
  goblinName: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export type OverlayMode = 'off' | 'food' | 'material' | 'wood' | 'warmth' | 'danger' | 'traffic';

// Colony-wide shared goal — all goblins contribute; cycles on completion
export type ColonyGoalType = 'build_rooms' | 'cook_meals' | 'survive_ticks' | 'defeat_adventurers';

export interface ColonyGoal {
  type: ColonyGoalType;
  description: string;   // human-readable label shown in UI
  progress: number;   // current progress value
  target: number;   // value at which goal completes
  generation: number;   // how many full cycles completed (scales difficulty)
}

// Communal food stockpile — one per colony, placed at center of spawn zone.
export interface FoodStockpile {
  x: number;  // tile coords
  y: number;
  food: number;  // current stored food
  maxFood: number;  // food storage cap
}

// Meal stockpile — lives inside the kitchen room; filled by cooks.
export interface MealStockpile {
  x: number;
  y: number;
  meals: number;
  maxMeals: number;
}

// Communal ore stockpile — placed near the food stockpile; filled by miners.
// Miners draw from it when building fort walls.
export interface OreStockpile {
  x: number;  // tile coords (distinct from food stockpile)
  y: number;
  ore: number;  // current stored ore
  maxOre: number;  // storage cap
}

// Communal wood stockpile — placed on the other side of the food stockpile; filled by lumberjacks.
export interface WoodStockpile {
  x: number;  // tile coords
  y: number;
  wood: number;  // current stored wood
  maxWood: number;  // storage cap
}

// Plank stockpile — in lumber hut; filled by sawing (wood → planks).
export interface PlankStockpile {
  x: number;
  y: number;
  planks: number;
  maxPlanks: number;
}

// Bar stockpile — in blacksmith; filled by smithing (ore → bars).
export interface BarStockpile {
  x: number;
  y: number;
  bars: number;
  maxBars: number;
}

export interface TileInfo {
  x: number;
  y: number;
  type: TileType;
  foodValue: number;
  maxFood: number;
  materialValue: number;
  maxMaterial: number;
}

export interface MiniMapData {
  /** One cell per tile: type + food fill ratio (0–1). */
  tiles: { type: TileType; foodRatio: number; matRatio: number }[][];
  /** Alive goblin positions and hunger (0–100). */
  goblins: { x: number; y: number; hunger: number }[];
  /** Adventurer positions. */
  adventurers: { x: number; y: number }[];
  /** Camera viewport in tile-space. */
  viewport: { x: number; y: number; w: number; h: number };
}

/** Weather state — drives cascading resource scarcity/abundance. */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type WeatherType = 'clear' | 'rain' | 'drought' | 'cold' | 'storm';

/** One narrator chapter — generated when a colony goal completes. */
export interface Chapter {
  chapterNumber: number;                // 1-indexed
  goalType: ColonyGoal['type'];
  goalGeneration: number;
  text: string;                // 2-4 sentences of narrator prose
  tick: number;
}

export type RoomType = 'storage' | 'kitchen' | 'lumber_hut' | 'blacksmith';

export interface Room {
  id: string;
  type: RoomType;
  x: number;          // top-left tile X of the 5×5 zone
  y: number;          // top-left tile Y
  w: number;          // always 5
  h: number;          // always 5
}

export interface GameState {
  tick: number;
  goblins: Goblin[];
  totalFood: number;
  totalMeals: number; // calculated sum of all meals
  totalOre: number;
  totalWood: number;
  selectedGoblinId: string | null;
  overlayMode: OverlayMode;
  paused: boolean;
  speed: number;  // multiplier: 0.25 | 0.5 | 1 | 2 | 4
  colonyGoal: ColonyGoal;
  foodStockpiles: FoodStockpile[];
  mealStockpiles: MealStockpile[];
  oreStockpiles: OreStockpile[];
  woodStockpiles: WoodStockpile[];
  plankStockpiles: PlankStockpile[];
  barStockpiles: BarStockpile[];
  /** Current weather / season (affects growback & metabolism). */
  weatherSeason?: Season;
  weatherType?: WeatherType;
  rooms: Room[];
  /** When the player has clicked a hearth, its position and current fuel (for HearthPanel). */
  selectedHearthTile?: { x: number; y: number; hearthFuel: number } | null;
  workerTargets?: import('../simulation/workerTargets').WorkerTargets;
}
