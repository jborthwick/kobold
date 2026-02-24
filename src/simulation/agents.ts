import * as ROT from 'rot-js';
import { type Dwarf, type Tile } from '../shared/types';
import { GRID_SIZE, INITIAL_DWARVES, DWARF_NAMES } from '../shared/constants';
import { isWalkable } from './world';

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function spawnDwarves(grid: Tile[][]): Dwarf[] {
  const dwarves: Dwarf[] = [];
  for (let i = 0; i < INITIAL_DWARVES; i++) {
    let x: number, y: number;
    do {
      x = rand(2, 25);
      y = rand(2, 25);
    } while (!isWalkable(grid, x, y));

    dwarves.push({
      id:            `dwarf-${i}`,
      name:          DWARF_NAMES[i % DWARF_NAMES.length],
      x, y,
      health:        100,
      maxHealth:     100,
      hunger:        rand(10, 40),
      metabolism:    rand(1, 3),
      vision:        rand(2, 5),
      inventory:     { food: rand(8, 15), materials: 0 },
      morale:        70 + rand(0, 20),
      alive:         true,
      task:          'idle',
      commandTarget: null,
      llmReasoning:    null,
      llmIntent:       null,
      llmIntentExpiry: 0,
      memory:          [],
    });
  }
  return dwarves;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Scan a square of `radius` tiles around the dwarf for the richest food tile. */
function bestFoodTile(
  dwarf:  Dwarf,
  grid:   Tile[][],
  radius: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestValue = 0.5;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = dwarf.x + dx;
      const ny = dwarf.y + dy;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      const v = grid[ny][nx].foodValue;
      if (v > bestValue) { bestValue = v; best = { x: nx, y: ny }; }
    }
  }
  return best;
}

/**
 * Returns the next tile to step onto when moving from `from` toward `to`,
 * using rot.js A* for obstacle-aware pathfinding.
 * Falls back to staying in place if the destination is unreachable.
 */
function pathNextStep(
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
    dwarf.health -= 10;
    dwarf.morale  = Math.max(0, dwarf.morale - 5);
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
    if (here.foodValue > 0) {
      const amount          = Math.min(here.foodValue, 3);
      here.foodValue        = Math.max(0, here.foodValue - amount);
      dwarf.inventory.food += amount;
      const label           = dwarf.llmIntent === 'forage' ? 'foraging (LLM)' : 'harvesting';
      dwarf.task            = `${label} (food: ${dwarf.inventory.food.toFixed(0)})`;
    } else {
      const label = dwarf.llmIntent === 'forage' ? 'foraging (LLM)' : 'foraging';
      dwarf.task  = `${label} → (${foodTarget.x},${foodTarget.y})`;
    }
    return;
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
