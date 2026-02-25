/**
 * Goblin raid simulation.
 *
 * Raids spawn from map edges every 500–900 ticks in groups of 2–4 goblins.
 * Each goblin moves one tile per tick toward the nearest alive dwarf.
 * When a goblin reaches a dwarf's tile it attacks; the dwarf fights back.
 * Dead goblins are reported in GoblinTickResult.goblinDeaths and removed by WorldScene.
 */

import type { Goblin, Dwarf, Tile } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';
import { isWalkable } from './world';
import { pathNextStep } from './agents';

// ── Raid scheduler ────────────────────────────────────────────────────────────

const RAID_INTERVAL_MIN = 500;   // ticks between raids (~70 s at 7 tps)
const RAID_INTERVAL_MAX = 900;
const WANDER_RANGE      = 15;   // tiles — goblins wander when no dwarf is within range

// Module-level state — reset when a new world is generated
let nextRaidAt  = RAID_INTERVAL_MIN + Math.floor(Math.random() * (RAID_INTERVAL_MAX - RAID_INTERVAL_MIN));
let nextGoblinId = 0;

/** Reset scheduler — call this in WorldScene.create() so new games get fresh timers. */
export function resetGoblins(): void {
  nextRaidAt   = RAID_INTERVAL_MIN + Math.floor(Math.random() * (RAID_INTERVAL_MAX - RAID_INTERVAL_MIN));
  nextGoblinId = 0;
}

const EDGE_NAMES = ['north', 'east', 'south', 'west'] as const;

export interface RaidSpawnResult {
  goblins: Goblin[];
  edge:    string;
  count:   number;
}

/**
 * Called each tick. Returns a raid group if the cooldown has expired,
 * otherwise returns null.  Mutates the scheduler.
 */
export function maybeSpawnRaid(
  grid:    Tile[][],
  dwarves: Dwarf[],
  tick:    number,
): RaidSpawnResult | null {
  if (tick < nextRaidAt) return null;

  const alive = dwarves.filter(d => d.alive);
  if (alive.length === 0) return null;

  // Schedule the next raid
  nextRaidAt = tick + RAID_INTERVAL_MIN +
    Math.floor(Math.random() * (RAID_INTERVAL_MAX - RAID_INTERVAL_MIN));

  const count = 2 + Math.floor(Math.random() * 3); // 2–4 goblins
  const edge  = Math.floor(Math.random() * 4);      // 0=N, 1=E, 2=S, 3=W
  const newGoblins: Goblin[] = [];

  for (let i = 0; i < count; i++) {
    let x = 0, y = 0, attempts = 0;
    do {
      switch (edge) {
        case 0: x = Math.floor(Math.random() * GRID_SIZE); y = 0;             break;
        case 1: x = GRID_SIZE - 1;                         y = Math.floor(Math.random() * GRID_SIZE); break;
        case 2: x = Math.floor(Math.random() * GRID_SIZE); y = GRID_SIZE - 1; break;
        default: x = 0;                                    y = Math.floor(Math.random() * GRID_SIZE); break;
      }
      attempts++;
    } while (!isWalkable(grid, x, y) && attempts < 30);

    if (!isWalkable(grid, x, y)) continue; // edge is all water/stone — skip this goblin

    newGoblins.push({
      id:        `goblin-${nextGoblinId++}`,
      x, y,
      health:    30,
      maxHealth: 30,
      targetId:  null,
    });
  }

  return newGoblins.length > 0
    ? { goblins: newGoblins, edge: EDGE_NAMES[edge], count: newGoblins.length }
    : null;
}

// ── Per-tick simulation ───────────────────────────────────────────────────────

export interface GoblinTickResult {
  /** Attacks dealt this tick — WorldScene applies damage to dwarves. */
  attacks:      Array<{ dwarfId: string; damage: number }>;
  /** Goblin IDs whose health reached 0 — WorldScene removes them. */
  goblinDeaths: string[];
  /** Dwarf IDs that scored a kill this tick — WorldScene adds memory. */
  kills:        Array<{ dwarfId: string }>;
  /** Log entries to emit. */
  logs: Array<{ message: string; level: 'info' | 'warn' | 'error' }>;
}

const GOBLIN_ATTACK_DAMAGE = 5;   // hp per hit to dwarf
const DWARF_FIGHT_BACK     = 8;   // hp per hit to goblin (normal dwarves)
const FIGHTER_FIGHT_BACK   = 18;  // fighters deal ~2× damage — kills goblin in 2 hits

/**
 * Move all goblins one step toward their target, or attack on contact.
 * Goblins move at ~75% speed (staggered skip every 4th tick per goblin)
 * so fighters can reliably close on them.
 * Mutates goblin positions/health in place.
 */
export function tickGoblins(
  goblins: Goblin[],
  dwarves: Dwarf[],
  grid:    Tile[][],
  tick:    number,
): GoblinTickResult {
  const result: GoblinTickResult = { attacks: [], goblinDeaths: [], kills: [], logs: [] };
  const alive = dwarves.filter(d => d.alive);
  if (alive.length === 0) return result;

  for (let gi = 0; gi < goblins.length; gi++) {
    const g = goblins[gi];
    // Staggered 75%-speed: each goblin skips its move on a different tick
    // so they don't all pause simultaneously (gi offsets the skip cycle).
    if ((tick + gi) % 4 === 0) continue;
    // Re-target if current target is dead or unset
    let target = g.targetId ? alive.find(d => d.id === g.targetId) ?? null : null;
    if (!target) {
      // Pick nearest alive dwarf
      target = alive.reduce<Dwarf | null>((best, d) => {
        const dist  = Math.abs(d.x - g.x) + Math.abs(d.y - g.y);
        const bDist = best ? Math.abs(best.x - g.x) + Math.abs(best.y - g.y) : Infinity;
        return dist < bDist ? d : best;
      }, null);
      g.targetId = target?.id ?? null;
    }
    if (!target) continue;

    const dist = Math.abs(target.x - g.x) + Math.abs(target.y - g.y);

    if (dist === 0) {
      // ── Attack ──────────────────────────────────────────────────────
      result.attacks.push({ dwarfId: target.id, damage: GOBLIN_ATTACK_DAMAGE });
      g.health -= target.role === 'fighter' ? FIGHTER_FIGHT_BACK : DWARF_FIGHT_BACK;
      if (g.health <= 0) {
        result.goblinDeaths.push(g.id);
        result.kills.push({ dwarfId: target.id });
        result.logs.push({
          message: `${target.name} slew a goblin!`,
          level:   'warn',
        });
      }
    } else if (dist > WANDER_RANGE) {
      // ── Wander — random step when no dwarf is close ──────────────────
      const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
      // Fisher-Yates-style shuffle for pick order
      for (let i = dirs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
      }
      for (const dir of dirs) {
        const nx = g.x + dir.x;
        const ny = g.y + dir.y;
        if (isWalkable(grid, nx, ny)) { g.x = nx; g.y = ny; break; }
      }
    } else {
      // ── Move toward target using A* ──────────────────────────────────
      const next = pathNextStep({ x: g.x, y: g.y }, { x: target.x, y: target.y }, grid);
      g.x = next.x;
      g.y = next.y;
    }
  }

  return result;
}

// ── Initial wandering goblins ─────────────────────────────────────────────────

/**
 * Spawn `count` goblins scattered across the map at game start.
 * They wander freely (WANDER_RANGE check) until they stumble near dwarves.
 */
export function spawnInitialGoblins(grid: Tile[][], count: number): Goblin[] {
  const goblins: Goblin[] = [];
  for (let i = 0; i < count; i++) {
    let x = 0, y = 0, attempts = 0;
    do {
      x = Math.floor(Math.random() * GRID_SIZE);
      y = Math.floor(Math.random() * GRID_SIZE);
      attempts++;
    } while (!isWalkable(grid, x, y) && attempts < 50);
    if (!isWalkable(grid, x, y)) continue;
    goblins.push({
      id:        `goblin-${nextGoblinId++}`,
      x, y,
      health:    30,
      maxHealth: 30,
      targetId:  null,
    });
  }
  return goblins;
}
