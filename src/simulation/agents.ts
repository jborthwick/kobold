import * as ROT from 'rot-js';
import { TileType, type Dwarf, type Tile, type DwarfRole, type MemoryEntry, type DwarfTrait, type Depot, type OreStockpile, type Goblin, type ResourceSite, type ColonyGoal } from '../shared/types';
import { GRID_SIZE, INITIAL_DWARVES, DWARF_NAMES, MAX_INVENTORY_FOOD } from '../shared/constants';
import { isWalkable } from './world';

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Resource site memory ───────────────────────────────────────────────────
/** Min tile value worth storing in a dwarf's site memory. */
const SITE_RECORD_THRESHOLD = 3;
/** Max remembered sites per type per dwarf. */
const MAX_KNOWN_SITES = 5;
/**
 * Manhattan radius within which two tiles are treated as the same patch.
 * Prevents a cluster of 10 adjacent mushrooms from burning all 5 memory
 * slots on individual tiles from the same group.
 */
const PATCH_MERGE_RADIUS = 4;

/**
 * Upsert a resource site into a dwarf's memory list.
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
function recordSite(sites: ResourceSite[], x: number, y: number, value: number, tick: number): void {
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

// Tile types dwarves can harvest food from.
// Add entries here to unlock new food sources — no logic changes needed.
const FORAGEABLE_TILES = new Set<TileType>([
  TileType.Mushroom,
]);

// Role assignment order and vision ranges
const ROLE_ORDER: DwarfRole[] = ['forager', 'miner', 'scout', 'forager', 'fighter'];

// ── Trait / bio / goal tables ─────────────────────────────────────────────────
const DWARF_TRAITS: DwarfTrait[] = [
  'lazy', 'forgetful', 'helpful', 'mean', 'paranoid', 'brave', 'greedy', 'cheerful',
];

const DWARF_BIOS: string[] = [
  'is far from home',
  'loves his dog',
  'never learned to swim',
  'has a lucky coin',
  'dreams of becoming a baker',
  'lost a bet that brought him here',
  'is secretly afraid of the dark',
  'left behind a large debt',
  'was exiled from the last colony',
  'heard there is treasure here',
];

const DWARF_GOALS: string[] = [
  'accumulate 50 food before winter',
  'outlive every other dwarf',
  'make at least one true friend',
  'find the richest ore vein',
  'survive the first goblin raid',
  'never go hungry',
  'explore every corner of the map',
  'see the colony reach 10 dwarves',
];
const ROLE_STATS: Record<DwarfRole, { visionMin: number; visionMax: number; maxHealth: number }> = {
  forager: { visionMin: 5, visionMax: 8,  maxHealth: 100 },
  miner:   { visionMin: 4, visionMax: 6,  maxHealth: 100 },
  scout:   { visionMin: 7, visionMax: 12, maxHealth: 100 },
  fighter: { visionMin: 4, visionMax: 7,  maxHealth: 130 },
};

export function spawnDwarves(
  grid:      Tile[][],
  spawnZone: { x: number; y: number; w: number; h: number },
): Dwarf[] {
  const dwarves: Dwarf[] = [];
  for (let i = 0; i < INITIAL_DWARVES; i++) {
    let x: number, y: number;
    do {
      x = spawnZone.x + rand(0, spawnZone.w - 1);
      y = spawnZone.y + rand(0, spawnZone.h - 1);
    } while (!isWalkable(grid, x, y));

    const role  = ROLE_ORDER[i % ROLE_ORDER.length];
    const stats = ROLE_STATS[role];

    dwarves.push({
      id:            `dwarf-${i}`,
      name:          DWARF_NAMES[i % DWARF_NAMES.length],
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
      relations:       {},   // populated lazily as dwarves interact
      trait:           DWARF_TRAITS[Math.floor(Math.random() * DWARF_TRAITS.length)],
      bio:             DWARF_BIOS[Math.floor(Math.random() * DWARF_BIOS.length)],
      goal:            DWARF_GOALS[Math.floor(Math.random() * DWARF_GOALS.length)],
      wanderTarget:    null,
      wanderExpiry:    0,
      knownFoodSites:  [],
      knownOreSites:   [],
      homeTile:        { x: 0, y: 0 },  // overwritten by WorldScene after depot is placed
    });
  }
  return dwarves;
}

// ── Succession ─────────────────────────────────────────────────────────────

/** Ticks before a successor arrives after a death (~43 s at 7 ticks/s). */
export const SUCCESSION_DELAY = 300;

/**
 * Spawn a new dwarf that inherits fragments of the predecessor's memory and
 * (muted) relationships.  Called by WorldScene when a pendingSuccession matures.
 */
export function spawnSuccessor(
  dead:       Dwarf,
  grid:       Tile[][],
  spawnZone:  { x: number; y: number; w: number; h: number },
  allDwarves: Dwarf[],
  tick:       number,
): Dwarf {
  // Pick a name not currently used by any alive dwarf; fall back to "<name> II"
  const aliveNames = new Set(allDwarves.filter(d => d.alive).map(d => d.name));
  const name = DWARF_NAMES.find(n => !aliveNames.has(n))
            ?? `${DWARF_NAMES[rand(0, DWARF_NAMES.length - 1)]} II`;

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

  // Inherit relations muted 40% toward neutral (50)
  const relations: Record<string, number> = {};
  for (const [id2, score] of Object.entries(dead.relations)) {
    relations[id2] = Math.round(50 + (score - 50) * 0.4);
  }

  return {
    id:            `dwarf-${Date.now()}`,
    name,
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
    trait:           DWARF_TRAITS[Math.floor(Math.random() * DWARF_TRAITS.length)],
    bio:             DWARF_BIOS[Math.floor(Math.random() * DWARF_BIOS.length)],
    goal:            DWARF_GOALS[Math.floor(Math.random() * DWARF_GOALS.length)],
    wanderTarget:    null,
    wanderExpiry:    0,
    knownFoodSites:  [],
    knownOreSites:   [],
    homeTile:        { x: 0, y: 0 },  // overwritten by WorldScene after depot is placed
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Scan a square of `radius` tiles around the dwarf for the richest forageable tile. */
function bestFoodTile(
  dwarf:  Dwarf,
  grid:   Tile[][],
  radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 1; // ignore tiles with < 1 food — avoids chasing micro-regrowth fractions

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = dwarf.x + dx;
      const ny = dwarf.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      if (!FORAGEABLE_TILES.has(grid[ny][nx].type)) continue;
      const v = grid[ny][nx].foodValue;
      if (v > bestValue) { bestValue = v; best = { x: nx, y: ny }; }
    }
  }
  return best;
}

/** Scan a square of `radius` tiles around the dwarf for the richest material tile (miners). */
function bestMaterialTile(
  dwarf:  Dwarf,
  grid:   Tile[][],
  radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 1;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = dwarf.x + dx;
      const ny = dwarf.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
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
 * Exported so goblins can share the same pathfinding logic.
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
function fortWallSlots(
  depots:     Array<{ x: number; y: number }>,
  stockpiles: Array<{ x: number; y: number }>,
  grid:       Tile[][],
  dwarves:    Dwarf[] | undefined,
  selfId:     string,
): Array<{ x: number; y: number }> {
  const MARGIN = 2;
  const slots: Array<{ x: number; y: number }> = [];

  const blocked = (x: number, y: number): boolean =>
    dwarves?.some(d => d.alive && d.id !== selfId && d.x === x && d.y === y) ?? false;

  const tryAdd = (x: number, y: number): void => {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
    const t = grid[y][x];
    if (t.type === TileType.Wall || t.type === TileType.Water
        || t.type === TileType.Ore) return;
    if (!blocked(x, y)) slots.push({ x, y });
  };

  const anchorD = depots[0];
  const anchorS = stockpiles[0];

  // ── Depot room perimeter — bounding box across all depot positions ────
  // Rooms grow in any direction as new storage units are placed.
  const dMinX = Math.min(...depots.map(d => d.x)) - MARGIN;
  const dMaxX = Math.max(...depots.map(d => d.x)) + MARGIN;
  const dMinY = Math.min(...depots.map(d => d.y)) - MARGIN;
  const dMaxY = Math.max(...depots.map(d => d.y)) + MARGIN;
  for (let y = dMinY; y <= dMaxY; y++) {
    for (let x = dMinX; x <= dMaxX; x++) {
      if (x !== dMinX && x !== dMaxX && y !== dMinY && y !== dMaxY) continue;
      if (y === dMaxY && Math.abs(x - anchorD.x) <= 1) continue;  // 3-wide south gate
      if (depots.some(d => d.x === x && d.y === y)) continue;     // storage tile itself
      tryAdd(x, y);
    }
  }

  // ── Stockpile room perimeter — bounding box across all stockpile positions
  const sMinX = Math.min(...stockpiles.map(s => s.x)) - MARGIN;
  const sMaxX = Math.max(...stockpiles.map(s => s.x)) + MARGIN;
  const sMinY = Math.min(...stockpiles.map(s => s.y)) - MARGIN;
  const sMaxY = Math.max(...stockpiles.map(s => s.y)) + MARGIN;
  for (let y = sMinY; y <= sMaxY; y++) {
    for (let x = sMinX; x <= sMaxX; x++) {
      if (x !== sMinX && x !== sMaxX && y !== sMinY && y !== sMaxY) continue;
      if (y === sMaxY && Math.abs(x - anchorS.x) <= 1) continue;  // 3-wide south gate
      if (stockpiles.some(s => s.x === x && s.y === y)) continue; // storage tile itself
      tryAdd(x, y);
    }
  }

  // ── Top corridor bar — H cross-piece at the shared top edge ──────────
  const topY    = Math.min(dMinY, sMinY);
  const barXmin = dMaxX + 1;
  const barXmax = sMinX - 1;
  for (let x = barXmin; x <= barXmax; x++) {
    tryAdd(x, topY);
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
  dwarf:       Dwarf,
  grid:        Tile[][],
  currentTick: number,
  dwarves?:    Dwarf[],
  onLog?:      LogFn,
  depots?:     Depot[],
  goblins?:    Goblin[],
  stockpiles?: OreStockpile[],
  colonyGoal?: ColonyGoal,
): void {
  if (!dwarf.alive) return;

  // Hunger grows every tick
  dwarf.hunger = Math.min(100, dwarf.hunger + dwarf.metabolism);

  // Morale decays slowly when hungry, recovers when well-fed
  if (dwarf.hunger > 60) {
    dwarf.morale = Math.max(0,   dwarf.morale - 0.4);
  } else if (dwarf.hunger < 30) {
    dwarf.morale = Math.min(100, dwarf.morale + 0.2);
  }

  // ── 1. Starvation ─────────────────────────────────────────────────────
  if (dwarf.hunger >= 100 && dwarf.inventory.food === 0) {
    dwarf.health -= 2;
    dwarf.morale  = Math.max(0, dwarf.morale - 2);
    dwarf.task    = 'starving!';
    onLog?.(`is starving! (health ${dwarf.health})`, 'warn');
    if (dwarf.health <= 0) {
      dwarf.alive = false;
      dwarf.task  = 'dead';
      onLog?.('has died!', 'error');
      return;
    }
    // Still alive — fall through so they can still move toward food
  }

  // ── 2. Eat from inventory ──────────────────────────────────────────────
  // Threshold at 70 (not 50) so hunger regularly crosses the 65 crisis
  // threshold first — giving the LLM a chance to react before they eat.
  if (dwarf.hunger > 70 && dwarf.inventory.food > 0) {
    const bite        = Math.min(dwarf.inventory.food, 3);
    const oldHunger   = dwarf.hunger;
    dwarf.inventory.food -= bite;
    dwarf.hunger      = Math.max(0, dwarf.hunger - bite * 20);
    dwarf.task        = 'eating';
    return;
  }

  // ── 2.5. Execute LLM intent (eat / rest) ──────────────────────────────
  // 'forage' and 'avoid' are handled in steps 4 / 5 via llmIntent check.
  if (dwarf.llmIntent) {
    if (currentTick > dwarf.llmIntentExpiry) {
      dwarf.llmIntent = null;          // intent expired — clear it
    } else {
      switch (dwarf.llmIntent) {
        case 'eat':
          // Force-eat even below the normal 70-hunger threshold
          if (dwarf.inventory.food > 0 && dwarf.hunger > 30) {
            const bite           = Math.min(dwarf.inventory.food, 3);
            dwarf.inventory.food -= bite;
            dwarf.hunger         = Math.max(0, dwarf.hunger - bite * 20);
            dwarf.task           = 'eating (LLM)';
            return;
          }
          break;
        case 'rest':
          dwarf.task = 'resting';
          return;                      // skip movement entirely
        case 'forage':
        case 'avoid':
        case 'none':
          break;                       // handled in later BT steps
      }
    }
  }

  // ── 2.7. Food sharing ─────────────────────────────────────────────────
  // Well-fed dwarves share 3 food with the hungriest starving neighbor.
  // Donor keeps ≥ 5 food after sharing (8 − 3 = 5).
  if (dwarves && dwarf.inventory.food >= 8) {
    const SHARE_RADIUS = 2;
    const needy = dwarves
      .filter(d =>
        d.alive && d.id !== dwarf.id &&
        Math.abs(d.x - dwarf.x) <= SHARE_RADIUS &&
        Math.abs(d.y - dwarf.y) <= SHARE_RADIUS &&
        d.hunger > 60 && d.inventory.food < 3,
      )
      .sort((a, b) => b.hunger - a.hunger)[0] ?? null;
    if (needy) {
      const gift = 3;
      dwarf.inventory.food -= gift;
      needy.inventory.food  = Math.min(MAX_INVENTORY_FOOD, needy.inventory.food + gift);
      // Sharing builds positive ties: giver +10, recipient +15
      dwarf.relations[needy.id] = Math.min(100, (dwarf.relations[needy.id] ?? 50) + 10);
      needy.relations[dwarf.id] = Math.min(100, (needy.relations[dwarf.id] ?? 50) + 15);
      dwarf.task = `sharing food → ${needy.name}`;
      onLog?.(`shared ${gift} food with ${needy.name} (hunger ${needy.hunger.toFixed(0)})`, 'info');
      dwarf.memory.push({ tick: currentTick, crisis: 'food_sharing', action: `shared ${gift} food with ${needy.name}` });
      needy.memory.push({ tick: currentTick, crisis: 'food_sharing', action: `received ${gift} food from ${dwarf.name}` });
      return;
    }
  }

  // ── 2.8. Depot deposit / withdraw ─────────────────────────────────────
  // When standing on any depot tile: deposit surplus food or withdraw if hungry.
  const standingDepot = depots?.find(d => d.x === dwarf.x && d.y === dwarf.y) ?? null;
  if (standingDepot) {
    if (dwarf.inventory.food >= 10) {
      const amount = dwarf.inventory.food - 6;
      const stored = Math.min(amount, standingDepot.maxFood - standingDepot.food);
      if (stored > 0) {
        standingDepot.food   += stored;
        dwarf.inventory.food -= stored;
        dwarf.task            = `deposited ${stored.toFixed(0)} → depot`;
        return;
      }
    }
    if (dwarf.hunger > 60 && dwarf.inventory.food < 2 && standingDepot.food > 0) {
      const amount         = Math.min(4, standingDepot.food);
      standingDepot.food  -= amount;
      dwarf.inventory.food = Math.min(MAX_INVENTORY_FOOD, dwarf.inventory.food + amount);
      dwarf.task           = `withdrew ${amount.toFixed(0)} from depot`;
      return;
    }
  }

  // ── 2.9. Ore stockpile deposit ────────────────────────────────────────
  // Miners standing on any stockpile tile deposit all carried ore.
  const standingStockpile = stockpiles?.find(s => s.x === dwarf.x && s.y === dwarf.y) ?? null;
  if (dwarf.role === 'miner' && standingStockpile && dwarf.inventory.materials > 0) {
    const stored = Math.min(dwarf.inventory.materials, standingStockpile.maxOre - standingStockpile.ore);
    if (stored > 0) {
      standingStockpile.ore     += stored;
      dwarf.inventory.materials -= stored;
      dwarf.task                 = `deposited ${stored.toFixed(0)} ore → stockpile`;
      return;
    }
  }

  // ── 3. Follow player command ───────────────────────────────────────────
  // Player commands take priority over autonomous harvesting so right-click
  // actually moves the dwarf without interruption.
  if (dwarf.commandTarget) {
    const { x: tx, y: ty } = dwarf.commandTarget;
    if (dwarf.x === tx && dwarf.y === ty) {
      onLog?.(`arrived at (${tx},${ty})`, 'info');
      dwarf.commandTarget = null;
      dwarf.task          = 'arrived';
    } else {
      const next = pathNextStep({ x: dwarf.x, y: dwarf.y }, dwarf.commandTarget, grid);
      dwarf.x    = next.x;
      dwarf.y    = next.y;
      dwarf.task = `→ (${tx},${ty})`;
    }
    return;
  }

  // ── 3.5. Fighter — hunt nearest goblin within vision×2 ──────────────────
  // Fires only when there are goblins nearby and the LLM hasn't ordered rest.
  // Fighter moves toward the closest goblin; when on the same tile the goblin
  // will deal/receive combat damage in tickGoblins (18 hp per hit vs 8 for others).
  // Fighters abandon the hunt when too hungry — survival trumps combat.
  if (dwarf.role === 'fighter' && goblins && goblins.length > 0
      && dwarf.hunger < 65 && dwarf.llmIntent !== 'rest') {
    const HUNT_RADIUS = dwarf.vision * 2;
    const nearest = goblins.reduce<{ g: Goblin; dist: number } | null>((best, g) => {
      const dist = Math.abs(g.x - dwarf.x) + Math.abs(g.y - dwarf.y);
      return (!best || dist < best.dist) ? { g, dist } : best;
    }, null);
    if (nearest && nearest.dist <= HUNT_RADIUS) {
      if (nearest.dist > 0) {
        // First step
        const step1 = pathNextStep(
          { x: dwarf.x, y: dwarf.y },
          { x: nearest.g.x, y: nearest.g.y },
          grid,
        );
        dwarf.x = step1.x;
        dwarf.y = step1.y;
        // Sprint — take a second step so fighters reliably close on fleeing goblins
        const step2 = pathNextStep(
          { x: dwarf.x, y: dwarf.y },
          { x: nearest.g.x, y: nearest.g.y },
          grid,
        );
        dwarf.x = step2.x;
        dwarf.y = step2.y;
      }
      const distAfterMove = Math.abs(nearest.g.x - dwarf.x) + Math.abs(nearest.g.y - dwarf.y);
      dwarf.task = distAfterMove === 0
        ? 'fighting goblin!'
        : `→ goblin (${distAfterMove} tiles)`;
      return;
    }
  }

  // ── 4. Forage + harvest (Sugarscape rule) ─────────────────────────────
  // Each tick: move toward the richest food tile, then harvest wherever
  // you land.  Scan radius scales with desperation so dwarves search wider
  // even without LLM enabled.  LLM 'forage' intent pins it to the max (15).
  //   normal            → dwarf.vision
  //   hungry (> 65)     → min(vision × 2, 15)   ← deterministic, no LLM needed
  //   LLM intent forage → 15
  // Miners skip food foraging when not yet hungry — they prefer to mine.
  // Below hunger 50 they fall straight through to ore-related BT steps.
  // Dwarves with a full inventory also skip — step 4.2 handles depot routing,
  // and step 5 wander (with its 25% home-drift) handles the depot-full case.
  // This prevents the fill-up → rush-to-food → fill-up loop.
  const inventoryFull  = dwarf.inventory.food >= MAX_INVENTORY_FOOD;
  const skipFoodForage = inventoryFull
    || (dwarf.role === 'miner' && dwarf.hunger < 50 && dwarf.llmIntent !== 'forage');
  const radius = dwarf.llmIntent === 'forage' ? 15
    : dwarf.hunger > 65 ? Math.min(dwarf.vision * 2, 15)
    : dwarf.vision;
  const foodTarget = skipFoodForage ? null : bestFoodTile(dwarf, grid, radius);
  // Sight-memory: record any rich food tile the dwarf can currently see
  if (foodTarget) {
    const tv = grid[foodTarget.y][foodTarget.x].foodValue;
    if (tv >= SITE_RECORD_THRESHOLD) {
      recordSite(dwarf.knownFoodSites, foodTarget.x, foodTarget.y, tv, currentTick);
    }
  }
  if (foodTarget) {
    if (dwarf.x !== foodTarget.x || dwarf.y !== foodTarget.y) {
      const next = pathNextStep({ x: dwarf.x, y: dwarf.y }, foodTarget, grid);
      dwarf.x    = next.x;
      dwarf.y    = next.y;
    }
    const here = grid[dwarf.y][dwarf.x];

    // Contest yield — if a hungrier dwarf is on the same tile, let them harvest first
    if (dwarves) {
      const rival = dwarves.find(d =>
        d.alive && d.id !== dwarf.id &&
        d.x === dwarf.x && d.y === dwarf.y &&
        d.hunger > dwarf.hunger,
      );
      if (rival) {
        // Losing a resource contest breeds mild resentment
        dwarf.relations[rival.id] = Math.max(0, (dwarf.relations[rival.id] ?? 50) - 5);
        // Step away to break the standoff rather than blocking indefinitely
        const escapeDirs = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
        const escapeOpen = escapeDirs
          .map(d => ({ x: dwarf.x + d.dx, y: dwarf.y + d.dy }))
          .filter(p => isWalkable(grid, p.x, p.y));
        if (escapeOpen.length > 0) {
          const step = escapeOpen[Math.floor(Math.random() * escapeOpen.length)];
          dwarf.x = step.x;
          dwarf.y = step.y;
        }
        dwarf.task = `yielding to ${rival.name}`;
        return;
      }
    }

    // inventoryFull → skipFoodForage → foodTarget=null, so we only reach this
    // point when there IS headroom.  Re-compute here for the harvest cap.
    const headroom = MAX_INVENTORY_FOOD - dwarf.inventory.food;
    if (FORAGEABLE_TILES.has(here.type) && here.foodValue >= 1) {
      // Deplete tile aggressively, but yield less to inventory — encourages exploration
      const depletionRate   = dwarf.role === 'forager' ? 6 : 5;
      const harvestYield    = dwarf.role === 'forager' ? 2 : 1;
      const hadFood         = here.foodValue;
      const depleted        = Math.min(hadFood, depletionRate);
      here.foodValue        = Math.max(0, hadFood - depleted);
      const amount          = Math.min(harvestYield, depleted, headroom);
      dwarf.inventory.food += amount;
      const label           = dwarf.llmIntent === 'forage' ? 'foraging (LLM)' : 'harvesting';
      dwarf.task            = `${label} (food: ${dwarf.inventory.food.toFixed(0)})`;
    } else {
      const label = dwarf.llmIntent === 'forage' ? 'foraging (LLM)' : 'foraging';
      dwarf.task  = `${label} → (${foodTarget.x},${foodTarget.y})`;
    }
    return;
  }

  // ── 4.2. Return home to deposit surplus food ──────────────────────────
  // Head to the nearest depot that still has capacity to receive a deposit.
  // Threshold matches step 2.8 (≥ 10 food) so dwarves only make the trip
  // when they'll actually deposit on arrival.
  const nearestDepotWithCapacity = depots
    ?.filter(d => d.food < d.maxFood)
    .reduce<Depot | null>((best, d) => {
      const dist     = Math.abs(d.x - dwarf.x) + Math.abs(d.y - dwarf.y);
      const bestDist = best ? Math.abs(best.x - dwarf.x) + Math.abs(best.y - dwarf.y) : Infinity;
      return dist < bestDist ? d : best;
    }, null) ?? null;
  if (nearestDepotWithCapacity && dwarf.inventory.food >= 10 && dwarf.hunger < 55
      && !(dwarf.x === nearestDepotWithCapacity.x && dwarf.y === nearestDepotWithCapacity.y)) {
    const next = pathNextStep(
      { x: dwarf.x, y: dwarf.y },
      { x: nearestDepotWithCapacity.x, y: nearestDepotWithCapacity.y },
      grid,
    );
    dwarf.x    = next.x;
    dwarf.y    = next.y;
    dwarf.task = `→ home (deposit)`;
    return;
  }

  // ── 4.3. Depot run — pathfind to nearest depot with food when hungry ───
  // Fires only when: not on the depot, hunger > 65, carrying no food,
  // and some depot has stock to give.  Lower priority than foraging.
  const nearestDepotWithFood = depots
    ?.filter(d => d.food > 0)
    .reduce<Depot | null>((best, d) => {
      const dist     = Math.abs(d.x - dwarf.x) + Math.abs(d.y - dwarf.y);
      const bestDist = best ? Math.abs(best.x - dwarf.x) + Math.abs(best.y - dwarf.y) : Infinity;
      return dist < bestDist ? d : best;
    }, null) ?? null;
  if (nearestDepotWithFood
      && !(dwarf.x === nearestDepotWithFood.x && dwarf.y === nearestDepotWithFood.y)
      && dwarf.hunger > 65 && dwarf.inventory.food === 0) {
    const next = pathNextStep(
      { x: dwarf.x, y: dwarf.y },
      { x: nearestDepotWithFood.x, y: nearestDepotWithFood.y },
      grid,
    );
    dwarf.x    = next.x;
    dwarf.y    = next.y;
    dwarf.task = `→ depot (${nearestDepotWithFood.food.toFixed(0)} food)`;
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
  // a single tile that may have been eaten out from under the dwarf.
  // Sated miners skip this so they head to ore instead of detouring to food.
  if (!skipFoodForage && dwarf.knownFoodSites.length > 0) {
    const best = dwarf.knownFoodSites.reduce((a, b) => b.value > a.value ? b : a);
    if (dwarf.x === best.x && dwarf.y === best.y) {
      // Arrived — check if representative tile is still harvestable
      const tileHere  = grid[dwarf.y][dwarf.x];
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
          dwarf.knownFoodSites = dwarf.knownFoodSites.map(
            s => (s.x === best.x && s.y === best.y) ? better! : s,
          );
        } else {
          // Patch exhausted — evict
          dwarf.knownFoodSites = dwarf.knownFoodSites.filter(
            s => !(s.x === best.x && s.y === best.y),
          );
        }
      } else {
        recordSite(dwarf.knownFoodSites, best.x, best.y, tileHere.foodValue, currentTick);
      }
      // Fall through — step 4 will harvest on the next tick if the tile has food
    } else {
      const next = pathNextStep({ x: dwarf.x, y: dwarf.y }, best, grid);
      dwarf.x    = next.x;
      dwarf.y    = next.y;
      dwarf.task = `→ remembered patch`;
      return;
    }
  }

  // ── 4.3b. Miner fort-building ─────────────────────────────────────────
  // Builds two H-shaped rooms (depot room + stockpile room) that grow
  // southward as new storage units are added.  Uses 3 ore per wall segment.
  // Find any stockpile with enough ore to pay for a wall.
  const buildStockpile = stockpiles?.find(s => s.ore >= 3) ?? null;
  if (dwarf.role === 'miner' && depots && depots.length > 0
      && stockpiles && stockpiles.length > 0 && buildStockpile
      && dwarf.hunger < 65 && dwarf.llmIntent !== 'rest') {
    const slots = fortWallSlots(depots, stockpiles, grid, dwarves, dwarf.id);

    let nearestSlot: { x: number; y: number } | null = null;
    let nearestDist = Infinity;
    for (const s of slots) {
      const dist = Math.abs(s.x - dwarf.x) + Math.abs(s.y - dwarf.y);
      if (dist > 0 && dist < nearestDist) { nearestDist = dist; nearestSlot = s; }
    }

    if (nearestSlot) {
      const next = pathNextStep(
        { x: dwarf.x, y: dwarf.y },
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
        dwarf.task = 'built fort wall!';
      } else {
        dwarf.x = next.x;
        dwarf.y = next.y;
        dwarf.task = '→ fort wall';
      }
      return;
    }
  }

  // ── 4.4. Miner ore run — carry mined ore to nearest stockpile ─────────
  // Fires when miner is carrying ≥ 8 ore and some stockpile has capacity.
  const nearestStockpileWithCapacity = stockpiles
    ?.filter(s => s.ore < s.maxOre)
    .reduce<OreStockpile | null>((best, s) => {
      const dist     = Math.abs(s.x - dwarf.x) + Math.abs(s.y - dwarf.y);
      const bestDist = best ? Math.abs(best.x - dwarf.x) + Math.abs(best.y - dwarf.y) : Infinity;
      return dist < bestDist ? s : best;
    }, null) ?? null;
  if (dwarf.role === 'miner' && nearestStockpileWithCapacity
      && dwarf.inventory.materials >= 8
      && !(dwarf.x === nearestStockpileWithCapacity.x && dwarf.y === nearestStockpileWithCapacity.y)) {
    const next = pathNextStep(
      { x: dwarf.x, y: dwarf.y },
      { x: nearestStockpileWithCapacity.x, y: nearestStockpileWithCapacity.y },
      grid,
    );
    dwarf.x    = next.x;
    dwarf.y    = next.y;
    dwarf.task = `→ stockpile (${dwarf.inventory.materials.toFixed(0)} ore)`;
    return;
  }

  // ── 4.45. Remembered ore vein (miners) ───────────────────────────────────
  // When no ore is in vision, path toward the best-remembered ore site before
  // resorting to wander.  On arrival: refresh if still rich, scan the patch
  // radius for a surviving neighbour tile if depleted, evict if whole vein gone.
  if (dwarf.role === 'miner' && dwarf.knownOreSites.length > 0) {
    const best = dwarf.knownOreSites.reduce((a, b) => b.value > a.value ? b : a);
    if (dwarf.x === best.x && dwarf.y === best.y) {
      const mv = grid[dwarf.y][dwarf.x].materialValue;
      if (mv < 1) {
        // Scan patch radius for any surviving ore tile before evicting
        let better: ResourceSite | null = null;
        for (let dy = -PATCH_MERGE_RADIUS; dy <= PATCH_MERGE_RADIUS; dy++) {
          for (let dx = -PATCH_MERGE_RADIUS; dx <= PATCH_MERGE_RADIUS; dx++) {
            const nx = best.x + dx;
            const ny = best.y + dy;
            if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
            const t = grid[ny][nx];
            if (t.materialValue < 1) continue;
            if (!better || t.materialValue > better.value) {
              better = { x: nx, y: ny, value: t.materialValue, tick: currentTick };
            }
          }
        }
        if (better) {
          dwarf.knownOreSites = dwarf.knownOreSites.map(
            s => (s.x === best.x && s.y === best.y) ? better! : s,
          );
        } else {
          dwarf.knownOreSites = dwarf.knownOreSites.filter(
            s => !(s.x === best.x && s.y === best.y),
          );
        }
      } else {
        recordSite(dwarf.knownOreSites, best.x, best.y, mv, currentTick);
      }
      // Fall through — step 4.5 will mine on the next tick if value remains
    } else {
      const next = pathNextStep({ x: dwarf.x, y: dwarf.y }, best, grid);
      dwarf.x    = next.x;
      dwarf.y    = next.y;
      dwarf.task = `→ remembered ore`;
      return;
    }
  }

  // ── 4.5. Miners target ore/material tiles when no food found ──────────
  if (dwarf.role === 'miner') {
    const oreTarget = bestMaterialTile(dwarf, grid, dwarf.vision);
    // Sight-memory: record any rich ore tile currently visible
    if (oreTarget) {
      const mv = grid[oreTarget.y][oreTarget.x].materialValue;
      if (mv >= SITE_RECORD_THRESHOLD) {
        recordSite(dwarf.knownOreSites, oreTarget.x, oreTarget.y, mv, currentTick);
      }
    }
    if (oreTarget) {
      if (dwarf.x !== oreTarget.x || dwarf.y !== oreTarget.y) {
        const next = pathNextStep({ x: dwarf.x, y: dwarf.y }, oreTarget, grid);
        dwarf.x    = next.x;
        dwarf.y    = next.y;
      }
      const here = grid[dwarf.y][dwarf.x];
      if (here.materialValue >= 1) {
        const hadMat       = here.materialValue;
        const mined        = Math.min(hadMat, 2);
        here.materialValue = Math.max(0, hadMat - mined);
        dwarf.inventory.materials = Math.min(
          dwarf.inventory.materials + mined, MAX_INVENTORY_FOOD,
        );
        dwarf.task = `mining (ore: ${here.materialValue.toFixed(0)})`;
      } else {
        dwarf.task = `mining → (${oreTarget.x},${oreTarget.y})`;
      }
      return;
    }
  }

  // ── 5. Wander / Avoid ─────────────────────────────────────────────────
  const WANDER_HOLD_TICKS = 25;
  const WANDER_MIN_DIST   = 10;
  const WANDER_MAX_DIST   = 20;

  // 5a. Avoid — maximise distance from nearest rival within 5 tiles
  if (dwarf.llmIntent === 'avoid' && dwarves) {
    const rival = dwarves
      .filter(r => r.alive && r.id !== dwarf.id)
      .map(r    => ({ r, dist: Math.abs(r.x - dwarf.x) + Math.abs(r.y - dwarf.y) }))
      .filter(e  => e.dist <= 5)
      .sort((a, b) => a.dist - b.dist)[0]?.r ?? null;

    if (rival) {
      const avoidDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
      const avoidOpen = avoidDirs
        .map(d => ({ x: dwarf.x + d.x, y: dwarf.y + d.y }))
        .filter(p => isWalkable(grid, p.x, p.y));
      if (avoidOpen.length > 0) {
        const next = avoidOpen.reduce((best, p) =>
          (Math.abs(p.x - rival.x) + Math.abs(p.y - rival.y)) >
          (Math.abs(best.x - rival.x) + Math.abs(best.y - rival.y)) ? p : best,
        );
        dwarf.x    = next.x;
        dwarf.y    = next.y;
        dwarf.task = `avoiding ${rival.name}`;
      }
      return;
    }
  }

  // 5b. Persistent wander — pathfind toward a far-away waypoint held for
  // WANDER_HOLD_TICKS ticks.  Repick when expired or on arrival.
  // ~25% of the time, drift toward home so dwarves naturally loop back to
  // the fort rather than permanently wandering the map's far edge.

  // Invalidate wander target if a wall (or other obstacle) was placed on it
  // since we last set it — prevents dwarves from pathfinding into walls.
  if (dwarf.wanderTarget && !isWalkable(grid, dwarf.wanderTarget.x, dwarf.wanderTarget.y)) {
    dwarf.wanderTarget = null;
  }

  if (!dwarf.wanderTarget || currentTick >= dwarf.wanderExpiry
      || (dwarf.x === dwarf.wanderTarget.x && dwarf.y === dwarf.wanderTarget.y)) {
    let picked = false;

    // Home drift — pull toward home but aim ±10 tiles out so the target lands
    // well outside the fort perimeter (MARGIN=2 → perimeter ≈ ±4 from depot).
    if (Math.random() < 0.25 && (dwarf.homeTile.x !== 0 || dwarf.homeTile.y !== 0)) {
      const hx = dwarf.homeTile.x + Math.round((Math.random() - 0.5) * 20);
      const hy = dwarf.homeTile.y + Math.round((Math.random() - 0.5) * 20);
      if (hx >= 0 && hx < GRID_SIZE && hy >= 0 && hy < GRID_SIZE && isWalkable(grid, hx, hy)) {
        dwarf.wanderTarget = { x: hx, y: hy };
        dwarf.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
        picked = true;
      }
    }

    if (!picked) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = WANDER_MIN_DIST + Math.random() * (WANDER_MAX_DIST - WANDER_MIN_DIST);
      const wx    = Math.round(dwarf.x + Math.cos(angle) * dist);
      const wy    = Math.round(dwarf.y + Math.sin(angle) * dist);
      if (wx >= 0 && wx < GRID_SIZE && wy >= 0 && wy < GRID_SIZE && isWalkable(grid, wx, wy)) {
        dwarf.wanderTarget = { x: wx, y: wy };
        dwarf.wanderExpiry = currentTick + WANDER_HOLD_TICKS;
        picked = true;
        break;
      }
    }
    }
    if (!picked) {
      // Heavily constrained (surrounded by walls/water) — fall back to random adjacent step
      const fallDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
      const fallOpen = fallDirs
        .map(d => ({ x: dwarf.x + d.x, y: dwarf.y + d.y }))
        .filter(p => isWalkable(grid, p.x, p.y));
      if (fallOpen.length > 0) {
        const fb = fallOpen[Math.floor(Math.random() * fallOpen.length)];
        dwarf.x  = fb.x;
        dwarf.y  = fb.y;
      }
      dwarf.task = 'wandering';
      return;
    }
  }

  const wanderNext = pathNextStep({ x: dwarf.x, y: dwarf.y }, dwarf.wanderTarget, grid);
  dwarf.x    = wanderNext.x;
  dwarf.y    = wanderNext.y;
  dwarf.task = 'exploring';
}
