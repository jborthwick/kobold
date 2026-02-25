import * as ROT from 'rot-js';
import { TileType, type Dwarf, type Tile, type DwarfRole, type MemoryEntry, type DwarfTrait, type Depot, type OreStockpile, type Goblin } from '../shared/types';
import { GRID_SIZE, INITIAL_DWARVES, DWARF_NAMES, MAX_INVENTORY_FOOD } from '../shared/constants';
import { isWalkable } from './world';

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
  forager: { visionMin: 4, visionMax: 6, maxHealth: 100 },
  miner:   { visionMin: 2, visionMax: 4, maxHealth: 100 },
  scout:   { visionMin: 5, visionMax: 8, maxHealth: 100 },
  fighter: { visionMin: 3, visionMax: 5, maxHealth: 130 },
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

// ── Behavior Tree ──────────────────────────────────────────────────────────
// Priority cascade (highest first):
//   1.  Starvation damage / death
//   2.  Eat from inventory (hunger > 70)
//   2.5 Execute LLM intent: eat (force-eat), rest (stay put)
//       'forage' and 'avoid' are handled in steps 4/5
//   3.  Follow player commandTarget  ← player commands override harvesting
//   4.  Forage + harvest (Sugarscape rule): move toward richest food tile;
//       radius extends to 10 when llmIntent === 'forage'
//   5.  Wander (or avoid rival when llmIntent === 'avoid')

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

export function tickAgent(
  dwarf:       Dwarf,
  grid:        Tile[][],
  currentTick: number,
  dwarves?:    Dwarf[],
  onLog?:      LogFn,
  depot?:      Depot,
  goblins?:    Goblin[],
  stockpile?:  OreStockpile,
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
    onLog?.(`ate ${bite} food (hunger ${oldHunger.toFixed(0)} → ${dwarf.hunger.toFixed(0)})`, 'info');
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
  // When the dwarf is standing on the depot tile: deposit surplus food/ore or
  // withdraw food if hungry and running low.
  if (depot && dwarf.x === depot.x && dwarf.y === depot.y) {
    if (dwarf.inventory.food >= 10) {
      // Deposit excess food — keep 6 in hand
      const amount = dwarf.inventory.food - 6;
      const stored = Math.min(amount, depot.maxFood - depot.food);
      if (stored > 0) {
        depot.food           += stored;
        dwarf.inventory.food -= stored;
        dwarf.task            = `deposited ${stored.toFixed(0)} → depot`;
        onLog?.(`deposited ${stored.toFixed(0)} food at depot`, 'info');
        return;
      }
    }
    if (dwarf.hunger > 60 && dwarf.inventory.food < 2 && depot.food > 0) {
      // Withdraw up to 4 units of food
      const amount         = Math.min(4, depot.food);
      depot.food          -= amount;
      dwarf.inventory.food = Math.min(MAX_INVENTORY_FOOD, dwarf.inventory.food + amount);
      dwarf.task           = `withdrew ${amount.toFixed(0)} from depot`;
      onLog?.(`withdrew ${amount.toFixed(0)} food from depot`, 'info');
      return;
    }
  }

  // ── 2.9. Ore stockpile deposit ────────────────────────────────────────
  // Miners standing on the ore stockpile tile deposit all carried ore.
  if (stockpile && dwarf.role === 'miner'
      && dwarf.x === stockpile.x && dwarf.y === stockpile.y
      && dwarf.inventory.materials > 0) {
    const stored = Math.min(dwarf.inventory.materials, stockpile.maxOre - stockpile.ore);
    if (stored > 0) {
      stockpile.ore             += stored;
      dwarf.inventory.materials -= stored;
      dwarf.task                 = `deposited ${stored.toFixed(0)} ore → stockpile`;
      onLog?.(`deposited ${stored.toFixed(0)} ore at stockpile`, 'info');
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
  if (dwarf.role === 'fighter' && goblins && goblins.length > 0
      && dwarf.llmIntent !== 'rest') {
    const HUNT_RADIUS = dwarf.vision * 2;
    const nearest = goblins.reduce<{ g: Goblin; dist: number } | null>((best, g) => {
      const dist = Math.abs(g.x - dwarf.x) + Math.abs(g.y - dwarf.y);
      return (!best || dist < best.dist) ? { g, dist } : best;
    }, null);
    if (nearest && nearest.dist <= HUNT_RADIUS) {
      if (nearest.dist > 0) {
        const next = pathNextStep(
          { x: dwarf.x, y: dwarf.y },
          { x: nearest.g.x, y: nearest.g.y },
          grid,
        );
        dwarf.x = next.x;
        dwarf.y = next.y;
      }
      dwarf.task = nearest.dist === 0
        ? 'fighting goblin!'
        : `→ goblin (${nearest.dist} tiles)`;
      return;
    }
  }

  // ── 4. Forage + harvest (Sugarscape rule) ─────────────────────────────
  // Each tick: move toward the richest food tile, then harvest wherever
  // you land.  When the LLM sets intent 'forage', scan a 10-tile global
  // radius instead of normal vision so the dwarf seeks the best food
  // even if it's outside their sight range.
  const radius     = dwarf.llmIntent === 'forage' ? 10 : dwarf.vision;
  const foodTarget = bestFoodTile(dwarf, grid, radius);
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
        dwarf.task = `yielding to ${rival.name}`;
        return;
      }
    }

    const headroom = MAX_INVENTORY_FOOD - dwarf.inventory.food;
    if (FORAGEABLE_TILES.has(here.type) && here.foodValue >= 1 && headroom > 0) {
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
    } else if (headroom <= 0) {
      dwarf.task = 'inventory full';
    } else {
      const label = dwarf.llmIntent === 'forage' ? 'foraging (LLM)' : 'foraging';
      dwarf.task  = `${label} → (${foodTarget.x},${foodTarget.y})`;
    }
    return;
  }

  // ── 4.3. Depot run — pathfind to depot when hungry and empty-handed ────
  // Fires only when: not on the depot, hunger > 65, carrying no food,
  // and the depot has something to give.  Lower priority than foraging so
  // dwarves stay self-sufficient; higher than ore mining.
  if (depot && !(dwarf.x === depot.x && dwarf.y === depot.y)
      && dwarf.hunger > 65 && dwarf.inventory.food === 0 && depot.food > 0) {
    const next = pathNextStep({ x: dwarf.x, y: dwarf.y }, { x: depot.x, y: depot.y }, grid);
    dwarf.x    = next.x;
    dwarf.y    = next.y;
    dwarf.task = `→ depot (${depot.food.toFixed(0)} food)`;
    return;
  }

  // ── 4.3b. Miner fort-building — place walls enclosing depot + stockpile ──
  // Builds a rectangular perimeter around both buildings with a MARGIN-tile
  // border. A 3-tile south gate at the bottom-center stays open permanently.
  // Uses 3 stockpile.ore per wall segment.
  if (dwarf.role === 'miner' && depot && stockpile && stockpile.ore >= 3
      && dwarf.hunger < 65 && dwarf.llmIntent !== 'rest') {
    const MARGIN = 2;
    const x0 = Math.min(depot.x, stockpile.x) - MARGIN;
    const x1 = Math.max(depot.x, stockpile.x) + MARGIN;
    const y0 = Math.min(depot.y, stockpile.y) - MARGIN;
    const y1 = Math.max(depot.y, stockpile.y) + MARGIN;
    // Gate: 3-tile opening at south-center of the enclosure
    const gateCx = Math.floor((depot.x + stockpile.x) / 2);

    let nearestSlot: { x: number; y: number } | null = null;
    let nearestDist = Infinity;
    for (let by = y0; by <= y1; by++) {
      for (let bx = x0; bx <= x1; bx++) {
        if (bx !== x0 && bx !== x1 && by !== y0 && by !== y1) continue; // perimeter only
        if (bx < 0 || bx >= GRID_SIZE || by < 0 || by >= GRID_SIZE) continue;
        // South gate: 3-tile opening at bottom-center of the enclosure
        if (by === y1 && Math.abs(bx - gateCx) <= 1) continue;
        // Never build on the depot or stockpile tiles
        if (bx === depot.x && by === depot.y) continue;
        if (bx === stockpile.x && by === stockpile.y) continue;
        const t = grid[by][bx];
        if (t.type === TileType.Wall || t.type === TileType.Water
            || t.type === TileType.Ore) continue; // don't wall over ore or water
        const dist = Math.abs(bx - dwarf.x) + Math.abs(by - dwarf.y);
        if (dist > 0 && dist < nearestDist) { nearestDist = dist; nearestSlot = { x: bx, y: by }; }
      }
    }

    if (nearestSlot) {
      const next = pathNextStep(
        { x: dwarf.x, y: dwarf.y },
        { x: nearestSlot.x, y: nearestSlot.y },
        grid,
      );
      if (next.x === nearestSlot.x && next.y === nearestSlot.y) {
        // pathNextStep would step onto the build tile — build it instead
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
        stockpile.ore -= 3;
        dwarf.task = 'built fort wall!';
        dwarf.memory.push({ tick: currentTick, crisis: 'construction', action: 'built a fort wall section' });
        onLog?.('built a fort wall section!', 'info');
      } else {
        dwarf.x = next.x;
        dwarf.y = next.y;
        dwarf.task = '→ fort wall';
      }
      return;
    }
  }

  // ── 4.4. Miner ore run — carry mined ore to the ore stockpile ─────────
  // Fires when miner is carrying ≥ 8 ore, not yet at the stockpile tile,
  // and the stockpile has capacity. Lower priority than food foraging.
  if (dwarf.role === 'miner' && stockpile
      && dwarf.inventory.materials >= 8
      && !(dwarf.x === stockpile.x && dwarf.y === stockpile.y)
      && stockpile.ore < stockpile.maxOre) {
    const next = pathNextStep({ x: dwarf.x, y: dwarf.y }, { x: stockpile.x, y: stockpile.y }, grid);
    dwarf.x    = next.x;
    dwarf.y    = next.y;
    dwarf.task = `→ stockpile (${dwarf.inventory.materials.toFixed(0)} ore)`;
    return;
  }

  // ── 4.5. Miners target ore/material tiles when no food found ──────────
  if (dwarf.role === 'miner') {
    const oreTarget = bestMaterialTile(dwarf, grid, dwarf.vision);
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
  // When LLM intent is 'avoid' and we know where other dwarves are,
  // pick the open tile that maximises Manhattan distance from the nearest
  // rival within 5 tiles.  Falls back to random wander if no rival nearby.
  const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  const open = dirs
    .map(d => ({ x: dwarf.x + d.x, y: dwarf.y + d.y }))
    .filter(p => isWalkable(grid, p.x, p.y));

  if (open.length > 0) {
    let next: { x: number; y: number };

    if (dwarf.llmIntent === 'avoid' && dwarves) {
      const rival = dwarves
        .filter(r => r.alive && r.id !== dwarf.id)
        .map(r    => ({ r, dist: Math.abs(r.x - dwarf.x) + Math.abs(r.y - dwarf.y) }))
        .filter(e  => e.dist <= 5)
        .sort((a, b) => a.dist - b.dist)[0]?.r ?? null;

      if (rival) {
        next       = open.reduce((best, p) =>
          (Math.abs(p.x - rival.x) + Math.abs(p.y - rival.y)) >
          (Math.abs(best.x - rival.x) + Math.abs(best.y - rival.y)) ? p : best,
        );
        dwarf.task = `avoiding ${rival.name}`;
      } else {
        next       = open[Math.floor(Math.random() * open.length)];
        dwarf.task = 'wandering';
      }
    } else {
      next       = open[Math.floor(Math.random() * open.length)];
      dwarf.task = 'wandering';
    }

    dwarf.x = next.x;
    dwarf.y = next.y;
  } else {
    dwarf.task = 'wandering';
  }
}
