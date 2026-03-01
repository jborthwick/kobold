import * as ROT from 'rot-js';
import { TileType, type Goblin, type Tile, type GoblinRole, type MemoryEntry, type GoblinTrait, type FoodStockpile, type OreStockpile, type WoodStockpile, type Adventurer, type ResourceSite, type ColonyGoal } from '../shared/types';
import { GRID_SIZE, INITIAL_GOBLINS, GOBLIN_NAMES, MAX_INVENTORY_FOOD } from '../shared/constants';
import { isWalkable } from './world';
import { xpToLevel } from './skills';

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Resource site memory ───────────────────────────────────────────────────
/** Min tile value worth storing in a goblin's site memory. */
export const SITE_RECORD_THRESHOLD = 3;
/** Max remembered sites per type per goblin. */
export const MAX_KNOWN_SITES = 5;
/**
 * Manhattan radius within which two tiles are treated as the same patch.
 * Prevents a cluster of 10 adjacent mushrooms from burning all 5 memory
 * slots on individual tiles from the same group.
 */
export const PATCH_MERGE_RADIUS = 4;

/**
 * Upsert a resource site into a goblin's memory list.
 * 1. Exact tile already known → refresh value + tick in place.
 * 2. Within PATCH_MERGE_RADIUS of an existing entry → same patch; upgrade
 *    the representative to the richer tile or just refresh its tick.
 * 3. New distinct patch → append, evicting the weakest entry when full.
 *
 * Only forageable/minable tiles should be passed in — callers are
 * responsible for filtering by FORAGEABLE_TILES or materialValue > 0
 * before calling, so non-harvestable tiles (Forest, Stone, etc.) are
 * never stored.
 */
export function recordSite(sites: ResourceSite[], x: number, y: number, value: number, tick: number): void {
  // 1. Exact tile already known — refresh
  const idx = sites.findIndex(s => s.x === x && s.y === y);
  if (idx >= 0) { sites[idx] = { x, y, value, tick }; return; }

  // 2. Close enough to an existing patch — merge rather than add a new slot
  const nearIdx = sites.findIndex(
    s => Math.abs(s.x - x) + Math.abs(s.y - y) <= PATCH_MERGE_RADIUS,
  );
  if (nearIdx >= 0) {
    if (value > sites[nearIdx].value) {
      sites[nearIdx] = { x, y, value, tick };  // upgrade to richer tile
    } else {
      sites[nearIdx] = { ...sites[nearIdx], tick };  // just refresh freshness
    }
    return;
  }

  // 3. New distinct patch
  if (sites.length < MAX_KNOWN_SITES) { sites.push({ x, y, value, tick }); return; }
  // Evict lowest-value entry so we keep the richest patches
  const weakIdx = sites.reduce((min, s, i) => s.value < sites[min].value ? i : min, 0);
  if (value > sites[weakIdx].value) sites[weakIdx] = { x, y, value, tick };
}

// Tile types goblins can harvest food from.
// Add entries here to unlock new food sources — no logic changes needed.
export const FORAGEABLE_TILES = new Set<TileType>([
  TileType.Mushroom,
]);

// Role assignment order and vision ranges
const ROLE_ORDER: GoblinRole[] = ['forager', 'miner', 'scout', 'lumberjack', 'fighter'];

// ── Trait modifiers ──────────────────────────────────────────────────────────
// Traits modify BT thresholds so personality drives behavioral divergence.
// Missing keys fall back to defaults in traitMod() below.
export interface TraitMods {
  shareThreshold?: number;    // food >= X to trigger sharing (default 8)
  shareDonorKeeps?: number;   // keep >= X after sharing (default 5)
  eatThreshold?: number;      // hunger > X to eat (default 70)
  fleeThreshold?: number;     // hunger >= X to skip fighting (default 80)
  wanderHomeDrift?: number;   // probability of drifting home (default 0.25)
  contestPenalty?: number;    // relation penalty on losing contest (default -5)
  shareRelationGate?: number; // min relation to share food (default 30)
  fatigueRate?: number;       // fatigue gain multiplier (default 1.0; lazy: 1.3)
  socialDecayBonus?: number;  // extra social decay near friends (default 0; cheerful: 0.15)
}

export const TRAIT_MODS: Record<GoblinTrait, TraitMods> = {
  helpful:   { shareThreshold: 6, shareDonorKeeps: 3, shareRelationGate: 15 },
  greedy:    { shareThreshold: 12, shareDonorKeeps: 8 },
  brave:     { fleeThreshold: 95 },
  paranoid:  { fleeThreshold: 60, wanderHomeDrift: 0.5 },
  lazy:      { eatThreshold: 55, fatigueRate: 1.3 },
  cheerful:  { shareThreshold: 6, shareRelationGate: 20, socialDecayBonus: 0.15 },
  mean:      { shareThreshold: 14, contestPenalty: -10, shareRelationGate: 55 },
  forgetful: {},  // personality-flavor only for now
};

/** Look up a trait modifier with a default fallback. */
export function traitMod<K extends keyof TraitMods>(goblin: Goblin, key: K, fallback: number): number {
  return TRAIT_MODS[goblin.trait]?.[key] ?? fallback;
}

/** Goblin-flavored display names for traits (internal values stay the same for BT logic). */
export const GOBLIN_TRAIT_DISPLAY: Record<GoblinTrait, string> = {
  helpful:   'Surprisingly Generous',
  greedy:    'Shinies Hoarder',
  brave:     'Too Dumb to Run',
  paranoid:  'Sensibly Cautious',
  lazy:      'Professional Napper',
  cheerful:  'Annoyingly Cheerful',
  mean:      'Bitey',
  forgetful: 'What Was I Doing?',
};

/** Goblin-flavored display names for roles (internal values stay the same for BT logic). */
export const GOBLIN_ROLE_DISPLAY: Record<GoblinRole, string> = {
  forager:    'SCAVENGER',
  miner:      'ROCK BITER',
  scout:      'SNEAKY GIT',
  fighter:    'BASHER',
  lumberjack: 'TREE PUNCHER',
};

// ── Trait / bio / goal tables ─────────────────────────────────────────────────
const GOBLIN_TRAITS: GoblinTrait[] = [
  'lazy', 'forgetful', 'helpful', 'mean', 'paranoid', 'brave', 'greedy', 'cheerful',
];

const GOBLIN_BIOS: string[] = [
  'ate a rock once and liked it',
  'has an imaginary friend named Keith',
  'claims to have invented fire',
  'afraid of loud noises and also quiet ones',
  'once stole a sword bigger than himself',
  'was kicked out of three different caves',
  'firmly believes the moon is edible',
  'has a pet spider named Lord Bitington',
  'convinced he can talk to mushrooms',
  'lost a fight to a particularly aggressive squirrel',
];

const GOBLIN_GOALS: string[] = [
  'eat something that isn\'t a bug',
  'find a rock that looks like a face',
  'go one whole day without being hit',
  'make a friend (a real one this time)',
  'find something shiny',
  'build something that doesn\'t fall down',
  'survive until lunch',
  'learn what a "plan" is',
];
const ROLE_STATS: Record<GoblinRole, { visionMin: number; visionMax: number; maxHealth: number }> = {
  forager:    { visionMin: 5, visionMax: 8,  maxHealth: 100 },
  miner:      { visionMin: 4, visionMax: 6,  maxHealth: 100 },
  scout:      { visionMin: 7, visionMax: 12, maxHealth: 100 },
  fighter:    { visionMin: 4, visionMax: 7,  maxHealth: 130 },
  lumberjack: { visionMin: 5, visionMax: 8,  maxHealth: 100 },
};

/** Convert a positive integer to a roman numeral string (up to 3999). */
function toRoman(n: number): string {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let result = '';
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { result += syms[i]; n -= vals[i]; }
  }
  return result;
}

export function spawnGoblins(
  grid:      Tile[][],
  spawnZone: { x: number; y: number; w: number; h: number },
): Goblin[] {
  const goblins: Goblin[] = [];
  for (let i = 0; i < INITIAL_GOBLINS; i++) {
    let x: number, y: number;
    do {
      x = spawnZone.x + rand(0, spawnZone.w - 1);
      y = spawnZone.y + rand(0, spawnZone.h - 1);
    } while (!isWalkable(grid, x, y));

    const role  = ROLE_ORDER[i % ROLE_ORDER.length];
    const stats = ROLE_STATS[role];

    const baseName = GOBLIN_NAMES[i % GOBLIN_NAMES.length];
    goblins.push({
      id:            `goblin-${i}`,
      name:          baseName,
      baseName,
      generation:    1,
      x, y,
      health:        stats.maxHealth,
      maxHealth:     stats.maxHealth,
      hunger:        rand(10, 30),
      metabolism:    Math.round((0.15 + Math.random() * 0.2) * 100) / 100,  // 0.15–0.35/tick (~3–6 min to starve)
      vision:        rand(stats.visionMin, stats.visionMax),
      inventory:     { food: rand(8, 15), materials: 0 },
      morale:        70 + rand(0, 20),
      alive:         true,
      task:          'idle',
      role,
      commandTarget: null,
      llmReasoning:    null,
      llmIntent:       null,
      llmIntentExpiry: 0,
      memory:          [],
      relations:       {},   // populated lazily as goblins interact
      trait:           GOBLIN_TRAITS[Math.floor(Math.random() * GOBLIN_TRAITS.length)],
      bio:             GOBLIN_BIOS[Math.floor(Math.random() * GOBLIN_BIOS.length)],
      goal:            GOBLIN_GOALS[Math.floor(Math.random() * GOBLIN_GOALS.length)],
      wanderTarget:    null,
      wanderExpiry:    0,
      knownFoodSites:  [],
      knownOreSites:   [],
      knownWoodSites:  [],
      homeTile:        { x: 0, y: 0 },  // overwritten by WorldScene after stockpile is placed
      adventurerKills:     0,
      fatigue:         0,
      social:          0,
      lastSocialTick:  0,
      lastLoggedTicks: { morale_high: 0 },  // suppress "feeling great" at spawn
      skillXp:         0,
      skillLevel:      0,
    });
  }
  return goblins;
}

// ── Succession ─────────────────────────────────────────────────────────────

/** Ticks before a successor arrives after a death (~43 s at 7 ticks/s). */
export const SUCCESSION_DELAY = 300;

/**
 * Spawn a new goblin that inherits fragments of the predecessor's memory and
 * (muted) relationships.  Called by WorldScene when a pendingSuccession matures.
 */
export function spawnSuccessor(
  dead:       Goblin,
  grid:       Tile[][],
  spawnZone:  { x: number; y: number; w: number; h: number },
  allDwarves: Goblin[],
  tick:       number,
): Goblin {
  // Successor inherits the predecessor's base name with a roman numeral suffix.
  // e.g. "Bomer" → "Bomer II" → "Bomer III"
  const baseName   = dead.baseName;
  const generation = dead.generation + 1;
  const name       = generation === 1 ? baseName : `${baseName} ${toRoman(generation)}`;

  const role  = ROLE_ORDER[Math.floor(Math.random() * ROLE_ORDER.length)];
  const stats = ROLE_STATS[role];

  let x: number, y: number;
  do {
    x = spawnZone.x + rand(0, spawnZone.w - 1);
    y = spawnZone.y + rand(0, spawnZone.h - 1);
  } while (!isWalkable(grid, x, y));

  // Inherit last 2 memory entries, reframed as colony lore
  const inheritedMemory: MemoryEntry[] = dead.memory.slice(-2).map(m => ({
    tick,
    crisis:  'inheritance',
    action:  `${dead.name} once: "${m.action}"`,
    outcome: m.outcome,
  }));
  // Prepend predecessor's cause of death as the first memory
  if (dead.causeOfDeath) {
    inheritedMemory.unshift({
      tick,
      crisis: 'inheritance',
      action: `${dead.name} died of ${dead.causeOfDeath}`,
    });
  }

  // Append predecessor's strongest ally and rival as colony lore
  const sortedRels = Object.entries(dead.relations).sort(([, a], [, b]) => b - a);
  const topAlly  = sortedRels.find(([, s]) => s > 60);
  const topRival = [...sortedRels].reverse().find(([, s]) => s < 40);
  if (topAlly) {
    const allyDwarf = allDwarves.find(d => d.id === topAlly[0]);
    if (allyDwarf) inheritedMemory.push({ tick, crisis: 'inheritance',
      action: `${dead.name}'s closest companion was ${allyDwarf.name}` });
  }
  if (topRival) {
    const rivalDwarf = allDwarves.find(d => d.id === topRival[0]);
    if (rivalDwarf) inheritedMemory.push({ tick, crisis: 'inheritance',
      action: `${dead.name}'s greatest rival was ${rivalDwarf.name}` });
  }

  // Inherit relations muted 50% toward neutral (50) — keeps meaningful bonds but dampened
  const relations: Record<string, number> = {};
  for (const [id2, score] of Object.entries(dead.relations)) {
    relations[id2] = Math.round(50 + (score - 50) * 0.5);
  }

  return {
    id:            `goblin-${Date.now()}`,
    name,
    baseName,
    generation,
    x, y,
    health:        stats.maxHealth,
    maxHealth:     stats.maxHealth,
    hunger:        rand(10, 30),
    metabolism:    Math.round((0.15 + Math.random() * 0.2) * 100) / 100,
    vision:        rand(stats.visionMin, stats.visionMax),
    inventory:     { food: rand(5, 12), materials: 0 },
    morale:        60 + rand(0, 20),
    alive:         true,
    task:          'just arrived',
    role,
    commandTarget:   null,
    llmReasoning:    null,
    llmIntent:       null,
    llmIntentExpiry: 0,
    memory:          inheritedMemory,
    relations,
    trait:           GOBLIN_TRAITS[Math.floor(Math.random() * GOBLIN_TRAITS.length)],
    bio:             GOBLIN_BIOS[Math.floor(Math.random() * GOBLIN_BIOS.length)],
    goal:            GOBLIN_GOALS[Math.floor(Math.random() * GOBLIN_GOALS.length)],
    wanderTarget:    null,
    wanderExpiry:    0,
    knownFoodSites:  [],
    knownOreSites:   [],
    knownWoodSites:  [],
    homeTile:        { x: 0, y: 0 },  // overwritten by WorldScene after stockpile is placed
    adventurerKills:     0,
    fatigue:         0,
    social:          0,
    lastSocialTick:  0,
    lastLoggedTicks: { morale_high: 0 },  // suppress "feeling great" at spawn
    skillXp:         Math.floor(dead.skillXp * 0.25),  // inherit 25% of predecessor's XP
    skillLevel:      xpToLevel(Math.floor(dead.skillXp * 0.25)),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Scan a square of `radius` tiles around the goblin for the richest forageable tile. */
export function bestFoodTile(
  goblin:  Goblin,
  grid:   Tile[][],
  radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 1; // ignore tiles with < 1 food — avoids chasing micro-regrowth fractions

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = goblin.x + dx;
      const ny = goblin.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (!FORAGEABLE_TILES.has(grid[ny][nx].type)) continue;
      const v = grid[ny][nx].foodValue;
      if (v > bestValue) { bestValue = v; best = { x: nx, y: ny }; }
    }
  }
  return best;
}

/** Scan a square of `radius` tiles around the goblin for the richest ore/stone material tile (miners).
 *  Excludes Forest tiles — wood is handled separately by lumberjacks via bestWoodTile(). */
export function bestMaterialTile(
  goblin:  Goblin,
  grid:   Tile[][],
  radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 1;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = goblin.x + dx;
      const ny = goblin.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (grid[ny][nx].type === TileType.Forest) continue;  // forest = wood, not ore
      const v = grid[ny][nx].materialValue;
      if (v > bestValue) { bestValue = v; best = { x: nx, y: ny }; }
    }
  }
  return best;
}

/** Scan a square of `radius` tiles around the goblin for the richest Forest tile with wood (lumberjacks). */
export function bestWoodTile(
  goblin:  Goblin,
  grid:   Tile[][],
  radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 1;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = goblin.x + dx;
      const ny = goblin.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (grid[ny][nx].type !== TileType.Forest) continue;
      const v = grid[ny][nx].materialValue;
      if (v > bestValue) { bestValue = v; best = { x: nx, y: ny }; }
    }
  }
  return best;
}

/**
 * Returns the next tile to step onto when moving from `from` toward `to`,
 * using rot.js A* for obstacle-aware pathfinding.
 * Falls back to staying in place if the destination is unreachable.
 * Exported so adventurers can share the same pathfinding logic.
 */
export function pathNextStep(
  from: { x: number; y: number },
  to:   { x: number; y: number },
  grid: Tile[][],
): { x: number; y: number } {
  if (from.x === to.x && from.y === to.y) return from;

  const path: { x: number; y: number }[] = [];

  const astar = new ROT.Path.AStar(
    to.x, to.y,
    // Goal tile is always considered passable — commands only target walkable
    // tiles, and forage targets (food tiles) are also walkable.
    (x, y) => (x === to.x && y === to.y) || isWalkable(grid, x, y),
    { topology: 4 },
  );

  astar.compute(from.x, from.y, (x, y) => path.push({ x, y }));

  // path[0] = from, path[1] = first step. Stay put if unreachable.
  return path[1] ?? from;
}

// ── Fort-building helper ───────────────────────────────────────────────────
/**
 * Returns all unbuilt wall-slot candidates for the H-shaped fort.
 *
 * Each room is fixed 5 tiles wide (anchor ± MARGIN=2) and grows southward
 * as new depot / stockpile units are added (3 tiles apart per unit).
 *
 * Layout with N depots at (depotX, depotY), (depotX, depotY+3), …:
 *
 *   y-2:  ■ ■ ■ ■ ■ ─ ─ ─ ─ ─ ■ ■ ■ ■ ■   ← top wall + H top-bar
 *   y-1:  ■   depot room   ■  corridor  ■  stockpile room  ■
 *   y 0:  ■      [D₁]       ■   open    ■      [S₁]         ■
 *   y+1:  ■                 ■   open    ■                    ■
 *   y+2:  ■                 ■           ■                    ■   ← old south wall (3-wide gate stays open)
 *   y+3:  ■      [D₂]       ■           ■      [S₂]         ■   ← second unit (if added)
 *   y+4:  ■                 ■           ■                    ■
 *   y+5:  ■ ■ _ _ ■ ■ ■    ·           ·    ■ ■ _ _ ■ ■ ■  ← new south wall + 3-wide gate
 *
 * Miners fill slots nearest-first, so outer walls build before interior rows.
 */
export function fortWallSlots(
  foodStockpiles: Array<{ x: number; y: number }>,
  oreStockpiles:  Array<{ x: number; y: number }>,
  grid:           Tile[][],
  goblins:        Goblin[] | undefined,
  selfId:         string,
  adventurers?:       Adventurer[],
): Array<{ x: number; y: number }> {
  const MARGIN = 2;
  const slots: Array<{ x: number; y: number }> = [];

  const blocked = (x: number, y: number): boolean => {
    if (goblins?.some(d => d.alive && d.id !== selfId && d.x === x && d.y === y)) return true;
    if (adventurers?.some(g => g.x === x && g.y === y)) return true;
    return false;
  };

  const tryAdd = (x: number, y: number): void => {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
    const t = grid[y][x];
    if (t.type === TileType.Wall || t.type === TileType.Water
        || t.type === TileType.Ore) return;
    if (!blocked(x, y)) slots.push({ x, y });
  };

  const anchorD = foodStockpiles[0];
  const anchorS = oreStockpiles[0];

  // ── Pre-plan rooms for a 3-col × 3-row grid (9 units each) ────────────────
  // Rooms grow AWAY from each other so the corridor-side inner walls never move.
  // This means the room is fully walled from the start and no interior dividers
  // form as subsequent stockpile units fill the room one by one.
  const COL_STEP  = 1;   // adjacent stockpiles — 7×7 room for 3×3 grid
  const ROW_STEP  = 1;
  const ROOM_COLS = 3;   // 3 columns per room
  const ROOM_ROWS = 3;   // pre-build for 3 rows (9 units); grows naturally beyond that

  const foodLeft = anchorD.x < anchorS.x;  // typical: food room is to the left
  const dExpDir  = foodLeft ? -1 : 1;       // food expands away from ore (leftward)
  const sExpDir  = foodLeft ?  1 : -1;       // ore expands away from food (rightward)

  // Food room — corridor-side wall (dMaxX) stays fixed; outer wall grows left
  const dMinX = Math.min(anchorD.x, anchorD.x + dExpDir * (ROOM_COLS - 1) * COL_STEP) - MARGIN;
  const dMaxX = Math.max(anchorD.x, anchorD.x + dExpDir * (ROOM_COLS - 1) * COL_STEP) + MARGIN;
  const dMinY = anchorD.y - MARGIN;
  const dMaxY = Math.max(
    anchorD.y + (ROOM_ROWS - 1) * ROW_STEP + MARGIN,
    Math.max(...foodStockpiles.map(d => d.y)) + MARGIN,
  );
  for (let y = dMinY; y <= dMaxY; y++) {
    for (let x = dMinX; x <= dMaxX; x++) {
      if (x !== dMinX && x !== dMaxX && y !== dMinY && y !== dMaxY) continue;
      if (y === dMaxY && x === anchorD.x) continue;               // 1-tile south door
      if (foodStockpiles.some(d => d.x === x && d.y === y)) continue;  // storage tile itself
      tryAdd(x, y);
    }
  }

  // Ore room — corridor-side wall (sMinX) stays fixed; outer wall grows right
  const sMinX = Math.min(anchorS.x, anchorS.x + sExpDir * (ROOM_COLS - 1) * COL_STEP) - MARGIN;
  const sMaxX = Math.max(anchorS.x, anchorS.x + sExpDir * (ROOM_COLS - 1) * COL_STEP) + MARGIN;
  const sMinY = anchorS.y - MARGIN;
  const sMaxY = Math.max(
    anchorS.y + (ROOM_ROWS - 1) * ROW_STEP + MARGIN,
    Math.max(...oreStockpiles.map(s => s.y)) + MARGIN,
  );
  for (let y = sMinY; y <= sMaxY; y++) {
    for (let x = sMinX; x <= sMaxX; x++) {
      if (x !== sMinX && x !== sMaxX && y !== sMinY && y !== sMaxY) continue;
      if (y === sMaxY && x === anchorS.x) continue;               // 1-tile south door
      if (oreStockpiles.some(s => s.x === x && s.y === y)) continue; // storage tile itself
      tryAdd(x, y);
    }
  }

  // ── Top corridor bar — H cross-piece at the shared top edge ──────────
  // barXmin/barXmax use the corridor-side walls which never move (anchorD/S.x ± MARGIN)
  const topY    = Math.min(dMinY, sMinY);
  const barXmin = dMaxX + 1;
  const barXmax = sMinX - 1;
  for (let x = barXmin; x <= barXmax; x++) {
    tryAdd(x, topY);
  }

  return slots;
}

/**
 * Returns unbuilt wall slots for the south corridor bar that closes the
 * compound into a fully-enclosed fort.
 *
 * The open corridor between the food-room and ore-room is already bounded on
 * three sides (north by the H-bar, left/right by the room side-walls).  This
 * adds the matching south bar, completing a rectangular compound wall:
 *
 *   [food room] │ ■ ■ ■ _ ■ ■ ■ │ [ore room]
 *                      ↑ centre door
 *
 * Called by the miner after all inner-room wall slots are exhausted.
 */
export function fortEnclosureSlots(
  foodStockpiles: Array<{ x: number; y: number }>,
  oreStockpiles:  Array<{ x: number; y: number }>,
  grid:           Tile[][],
  goblins:        Goblin[] | undefined,
  selfId:         string,
  adventurers?:       Adventurer[],
): Array<{ x: number; y: number }> {
  const MARGIN  = 2;
  const dMaxX   = Math.max(...foodStockpiles.map(d => d.x)) + MARGIN;
  const dMaxY   = Math.max(...foodStockpiles.map(d => d.y)) + MARGIN;
  const sMinX   = Math.min(...oreStockpiles.map(s => s.x)) - MARGIN;
  const sMaxY   = Math.max(...oreStockpiles.map(s => s.y)) + MARGIN;
  const barXmin = dMaxX + 1;
  const barXmax = sMinX - 1;

  // No corridor gap between the two rooms — nothing to close
  if (barXmin > barXmax) return [];

  const southY = Math.max(dMaxY, sMaxY);
  const doorX  = Math.floor((barXmin + barXmax) / 2);  // centre-corridor door

  const blocked = (x: number, y: number): boolean => {
    if (goblins?.some(d => d.alive && d.id !== selfId && d.x === x && d.y === y)) return true;
    if (adventurers?.some(g => g.x === x && g.y === y)) return true;
    return false;
  };

  const slots: Array<{ x: number; y: number }> = [];
  for (let x = barXmin; x <= barXmax; x++) {
    if (x === doorX) continue;                                        // leave centre door open
    if (x < 0 || x >= GRID_SIZE || southY < 0 || southY >= GRID_SIZE) continue;
    const t = grid[southY][x];
    if (t.type === TileType.Wall || t.type === TileType.Water
        || t.type === TileType.Ore) continue;
    if (!blocked(x, southY)) slots.push({ x, y: southY });
  }
  return slots;
}

// ── Behavior Tree ──────────────────────────────────────────────────────────
// Priority cascade (highest first):
//   1.  Starvation damage / death
//   2.  Eat from inventory (hunger > 70)
//   2.5 Execute LLM intent: eat (force-eat), rest (stay put)
//       'forage' and 'avoid' are handled in steps 4/5
//   3.  Follow player commandTarget  ← player commands override harvesting
//   4.  Forage + harvest (Sugarscape rule): move toward richest food tile;
//       radius extends to 15 when llmIntent === 'forage'
//   5.  Wander (or avoid rival when llmIntent === 'avoid')

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

export function tickAgent(
  goblin:              Goblin,
  grid:               Tile[][],
  currentTick:        number,
  goblins?:           Goblin[],
  onLog?:             LogFn,
  foodStockpiles?:    FoodStockpile[],
  adventurers?:           Adventurer[],
  oreStockpiles?:     OreStockpile[],
  _colonyGoal?:       ColonyGoal,
  woodStockpiles?:    WoodStockpile[],
  /** Weather metabolism multiplier (1.0 = normal, 1.4 = cold). */
  weatherMetabolismMod?: number,
): void {
  if (!goblin.alive) return;

  // Safety escape: if the goblin is somehow on a non-walkable tile (e.g. a wall was
  // placed under them), nudge them to the nearest walkable neighbour.
  if (!isWalkable(grid, goblin.x, goblin.y)) {
    const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
    const escape = dirs.find(d => isWalkable(grid, goblin.x + d.x, goblin.y + d.y));
    if (escape) { goblin.x += escape.x; goblin.y += escape.y; }
  }

  // Hunger grows every tick (cold weather burns calories faster)
  goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * (weatherMetabolismMod ?? 1));

  // Morale decays slowly when hungry, recovers when well-fed
  if (goblin.hunger > 60) {
    goblin.morale = Math.max(0,   goblin.morale - 0.4);
  } else if (goblin.hunger < 30) {
    goblin.morale = Math.min(100, goblin.morale + 0.2);
  }
  // Stress metabolism — demoralized goblins burn calories faster (morale death spiral)
  if (goblin.morale < 25) {
    goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * 0.3);
  }

  // ── Fatigue tick ────────────────────────────────────────────────────────
  // Fatigue rises from movement/work (applied at action sites below) and
  // decays passively when idle. Lazy goblins gain fatigue faster (×1.3).
  // Effects: >70 → 30% skip movement + halved harvest; >90 → morale drain.
  // Rest intent: strong decay (−1.5/tick) handled in step 2.5.
  // Base idle decay is small so fatigue doesn't vanish instantly.
  const fatigueRate = traitMod(goblin, 'fatigueRate', 1.0);
  goblin.fatigue = Math.max(0, goblin.fatigue - 0.05); // tiny idle decay
  if (goblin.fatigue > 90) {
    goblin.morale = Math.max(0, goblin.morale - 0.2);
  }

  // ── Social tick ─────────────────────────────────────────────────────────
  // Social need rises when isolated from friendly goblins (relation >= 40,
  // within 3 tiles). Cheerful goblins decay social faster near friends.
  // Effects: >60 → morale drain −0.15/tick.
  if (goblins) {
    const FRIEND_RADIUS = 3;
    const FRIEND_REL    = 40;
    const hasFriend = goblins.some(
      other => other.id !== goblin.id && other.alive &&
        Math.abs(other.x - goblin.x) <= FRIEND_RADIUS &&
        Math.abs(other.y - goblin.y) <= FRIEND_RADIUS &&
        (goblin.relations[other.id] ?? 50) >= FRIEND_REL,
    );
    if (hasFriend) {
      const socialBonus = traitMod(goblin, 'socialDecayBonus', 0);
      goblin.social = Math.max(0, goblin.social - (0.3 + socialBonus));
      goblin.lastSocialTick = currentTick;
    } else if (currentTick - goblin.lastSocialTick > 30) {
      goblin.social = Math.min(100, goblin.social + 0.15);
    }
  }
  if (goblin.social > 60) {
    goblin.morale = Math.max(0, goblin.morale - 0.15);
  }

  // Fatigue > 70: 30% chance to skip action this tick (exhaustion stumble)
  if (goblin.fatigue > 70 && Math.random() < 0.3) {
    goblin.task = 'exhausted…';
    goblin.fatigue = Math.max(0, goblin.fatigue - 0.5); // slight recovery from forced rest
    return;
  }

  // ── 1. Starvation ─────────────────────────────────────────────────────
  if (goblin.hunger >= 100 && goblin.inventory.food === 0) {
    goblin.health -= 2;
    goblin.morale  = Math.max(0, goblin.morale - 2);
    goblin.task    = 'starving!';
    onLog?.(`is starving! (health ${goblin.health})`, 'warn');
    if (goblin.health <= 0) {
      goblin.alive         = false;
      goblin.task          = 'dead';
      goblin.causeOfDeath  = 'starvation';
      onLog?.('has died of starvation!', 'error');
      return;
    }
    // Still alive — fall through so they can still move toward food
  }

  // ── 2. Eat from inventory ──────────────────────────────────────────────
  // Threshold at 70 (not 50) so hunger regularly crosses the 65 crisis
  // threshold first — giving the LLM a chance to react before they eat.
  // Lazy goblins eat at 55 (sooner); trait-driven via traitMod.
  if (goblin.hunger > traitMod(goblin, 'eatThreshold', 70) && goblin.inventory.food > 0) {
    const bite        = Math.min(goblin.inventory.food, 3);
    goblin.inventory.food -= bite;
    goblin.hunger      = Math.max(0, goblin.hunger - bite * 20);
    goblin.task        = 'eating';
    return;
  }

  // ── 2.5. Execute LLM intent (eat / rest) ──────────────────────────────
  // 'forage' and 'avoid' are handled in steps 4 / 5 via llmIntent check.
  if (goblin.llmIntent) {
    if (currentTick > goblin.llmIntentExpiry) {
      goblin.llmIntent = null;          // intent expired — clear it
    } else {
      switch (goblin.llmIntent) {
        case 'eat':
          // Force-eat even below the normal 70-hunger threshold
          if (goblin.inventory.food > 0 && goblin.hunger > 30) {
            const bite           = Math.min(goblin.inventory.food, 3);
            goblin.inventory.food -= bite;
            goblin.hunger         = Math.max(0, goblin.hunger - bite * 20);
            goblin.task           = 'eating (LLM)';
            return;
          }
          break;
        case 'rest':
          goblin.fatigue = Math.max(0, goblin.fatigue - 1.5);
          goblin.task = 'resting';
          return;                      // skip movement entirely
        case 'socialize': {
          // Pathfind toward the nearest friendly goblin
          if (goblins) {
            const FRIEND_REL = 40;
            let bestDist = Infinity;
            let bestFriend: Goblin | null = null;
            for (const other of goblins) {
              if (other.id === goblin.id || !other.alive) continue;
              if ((goblin.relations[other.id] ?? 50) < FRIEND_REL) continue;
              const dist = Math.abs(other.x - goblin.x) + Math.abs(other.y - goblin.y);
              if (dist < bestDist) { bestDist = dist; bestFriend = other; }
            }
            if (bestFriend && bestDist > 1) {
              const step = pathNextStep({ x: goblin.x, y: goblin.y }, bestFriend, grid);
              goblin.x = step.x; goblin.y = step.y;
              goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate);
            }
            goblin.task = 'socializing';
            return;
          }
          break;
        }
        case 'forage':
        case 'avoid':
        case 'none':
          break;                       // handled in later BT steps
      }
    }
  }

  // ── 2.7. Food sharing ─────────────────────────────────────────────────
  // Well-fed goblins share 3 food with the hungriest starving neighbor.
  // Trait-driven: helpful shares at 6 food, greedy at 12; mean won't share with rivals.
  const shareThresh     = traitMod(goblin, 'shareThreshold', 8);
  const shareDonorKeeps = traitMod(goblin, 'shareDonorKeeps', 5);
  const shareRelGate    = traitMod(goblin, 'shareRelationGate', 30);
  if (goblins && goblin.inventory.food >= shareThresh) {
    const SHARE_RADIUS = 2;
    const needy = goblins
      .filter(d =>
        d.alive && d.id !== goblin.id &&
        Math.abs(d.x - goblin.x) <= SHARE_RADIUS &&
        Math.abs(d.y - goblin.y) <= SHARE_RADIUS &&
        d.hunger > 60 && d.inventory.food < 3 &&
        (goblin.relations[d.id] ?? 50) >= shareRelGate,  // won't share with rivals
      )
      .sort((a, b) => b.hunger - a.hunger)[0] ?? null;
    if (needy) {
      const gift = Math.min(3, goblin.inventory.food - shareDonorKeeps);
      if (gift <= 0) { /* trait keeps too much — skip sharing */ }
      else {
      goblin.inventory.food -= gift;
      needy.inventory.food  = Math.min(MAX_INVENTORY_FOOD, needy.inventory.food + gift);
      // Sharing builds positive ties: giver +10, recipient +15
      goblin.relations[needy.id] = Math.min(100, (goblin.relations[needy.id] ?? 50) + 10);
      needy.relations[goblin.id] = Math.min(100, (needy.relations[goblin.id] ?? 50) + 15);
      goblin.task = `sharing food → ${needy.name}`;
      onLog?.(`shared ${gift} food with ${needy.name} (hunger ${needy.hunger.toFixed(0)})`, 'info');
      goblin.memory.push({ tick: currentTick, crisis: 'food_sharing', action: `shared ${gift} food with ${needy.name}` });
      needy.memory.push({ tick: currentTick, crisis: 'food_sharing', action: `received ${gift} food from ${goblin.name}` });
      return;
      }  // end else (gift > 0)
    }
  }

  // ── 2.8. Food stockpile deposit / withdraw ────────────────────────────
  // When standing on any food stockpile tile: deposit surplus food or withdraw if hungry.
  const standingFoodStockpile = foodStockpiles?.find(d => d.x === goblin.x && d.y === goblin.y) ?? null;
  if (standingFoodStockpile) {
    if (goblin.inventory.food >= 10) {
      const amount = goblin.inventory.food - 6;
      const stored = Math.min(amount, standingFoodStockpile.maxFood - standingFoodStockpile.food);
      if (stored > 0) {
        standingFoodStockpile.food += stored;
        goblin.inventory.food       -= stored;
        goblin.task                  = `deposited ${stored.toFixed(0)} → stockpile`;
        return;
      }
    }
    if (goblin.hunger > 60 && goblin.inventory.food < 2 && standingFoodStockpile.food > 0) {
      const amount                = Math.min(4, standingFoodStockpile.food);
      standingFoodStockpile.food -= amount;
      goblin.inventory.food        = Math.min(MAX_INVENTORY_FOOD, goblin.inventory.food + amount);
      goblin.task                  = `withdrew ${amount.toFixed(0)} from stockpile`;
      return;
    }
  }

  // ── 2.9. Ore stockpile deposit ────────────────────────────────────────
  // Miners standing on any ore stockpile tile deposit all carried ore.
  const standingOreStockpile = oreStockpiles?.find(s => s.x === goblin.x && s.y === goblin.y) ?? null;
  if (goblin.role === 'miner' && standingOreStockpile && goblin.inventory.materials > 0) {
    const stored = Math.min(goblin.inventory.materials, standingOreStockpile.maxOre - standingOreStockpile.ore);
    if (stored > 0) {
      standingOreStockpile.ore  += stored;
      goblin.inventory.materials -= stored;
      goblin.task                 = `deposited ${stored.toFixed(0)} ore → stockpile`;
      return;
    }
  }

  // ── 2.9b. Wood stockpile deposit ──────────────────────────────────────
  // Lumberjacks standing on any wood stockpile tile deposit all carried wood.
  const standingWoodStockpile = woodStockpiles?.find(s => s.x === goblin.x && s.y === goblin.y) ?? null;
  if (goblin.role === 'lumberjack' && standingWoodStockpile && goblin.inventory.materials > 0) {
    const stored = Math.min(goblin.inventory.materials, standingWoodStockpile.maxWood - standingWoodStockpile.wood);
    if (stored > 0) {
      standingWoodStockpile.wood  += stored;
      goblin.inventory.materials   -= stored;
      goblin.task                   = `deposited ${stored.toFixed(0)} wood → stockpile`;
      return;
    }
  }

  // ── 3. Follow player command ───────────────────────────────────────────
  // Player commands take priority over autonomous harvesting so right-click
  // actually moves the goblin without interruption.
  if (goblin.commandTarget) {
    const { x: tx, y: ty } = goblin.commandTarget;
    if (goblin.x === tx && goblin.y === ty) {
      onLog?.(`arrived at (${tx},${ty})`, 'info');
      goblin.commandTarget = null;
      goblin.task          = 'arrived';
    } else {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, goblin.commandTarget, grid);
      goblin.x    = next.x;
      goblin.y    = next.y;
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate);
      goblin.task = `→ (${tx},${ty})`;
    }
    return;
  }

  // ── 3.5. Fighter — hunt nearest adventurer within vision×2 ──────────────────
  // Fires only when there are adventurers nearby and the LLM hasn't ordered rest.
  // Fighter moves toward the closest adventurer; when on the same tile the adventurer
  // will deal/receive combat damage in tickAdventurers (18 hp per hit vs 8 for others).
  // Fighters abandon the hunt when too hungry — survival trumps combat.
  // Brave goblins fight at 95 hunger; paranoid ones bail at 60.
  const fleeAt = traitMod(goblin, 'fleeThreshold', 80);
  if (goblin.role === 'fighter' && adventurers && adventurers.length > 0
      && goblin.hunger < fleeAt) {
    const HUNT_RADIUS = goblin.vision * 2;
    const nearest = adventurers.reduce<{ g: Adventurer; dist: number } | null>((best, g) => {
      const dist = Math.abs(g.x - goblin.x) + Math.abs(g.y - goblin.y);
      return (!best || dist < best.dist) ? { g, dist } : best;
    }, null);
    if (nearest && nearest.dist <= HUNT_RADIUS) {
      if (nearest.dist > 0) {
        // First step
        const step1 = pathNextStep(
          { x: goblin.x, y: goblin.y },
          { x: nearest.g.x, y: nearest.g.y },
          grid,
        );
        goblin.x = step1.x;
        goblin.y = step1.y;
        // Sprint — take a second step so fighters reliably close on fleeing adventurers
        const step2 = pathNextStep(
          { x: goblin.x, y: goblin.y },
          { x: nearest.g.x, y: nearest.g.y },
          grid,
        );
        goblin.x = step2.x;
        goblin.y = step2.y;
      }
      const distAfterMove = Math.abs(nearest.g.x - goblin.x) + Math.abs(nearest.g.y - goblin.y);
      // Fighting is hard work — double fatigue for combat + sprint
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate);
      goblin.task = distAfterMove === 0
        ? 'fighting adventurer!'
        : `→ adventurer (${distAfterMove} tiles)`;
      return;
    }
  }

  // ── 4. Forage + harvest (Sugarscape rule) ─────────────────────────────
  // Each tick: move toward the richest food tile, then harvest wherever
  // you land.  Scan radius scales with desperation so goblins search wider
  // even without LLM enabled.  LLM 'forage' intent pins it to the max (15).
  //   normal            → goblin.vision
  //   hungry (> 65)     → min(vision × 2, 15)   ← deterministic, no LLM needed
  //   LLM intent forage → 15
  // Miners/lumberjacks skip food foraging when not yet hungry — they prefer to mine/log.
  // Below hunger 50 they fall straight through to resource-gathering BT steps.
  // Dwarves with a full inventory also skip — step 4.2 handles depot routing,
  // and step 5 wander (with its 25% home-drift) handles the depot-full case.
  // This prevents the fill-up → rush-to-food → fill-up loop.
  const inventoryFull  = goblin.inventory.food >= MAX_INVENTORY_FOOD;
  const skipFoodForage = inventoryFull
    || ((goblin.role === 'miner' || goblin.role === 'lumberjack') && goblin.hunger < 50 && goblin.llmIntent !== 'forage');
  const radius = goblin.llmIntent === 'forage' ? 15
    : goblin.hunger > 65 ? Math.min(goblin.vision * 2, 15)
    : goblin.vision;
  const foodTarget = skipFoodForage ? null : bestFoodTile(goblin, grid, radius);
  // Sight-memory: record any rich food tile the goblin can currently see
  if (foodTarget) {
    const tv = grid[foodTarget.y][foodTarget.x].foodValue;
    if (tv >= SITE_RECORD_THRESHOLD) {
      recordSite(goblin.knownFoodSites, foodTarget.x, foodTarget.y, tv, currentTick);
    }
  }
  if (foodTarget) {
    if (goblin.x !== foodTarget.x || goblin.y !== foodTarget.y) {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, foodTarget, grid);
      goblin.x    = next.x;
      goblin.y    = next.y;
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate);
    }
    const here = grid[goblin.y][goblin.x];

    // Contest yield — if a hungrier goblin is on the same tile, let them harvest first.
    // Allies (relation ≥ 60) share peacefully — no contest, no penalty.
    if (goblins) {
      const rival = goblins.find(d =>
        d.alive && d.id !== goblin.id &&
        d.x === goblin.x && d.y === goblin.y &&
        d.hunger > goblin.hunger,
      );
      if (rival) {
        const relation = goblin.relations[rival.id] ?? 50;
        if (relation >= 60) {
          // Ally — yield peacefully, small relation boost for cooperation
          goblin.relations[rival.id] = Math.min(100, relation + 2);
          goblin.task = `sharing tile with ${rival.name}`;
          // Don't step away — just skip harvest this tick so ally eats
          return;
        }
        // Non-ally: contest breeds resentment (mean goblins take it harder)
        const penalty = traitMod(goblin, 'contestPenalty', -5);
        goblin.relations[rival.id] = Math.max(0, relation + penalty);
        // Step away to break the standoff rather than blocking indefinitely
        const escapeDirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
        const escapeOpen = escapeDirs
          .map(d => ({ x: goblin.x + d.dx, y: goblin.y + d.dy }))
          .filter(p => isWalkable(grid, p.x, p.y));
        if (escapeOpen.length > 0) {
          const step = escapeOpen[Math.floor(Math.random() * escapeOpen.length)];
          goblin.x = step.x;
          goblin.y = step.y;
        }
        goblin.task = `yielding to ${rival.name}`;
        return;
      }
    }

    // inventoryFull → skipFoodForage → foodTarget=null, so we only reach this
    // point when there IS headroom.  Re-compute here for the harvest cap.
    const headroom = MAX_INVENTORY_FOOD - goblin.inventory.food;
    if (FORAGEABLE_TILES.has(here.type) && here.foodValue >= 1) {
      // Deplete tile aggressively, but yield less to inventory — encourages exploration
      const depletionRate   = goblin.role === 'forager' ? 6 : 5;
      const baseYield       = goblin.role === 'forager' ? 2 : 1;
      // Morale scales harvest yield: 0.5× at morale 0, 1.0× at morale 100
      const moraleScale     = 0.5 + (goblin.morale / 100) * 0.5;
      // Fatigue > 70 halves harvest yield
      const fatigueScale    = goblin.fatigue > 70 ? 0.5 : 1.0;
      const harvestYield    = Math.max(1, Math.round(baseYield * moraleScale * fatigueScale));
      goblin.fatigue         = Math.min(100, goblin.fatigue + 0.4 * fatigueRate);
      const hadFood         = here.foodValue;
      const depleted        = Math.min(hadFood, depletionRate);
      here.foodValue        = Math.max(0, hadFood - depleted);
      // Fully depleted tile reverts to bare dirt — forces goblins to seek fresh patches.
      // New patches sprout periodically via tickMushroomSprout() in WorldScene.
      if (here.foodValue === 0) { here.type = TileType.Dirt; here.maxFood = 0; }
      const amount          = Math.min(harvestYield, depleted, headroom);
      goblin.inventory.food += amount;
      const label           = goblin.llmIntent === 'forage' ? 'foraging (LLM)' : 'harvesting';
      goblin.task            = `${label} (food: ${goblin.inventory.food.toFixed(0)})`;
    } else {
      const label = goblin.llmIntent === 'forage' ? 'foraging (LLM)' : 'foraging';
      goblin.task  = `${label} → (${foodTarget.x},${foodTarget.y})`;
    }
    return;
  }

  // ── 4.2. Return home to deposit surplus food ──────────────────────────
  // Head to the nearest food stockpile that still has capacity to receive a deposit.
  // Threshold matches step 2.8 (≥ 10 food) so goblins only make the trip
  // when they'll actually deposit on arrival.
  const nearestFoodStockpileWithCapacity = foodStockpiles
    ?.filter(d => d.food < d.maxFood)
    .reduce<FoodStockpile | null>((best, d) => {
      const dist     = Math.abs(d.x - goblin.x) + Math.abs(d.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? d : best;
    }, null) ?? null;
  if (nearestFoodStockpileWithCapacity && goblin.inventory.food >= 10 && goblin.hunger < 55
      && !(goblin.x === nearestFoodStockpileWithCapacity.x && goblin.y === nearestFoodStockpileWithCapacity.y)) {
    const next = pathNextStep(
      { x: goblin.x, y: goblin.y },
      { x: nearestFoodStockpileWithCapacity.x, y: nearestFoodStockpileWithCapacity.y },
      grid,
    );
    goblin.x    = next.x;
    goblin.y    = next.y;
    goblin.task = `→ home (deposit)`;
    return;
  }

  // ── 4.3. Stockpile run — pathfind to nearest food stockpile when hungry ───
  // Fires only when: not on the stockpile, hunger > 65, carrying no food,
  // and some stockpile has stock to give.  Lower priority than foraging.
  const nearestFoodStockpileWithFood = foodStockpiles
    ?.filter(d => d.food > 0)
    .reduce<FoodStockpile | null>((best, d) => {
      const dist     = Math.abs(d.x - goblin.x) + Math.abs(d.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? d : best;
    }, null) ?? null;
  if (nearestFoodStockpileWithFood
      && !(goblin.x === nearestFoodStockpileWithFood.x && goblin.y === nearestFoodStockpileWithFood.y)
      && goblin.hunger > 65 && goblin.inventory.food === 0) {
    const next = pathNextStep(
      { x: goblin.x, y: goblin.y },
      { x: nearestFoodStockpileWithFood.x, y: nearestFoodStockpileWithFood.y },
      grid,
    );
    goblin.x    = next.x;
    goblin.y    = next.y;
    goblin.task = `→ stockpile (${nearestFoodStockpileWithFood.food.toFixed(0)} food)`;
    return;
  }

  // ── 4.3c. Remembered food site ────────────────────────────────────────────
  // When no food is visible, path toward the best-remembered food patch rather
  // than immediately wandering.  On arrival:
  //   • If the representative tile is still harvestable → refresh memory.
  //   • If depleted or tile type changed → scan PATCH_MERGE_RADIUS for any
  //     surviving forageable tile and redirect the patch record to it.
  //   • If the whole patch is gone → evict the entry.
  // This means memory tracks the richest *surviving* tile in a patch, not
  // a single tile that may have been eaten out from under the goblin.
  // Sated miners skip this so they head to ore instead of detouring to food.
  if (!skipFoodForage && goblin.knownFoodSites.length > 0) {
    const best = goblin.knownFoodSites.reduce((a, b) => b.value > a.value ? b : a);
    if (goblin.x === best.x && goblin.y === best.y) {
      // Arrived — check if representative tile is still harvestable
      const tileHere  = grid[goblin.y][goblin.x];
      const stillGood = tileHere.foodValue >= 1 && FORAGEABLE_TILES.has(tileHere.type);
      if (!stillGood) {
        // Scan patch radius for any surviving forageable tile
        let better: ResourceSite | null = null;
        for (let dy = -PATCH_MERGE_RADIUS; dy <= PATCH_MERGE_RADIUS; dy++) {
          for (let dx = -PATCH_MERGE_RADIUS; dx <= PATCH_MERGE_RADIUS; dx++) {
            const nx = best.x + dx;
            const ny = best.y + dy;
            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            const t = grid[ny][nx];
            if (!FORAGEABLE_TILES.has(t.type) || t.foodValue < 1) continue;
            if (!better || t.foodValue > better.value) {
              better = { x: nx, y: ny, value: t.foodValue, tick: currentTick };
            }
          }
        }
        if (better) {
          // Redirect the patch record to the richest surviving tile nearby
          goblin.knownFoodSites = goblin.knownFoodSites.map(
            s => (s.x === best.x && s.y === best.y) ? better! : s,
          );
        } else {
          // Patch exhausted — evict
          goblin.knownFoodSites = goblin.knownFoodSites.filter(
            s => !(s.x === best.x && s.y === best.y),
          );
        }
      } else {
        recordSite(goblin.knownFoodSites, best.x, best.y, tileHere.foodValue, currentTick);
      }
      // Fall through — step 4 will harvest on the next tick if the tile has food
    } else {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, best, grid);
      goblin.x    = next.x;
      goblin.y    = next.y;
      goblin.task = `→ remembered patch`;
      return;
    }
  }

  // ── 4.3b. Miner fort-building ─────────────────────────────────────────
  // Builds two H-shaped rooms (food stockpile room + ore stockpile room) that grow
  // southward as new storage units are added.  Uses 3 ore per wall segment.
  // Find any ore stockpile with enough ore to pay for a wall.
  const buildStockpile = oreStockpiles?.find(s => s.ore >= 3) ?? null;
  if (goblin.role === 'miner' && foodStockpiles && foodStockpiles.length > 0
      && oreStockpiles && oreStockpiles.length > 0 && buildStockpile
      && goblin.hunger < 65) {
    // Inner rooms first; once complete, switch to enclosing the compound
    let wallSlots = fortWallSlots(foodStockpiles, oreStockpiles, grid, goblins, goblin.id, adventurers);
    if (wallSlots.length === 0) {
      wallSlots = fortEnclosureSlots(foodStockpiles, oreStockpiles, grid, goblins, goblin.id, adventurers);
    }

    let nearestSlot: { x: number; y: number } | null = null;
    let nearestDist = Infinity;
    for (const s of wallSlots) {
      const dist = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      if (dist > 0 && dist < nearestDist) { nearestDist = dist; nearestSlot = s; }
    }

    if (nearestSlot) {
      const next = pathNextStep(
        { x: goblin.x, y: goblin.y },
        { x: nearestSlot.x, y: nearestSlot.y },
        grid,
      );
      if (next.x === nearestSlot.x && next.y === nearestSlot.y) {
        const t = grid[nearestSlot.y][nearestSlot.x];
        grid[nearestSlot.y][nearestSlot.x] = {
          ...t,
          type:          TileType.Wall,
          foodValue:     0,
          maxFood:       0,
          materialValue: 0,
          maxMaterial:   0,
          growbackRate:  0,
        };
        buildStockpile.ore -= 3;
        goblin.task = 'built fort wall!';
      } else {
        goblin.x = next.x;
        goblin.y = next.y;
        goblin.task = '→ fort wall';
      }
      return;
    }
  }

  // ── 4.4. Miner ore run — carry mined ore to nearest ore stockpile ────
  // Fires when miner is carrying ≥ 8 ore and some stockpile has capacity.
  const nearestOreStockpileWithCapacity = oreStockpiles
    ?.filter(s => s.ore < s.maxOre)
    .reduce<OreStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
  if (goblin.role === 'miner' && nearestOreStockpileWithCapacity
      && goblin.inventory.materials >= 8
      && !(goblin.x === nearestOreStockpileWithCapacity.x && goblin.y === nearestOreStockpileWithCapacity.y)) {
    const next = pathNextStep(
      { x: goblin.x, y: goblin.y },
      { x: nearestOreStockpileWithCapacity.x, y: nearestOreStockpileWithCapacity.y },
      grid,
    );
    goblin.x    = next.x;
    goblin.y    = next.y;
    goblin.task = `→ ore stockpile (${goblin.inventory.materials.toFixed(0)} ore)`;
    return;
  }

  // ── 4.4b. Lumberjack lumber run — carry chopped wood to nearest wood stockpile ──
  // Fires when lumberjack is carrying ≥ 8 wood and some stockpile has capacity.
  const nearestWoodStockpileWithCapacity = woodStockpiles
    ?.filter(s => s.wood < s.maxWood)
    .reduce<WoodStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - goblin.x) + Math.abs(s.y - goblin.y);
      const bestDist = best ? Math.abs(best.x - goblin.x) + Math.abs(best.y - goblin.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
  if (goblin.role === 'lumberjack' && nearestWoodStockpileWithCapacity
      && goblin.inventory.materials >= 8
      && !(goblin.x === nearestWoodStockpileWithCapacity.x && goblin.y === nearestWoodStockpileWithCapacity.y)) {
    const next = pathNextStep(
      { x: goblin.x, y: goblin.y },
      { x: nearestWoodStockpileWithCapacity.x, y: nearestWoodStockpileWithCapacity.y },
      grid,
    );
    goblin.x    = next.x;
    goblin.y    = next.y;
    goblin.task = `→ wood stockpile (${goblin.inventory.materials.toFixed(0)} wood)`;
    return;
  }

  // ── 4.45. Remembered ore vein (miners) ───────────────────────────────────
  // When no ore is in vision, path toward the best-remembered ore site before
  // resorting to wander.  On arrival: refresh if still rich, scan the patch
  // radius for a surviving neighbour tile if depleted, evict if whole vein gone.
  if (goblin.role === 'miner' && goblin.knownOreSites.length > 0) {
    const best = goblin.knownOreSites.reduce((a, b) => b.value > a.value ? b : a);
    if (goblin.x === best.x && goblin.y === best.y) {
      const mv = grid[goblin.y][goblin.x].type !== TileType.Forest
        ? grid[goblin.y][goblin.x].materialValue : 0;
      if (mv < 1) {
        // Scan patch radius for any surviving ore tile before evicting (skip Forest = wood)
        let better: ResourceSite | null = null;
        for (let dy = -PATCH_MERGE_RADIUS; dy <= PATCH_MERGE_RADIUS; dy++) {
          for (let dx = -PATCH_MERGE_RADIUS; dx <= PATCH_MERGE_RADIUS; dx++) {
            const nx = best.x + dx;
            const ny = best.y + dy;
            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            const t = grid[ny][nx];
            if (t.type === TileType.Forest) continue;  // forest = wood, not ore
            if (t.materialValue < 1) continue;
            if (!better || t.materialValue > better.value) {
              better = { x: nx, y: ny, value: t.materialValue, tick: currentTick };
            }
          }
        }
        if (better) {
          goblin.knownOreSites = goblin.knownOreSites.map(
            s => (s.x === best.x && s.y === best.y) ? better! : s,
          );
        } else {
          goblin.knownOreSites = goblin.knownOreSites.filter(
            s => !(s.x === best.x && s.y === best.y),
          );
        }
      } else if (grid[goblin.y][goblin.x].type !== TileType.Forest) {
        recordSite(goblin.knownOreSites, best.x, best.y, mv, currentTick);
      }
      // Fall through — step 4.5 will mine on the next tick if value remains
    } else {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, best, grid);
      goblin.x    = next.x;
      goblin.y    = next.y;
      goblin.task = `→ remembered ore`;
      return;
    }
  }

  // ── 4.45b. Remembered forest patch (lumberjacks) ─────────────────────
  // Mirrors 4.45 logic for ore but targets forest tiles with wood.
  if (goblin.role === 'lumberjack' && goblin.knownWoodSites.length > 0) {
    const best = goblin.knownWoodSites.reduce((a, b) => b.value > a.value ? b : a);
    if (goblin.x === best.x && goblin.y === best.y) {
      const mv = grid[goblin.y][goblin.x].materialValue;
      if (mv < 1 || grid[goblin.y][goblin.x].type !== TileType.Forest) {
        // Scan patch radius for any surviving forest tile
        let better: ResourceSite | null = null;
        for (let dy = -PATCH_MERGE_RADIUS; dy <= PATCH_MERGE_RADIUS; dy++) {
          for (let dx = -PATCH_MERGE_RADIUS; dx <= PATCH_MERGE_RADIUS; dx++) {
            const nx = best.x + dx;
            const ny = best.y + dy;
            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            const t = grid[ny][nx];
            if (t.type !== TileType.Forest || t.materialValue < 1) continue;
            if (!better || t.materialValue > better.value) {
              better = { x: nx, y: ny, value: t.materialValue, tick: currentTick };
            }
          }
        }
        if (better) {
          goblin.knownWoodSites = goblin.knownWoodSites.map(
            s => (s.x === best.x && s.y === best.y) ? better! : s,
          );
        } else {
          goblin.knownWoodSites = goblin.knownWoodSites.filter(
            s => !(s.x === best.x && s.y === best.y),
          );
        }
      } else {
        recordSite(goblin.knownWoodSites, best.x, best.y, mv, currentTick);
      }
      // Fall through — step 4.5b will chop on the next tick if wood remains
    } else {
      const next = pathNextStep({ x: goblin.x, y: goblin.y }, best, grid);
      goblin.x    = next.x;
      goblin.y    = next.y;
      goblin.task = `→ remembered forest`;
      return;
    }
  }

  // ── 4.5. Miners target ore/material tiles when no food found ──────────
  if (goblin.role === 'miner') {
    const oreTarget = bestMaterialTile(goblin, grid, goblin.vision);
    // Sight-memory: record any rich ore tile currently visible
    if (oreTarget) {
      const mv = grid[oreTarget.y][oreTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownOreSites, oreTarget.x, oreTarget.y, mv, currentTick);
      }
    }
    if (oreTarget) {
      if (goblin.x !== oreTarget.x || goblin.y !== oreTarget.y) {
        const next = pathNextStep({ x: goblin.x, y: goblin.y }, oreTarget, grid);
        goblin.x    = next.x;
        goblin.y    = next.y;
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate);
      }
      const here = grid[goblin.y][goblin.x];
      if (here.materialValue >= 1) {
        const hadMat       = here.materialValue;
        const mined        = Math.min(hadMat, 2);
        here.materialValue = Math.max(0, hadMat - mined);
        // Exhausted ore vein reverts to bare stone — miners must find new veins
        if (here.materialValue === 0) { here.type = TileType.Stone; here.maxMaterial = 0; }
        goblin.inventory.materials = Math.min(
          goblin.inventory.materials + mined, MAX_INVENTORY_FOOD,
        );
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate);
        goblin.task = `mining (ore: ${here.materialValue.toFixed(0)})`;
      } else {
        goblin.task = `mining → (${oreTarget.x},${oreTarget.y})`;
      }
      return;
    }
  }

  // ── 4.5b. Lumberjacks target Forest tiles for wood ───────────────────
  if (goblin.role === 'lumberjack') {
    const woodTarget = bestWoodTile(goblin, grid, goblin.vision);
    // Sight-memory: record any rich forest tile currently visible
    if (woodTarget) {
      const mv = grid[woodTarget.y][woodTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(goblin.knownWoodSites, woodTarget.x, woodTarget.y, mv, currentTick);
      }
    }
    if (woodTarget) {
      if (goblin.x !== woodTarget.x || goblin.y !== woodTarget.y) {
        const next = pathNextStep({ x: goblin.x, y: goblin.y }, woodTarget, grid);
        goblin.x    = next.x;
        goblin.y    = next.y;
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.2 * fatigueRate);
      }
      const here = grid[goblin.y][goblin.x];
      if (here.type === TileType.Forest && here.materialValue >= 1) {
        const hadWood      = here.materialValue;
        const chopped      = Math.min(hadWood, 2);
        here.materialValue = Math.max(0, hadWood - chopped);
        // Forest tile stays as Forest even when wood is depleted — it regrows
        goblin.inventory.materials = Math.min(
          goblin.inventory.materials + chopped, MAX_INVENTORY_FOOD,
        );
        goblin.fatigue = Math.min(100, goblin.fatigue + 0.4 * fatigueRate);
        goblin.task = `logging (wood: ${here.materialValue.toFixed(0)})`;
      } else {
        goblin.task = `→ forest (${woodTarget.x},${woodTarget.y})`;
      }
      return;
    }
  }

  // ── 5. Wander / Avoid ─────────────────────────────────────────────────
  const WANDER_HOLD_TICKS = 25;
  const WANDER_MIN_DIST   = 10;
  const WANDER_MAX_DIST   = 20;

  // 5a. Avoid — maximise distance from nearest rival within 5 tiles
  if (goblin.llmIntent === 'avoid' && goblins) {
    const rival = goblins
      .filter(r => r.alive && r.id !== goblin.id)
      .map(r    => ({ r, dist: Math.abs(r.x - goblin.x) + Math.abs(r.y - goblin.y) }))
      .filter(e  => e.dist <= 5)
      .sort((a, b) => a.dist - b.dist)[0]?.r ?? null;

    if (rival) {
      const avoidDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
      const avoidOpen = avoidDirs
        .map(d => ({ x: goblin.x + d.x, y: goblin.y + d.y }))
        .filter(p => isWalkable(grid, p.x, p.y));
      if (avoidOpen.length > 0) {
        const next = avoidOpen.reduce((best, p) =>
          (Math.abs(p.x - rival.x) + Math.abs(p.y - rival.y)) >
          (Math.abs(best.x - rival.x) + Math.abs(best.y - rival.y)) ? p : best,
        );
        goblin.x    = next.x;
        goblin.y    = next.y;
        goblin.task = `avoiding ${rival.name}`;
      }
      return;
    }
  }

  // 5b. Persistent wander — pathfind toward a far-away waypoint held for
  // WANDER_HOLD_TICKS ticks.  Repick when expired or on arrival.
  // ~25% of the time, drift toward home so goblins naturally loop back to
  // the fort rather than permanently wandering the map's far edge.

  // Invalidate wander target if a wall (or other obstacle) was placed on it
  // since we last set it — prevents goblins from pathfinding into walls.
  if (goblin.wanderTarget && !isWalkable(grid, goblin.wanderTarget.x, goblin.wanderTarget.y)) {
    goblin.wanderTarget = null;
  }

  if (!goblin.wanderTarget || currentTick >= goblin.wanderExpiry
      || (goblin.x === goblin.wanderTarget.x && goblin.y === goblin.wanderTarget.y)) {
    let picked = false;

    // Home drift — pull toward home but aim ±10 tiles out so the target lands
    // well outside the fort perimeter (MARGIN=2 → perimeter ≈ ±4 from depot).
    // Paranoid goblins drift home 50% of the time; others 25%.
    const homeDrift = traitMod(goblin, 'wanderHomeDrift', 0.25);
    if (Math.random() < homeDrift && (goblin.homeTile.x !== 0 || goblin.homeTile.y !== 0)) {
      const hx = goblin.homeTile.x + Math.round((Math.random() - 0.5) * 20);
      const hy = goblin.homeTile.y + Math.round((Math.random() - 0.5) * 20);
      if (hx >= 0 && hx < GRID_SIZE && hy >= 0 && hy < GRID_SIZE && isWalkable(grid, hx, hy)) {
        goblin.wanderTarget = { x: hx, y: hy };
        goblin.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
        picked = true;
      }
    }

    if (!picked) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = WANDER_MIN_DIST + Math.random() * (WANDER_MAX_DIST - WANDER_MIN_DIST);
      const wx    = Math.round(goblin.x + Math.cos(angle) * dist);
      const wy    = Math.round(goblin.y + Math.sin(angle) * dist);
      if (wx >= 0 && wx < GRID_SIZE && wy >= 0 && wy < GRID_SIZE && isWalkable(grid, wx, wy)) {
        goblin.wanderTarget = { x: wx, y: wy };
        goblin.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
        picked = true;
        break;
      }
    }
    }
    if (!picked) {
      // Heavily constrained (surrounded by walls/water) — fall back to random adjacent step
      const fallDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
      const fallOpen = fallDirs
        .map(d => ({ x: goblin.x + d.x, y: goblin.y + d.y }))
        .filter(p => isWalkable(grid, p.x, p.y));
      if (fallOpen.length > 0) {
        const fb = fallOpen[Math.floor(Math.random() * fallOpen.length)];
        goblin.x  = fb.x;
        goblin.y  = fb.y;
      }
      goblin.task = 'wandering';
      return;
    }
  }

  if (!goblin.wanderTarget) { goblin.task = 'idle'; return; }
  const wanderNext = pathNextStep({ x: goblin.x, y: goblin.y }, goblin.wanderTarget, grid);
  goblin.x    = wanderNext.x;
  goblin.y    = wanderNext.y;
  goblin.task = 'exploring';
}
