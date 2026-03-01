export enum TileType {
  Dirt     = 'dirt',
  Grass    = 'grass',
  Stone    = 'stone',
  Water    = 'water',
  Forest   = 'forest',
  Farmland = 'farmland',
  Ore      = 'ore',
  Mushroom = 'mushroom',
  Wall     = 'wall',     // player-built fortification; blocks movement
}

export interface Tile {
  type: TileType;
  foodValue: number;      // current food on tile
  materialValue: number;  // current material on tile
  maxFood: number;        // growback ceiling
  maxMaterial: number;
  growbackRate: number;   // food units restored per tick (0 = doesn't regrow)
}

export interface Inventory {
  food: number;
  materials: number;
}

/** Hostile NPC — spawns in raids from map edges. */
export interface Goblin {
  id:              string;
  x:               number;
  y:               number;
  health:          number;
  maxHealth:       number;
  targetId:        string | null;  // id of the dwarf currently being chased
  staggeredUntil?: number;         // tick until which the goblin cannot move (post-hit stagger)
}

// PIANO step 5 — structured intent the LLM can set to override the BT
export type LLMIntent = 'eat' | 'forage' | 'rest' | 'avoid' | 'socialize' | 'none';

// Permanent personality trait assigned at spawn
export type DwarfTrait = 'lazy' | 'forgetful' | 'helpful' | 'mean' | 'paranoid' | 'brave' | 'greedy' | 'cheerful';

// A tile location a dwarf has seen or visited — used for resource routing
export interface ResourceSite {
  x:     number;
  y:     number;
  value: number;  // tile foodValue or materialValue when last seen
  tick:  number;  // currentTick when last seen/updated
}

// PIANO step 7 — one entry per LLM decision; last 5 injected into next prompt
export interface MemoryEntry {
  tick:       number;
  crisis:     string;   // CrisisSituation.type
  action:     string;   // decision.action text
  reasoning?: string;   // LLM internal monologue (only present for LLM-originated entries)
  outcome?:   string;   // backfilled by VERIFY step (~40 ticks later)
}

// Agent role — assigned at spawn, permanent
export type DwarfRole = 'forager' | 'miner' | 'scout' | 'fighter' | 'lumberjack';

// Injury system — single wound slot, heals over time
export type WoundType = 'bruised' | 'leg' | 'arm' | 'eye';

export interface Wound {
  type:     WoundType;
  healTick: number;    // tick at which the wound automatically heals
}

export interface Dwarf {
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
  llmReasoning:    string | null;    // last LLM decision shown in DwarfPanel
  llmIntent:       LLMIntent | null; // active override intent (expires at llmIntentExpiry)
  llmIntentExpiry: number;           // tick after which intent is discarded
  memory:          MemoryEntry[];    // rolling decisions (uncapped); last 5 used in LLM prompts
  wanderTarget:    { x: number; y: number } | null;  // persistent explore waypoint
  wanderExpiry:    number;           // tick at which to repick a new wander waypoint
  knownFoodSites:  ResourceSite[];   // remembered food patches (cap: 5)
  knownOreSites:   ResourceSite[];   // remembered ore veins (cap: 5)
  knownWoodSites:  ResourceSite[];   // remembered forest wood sites (cap: 5)
  homeTile:        { x: number; y: number };  // fort/stockpile center — the colony's home base
  role:            DwarfRole;
  relations:       Record<string, number>;  // keyed by dwarf.id; 0–100 (50 = neutral)
  trait:           DwarfTrait;  // permanent personality trait
  bio:             string;      // quirky backstory blurb
  goal:            string;      // personal objective
  baseName:        string;      // name without roman numeral suffix (e.g. "Bomer")
  generation:      number;      // 1 for original dwarves, increments for each succession
  goblinKills:     number;      // lifetime count of goblins slain by this dwarf
  causeOfDeath?:   string;      // set when dwarf dies; shown in HUD + passed to successor
  fatigue:         number;      // 0–100; rises with movement/work, decays when resting
  social:          number;      // 0–100; rises when isolated from friendly dwarves
  lastSocialTick:  number;      // tick when dwarf last had a friend within proximity
  lastLoggedTicks: Record<string, number>;  // cooldown tracking for event log (key = event type, value = tick)
  skillXp:         number;      // lifetime XP for role skill (0+)
  skillLevel:      number;      // derived: floor(sqrt(xp / 10)) — cached, recomputed on XP grant
  wound?:          Wound;       // active wound (undefined = healthy); heals at wound.healTick
}

export interface LogEntry {
  tick: number;
  dwarfId: string;
  dwarfName: string;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export type OverlayMode = 'off' | 'food' | 'material' | 'wood';

// Colony-wide shared goal — all dwarves contribute; cycles on completion
export type ColonyGoalType = 'stockpile_food' | 'survive_ticks' | 'defeat_goblins' | 'enclose_fort';

export interface ColonyGoal {
  type:        ColonyGoalType;
  description: string;   // human-readable label shown in UI
  progress:    number;   // current progress value
  target:      number;   // value at which goal completes
  generation:  number;   // how many full cycles completed (scales difficulty)
}

// Communal food stockpile — one per colony, placed at center of spawn zone.
export interface FoodStockpile {
  x:       number;  // tile coords
  y:       number;
  food:    number;  // current stored food
  maxFood: number;  // food storage cap
}

// Communal ore stockpile — placed near the food stockpile; filled by miners.
// Miners draw from it when building fort walls.
export interface OreStockpile {
  x:      number;  // tile coords (distinct from food stockpile)
  y:      number;
  ore:    number;  // current stored ore
  maxOre: number;  // storage cap
}

// Communal wood stockpile — placed on the other side of the food stockpile; filled by lumberjacks.
export interface WoodStockpile {
  x:       number;  // tile coords
  y:       number;
  wood:    number;  // current stored wood
  maxWood: number;  // storage cap
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
  tiles:    { type: TileType; foodRatio: number; matRatio: number }[][];
  /** Alive dwarf positions and hunger (0–100). */
  dwarves:  { x: number; y: number; hunger: number }[];
  /** Goblin positions. */
  goblins:  { x: number; y: number }[];
  /** Camera viewport in tile-space. */
  viewport: { x: number; y: number; w: number; h: number };
}

/** Weather state — drives cascading resource scarcity/abundance. */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type WeatherType = 'clear' | 'rain' | 'drought' | 'cold';

export interface GameState {
  tick: number;
  dwarves: Dwarf[];
  totalFood: number;
  totalMaterials: number;
  selectedDwarfId: string | null;
  overlayMode: OverlayMode;
  paused: boolean;
  speed: number;  // multiplier: 0.25 | 0.5 | 1 | 2 | 4
  colonyGoal: ColonyGoal;
  foodStockpiles: FoodStockpile[];
  oreStockpiles:  OreStockpile[];
  woodStockpiles: WoodStockpile[];
  /** Current weather / season (affects growback & metabolism). */
  weatherSeason?: Season;
  weatherType?:   WeatherType;
}
