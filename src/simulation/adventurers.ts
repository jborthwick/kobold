/**
 * Adventurer raid simulation.
 *
 * Raids spawn from map edges every 500–900 ticks in groups of 2–4 adventurers.
 * Each adventurer moves one tile per tick toward the nearest alive goblin.
 * When an adventurer reaches a goblin's tile it attacks; the goblin fights back.
 * Dead adventurers are reported in AdventurerTickResult.adventurerDeaths and removed by WorldScene.
 */

import type { Adventurer, Goblin, Tile } from '../shared/types';
import { GRID_SIZE } from '../shared/constants';
import { isWalkable } from './world';
import { pathNextStep } from './agents';
import { skillDamageBonus } from './skills';
import { woundDamageMultiplier } from './wounds';

// ── Raid scheduler ────────────────────────────────────────────────────────────

const RAID_INTERVAL_MIN = 500;   // ticks between raids (~70 s at 7 tps)
const RAID_INTERVAL_MAX = 900;
const WANDER_RANGE      = 15;   // tiles — adventurers wander when no goblin is within range

// Module-level state — reset when a new world is generated
let nextRaidAt  = RAID_INTERVAL_MIN + Math.floor(Math.random() * (RAID_INTERVAL_MAX - RAID_INTERVAL_MIN));
let nextAdventurerId = 0;

/** Reset scheduler — call this in WorldScene.create() so new games get fresh timers. */
export function resetAdventurers(): void {
  nextRaidAt   = RAID_INTERVAL_MIN + Math.floor(Math.random() * (RAID_INTERVAL_MAX - RAID_INTERVAL_MIN));
  nextAdventurerId = 0;
}

const EDGE_NAMES = ['north', 'east', 'south', 'west'] as const;

export interface RaidSpawnResult {
  adventurers: Adventurer[];
  edge:    string;
  count:   number;
}

/**
 * Called each tick. Returns a raid group if the cooldown has expired,
 * otherwise returns null.  Mutates the scheduler.
 */
export function maybeSpawnRaid(
  grid:    Tile[][],
  goblins: Goblin[],
  tick:    number,
): RaidSpawnResult | null {
  if (tick < nextRaidAt) return null;

  const alive = goblins.filter(d => d.alive);
  if (alive.length === 0) return null;

  // Schedule the next raid
  nextRaidAt = tick + RAID_INTERVAL_MIN +
    Math.floor(Math.random() * (RAID_INTERVAL_MAX - RAID_INTERVAL_MIN));

  const count = 2 + Math.floor(Math.random() * 3); // 2–4 adventurers
  const edge  = Math.floor(Math.random() * 4);      // 0=N, 1=E, 2=S, 3=W
  const newGoblins: Adventurer[] = [];

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

    if (!isWalkable(grid, x, y)) continue; // edge is all water/stone — skip this adventurer

    newGoblins.push({
      id:        `adventurer-${nextAdventurerId++}`,
      x, y,
      health:    20,
      maxHealth: 20,
      targetId:  null,
    });
  }

  return newGoblins.length > 0
    ? { adventurers: newGoblins, edge: EDGE_NAMES[edge], count: newGoblins.length }
    : null;
}

// ── Per-tick simulation ───────────────────────────────────────────────────────

export interface AdventurerTickResult {
  /** Attacks dealt this tick — WorldScene applies damage to goblins. */
  attacks:      Array<{ goblinId: string; damage: number }>;
  /** Adventurer IDs whose health reached 0 — WorldScene removes them. */
  adventurerDeaths: string[];
  /** Goblin IDs that scored a kill this tick — WorldScene adds memory. */
  kills:        Array<{ goblinId: string }>;
  /** Log entries to emit. */
  logs: Array<{ message: string; level: 'info' | 'warn' | 'error' }>;
}

const ADVENTURER_ATTACK_DAMAGE = 5;   // hp per hit to goblin
const GOBLIN_FIGHT_BACK     = 8;   // hp per hit to adventurer (normal goblins)
const FIGHTER_FIGHT_BACK   = 18;  // fighters deal ~2× damage — kills adventurer in 2 hits

/**
 * Move all adventurers one step toward their target, or attack on contact.
 * Goblins move at ~75% speed (staggered skip every 4th tick per adventurer)
 * so fighters can reliably close on them.
 * Mutates adventurer positions/health in place.
 */
export function tickAdventurers(
  adventurers: Adventurer[],
  goblins: Goblin[],
  grid:    Tile[][],
  tick:    number,
): AdventurerTickResult {
  const result: AdventurerTickResult = { attacks: [], adventurerDeaths: [], kills: [], logs: [] };
  const alive = goblins.filter(d => d.alive);
  if (alive.length === 0) return result;

  for (let gi = 0; gi < adventurers.length; gi++) {
    const g = adventurers[gi];
    // Safety escape: if adventurer is on a non-walkable tile (wall placed under it), nudge out
    if (!isWalkable(grid, g.x, g.y)) {
      const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
      const escape = dirs.find(d => isWalkable(grid, g.x + d.x, g.y + d.y));
      if (escape) { g.x += escape.x; g.y += escape.y; }
    }
    // Skip movement if staggered from a recent hit
    if (g.staggeredUntil !== undefined && tick < g.staggeredUntil) continue;
    // Staggered 75%-speed: each adventurer skips its move on a different tick
    // so they don't all pause simultaneously (gi offsets the skip cycle).
    if ((tick + gi) % 4 === 0) continue;
    // Re-target if current target is dead or unset
    let target = g.targetId ? alive.find(d => d.id === g.targetId) ?? null : null;
    if (!target) {
      // Pick nearest alive goblin
      target = alive.reduce<Goblin | null>((best, d) => {
        const dist  = Math.abs(d.x - g.x) + Math.abs(d.y - g.y);
        const bDist = best ? Math.abs(best.x - g.x) + Math.abs(best.y - g.y) : Infinity;
        return dist < bDist ? d : best;
      }, null);
      g.targetId = target?.id ?? null;
    }
    // Proximity override: if a goblin is standing on the same tile, fight them
    // immediately — regardless of which goblin the adventurer was originally chasing.
    // This is the key fix for fighters: a fighter can close on an adventurer that is
    // targeting a different goblin and still trigger melee combat.
    const onSameTile = alive.find(d => d.x === g.x && d.y === g.y);
    if (onSameTile) { target = onSameTile; g.targetId = onSameTile.id; }
    if (!target) continue;

    const dist = Math.abs(target.x - g.x) + Math.abs(target.y - g.y);

    if (dist === 0) {
      // ── Attack ──────────────────────────────────────────────────────
      result.attacks.push({ goblinId: target.id, damage: ADVENTURER_ATTACK_DAMAGE });
      const baseDmg = target.role === 'fighter' ? FIGHTER_FIGHT_BACK : GOBLIN_FIGHT_BACK;
      const dmg     = Math.round((baseDmg + skillDamageBonus(target)) * woundDamageMultiplier(target));
      g.health -= dmg;
      // Stagger: adventurer can't move for 12 ticks after being hit (~1.7 s at 7 tps)
      g.staggeredUntil = tick + 12;
      if (g.health <= 0) {
        result.adventurerDeaths.push(g.id);
        result.kills.push({ goblinId: target.id });
      }
    } else if (dist > WANDER_RANGE) {
      // ── Wander — random step when no goblin is close ──────────────────
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

// ── Initial wandering adventurers ─────────────────────────────────────────────────

/**
 * Spawn `count` adventurers scattered across the map at game start.
 * They wander freely (WANDER_RANGE check) until they stumble near goblins.
 */
export function spawnInitialAdventurers(grid: Tile[][], count: number): Adventurer[] {
  const adventurers: Adventurer[] = [];
  for (let i = 0; i < count; i++) {
    let x = 0, y = 0, attempts = 0;
    do {
      x = Math.floor(Math.random() * GRID_SIZE);
      y = Math.floor(Math.random() * GRID_SIZE);
      attempts++;
    } while (!isWalkable(grid, x, y) && attempts < 50);
    if (!isWalkable(grid, x, y)) continue;
    adventurers.push({
      id:        `adventurer-${nextAdventurerId++}`,
      x, y,
      health:    20,
      maxHealth: 20,
      targetId:  null,
    });
  }
  return adventurers;
}
