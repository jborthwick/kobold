/**
 * Skills & XP system — one skill per role, XP accrues on primary actions.
 *
 * Level = floor(sqrt(xp / 10)):
 *   Level 0 →  1 at  10 XP
 *   Level 1 →  2 at  40 XP
 *   Level 2 →  3 at  90 XP
 *   Level 3 →  4 at 160 XP  (rare)
 *
 * Skill bonuses feed into existing shared state (yield, damage, vision)
 * without modifying any Utility AI scoring curves — the curves adapt
 * automatically because they read the same stat fields.
 */

import type { Goblin } from '../shared/types';

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

// ── Level calculation ───────────────────────────────────────────────────────

export function xpToLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp / 10));
}

/**
 * Grant 1 XP to the goblin's role skill, recompute level.
 * Returns true if the goblin leveled up (caller may want to log).
 */
export function grantXp(goblin: Goblin, _tick: number, onLog?: LogFn): boolean {
  goblin.skillXp += 1;
  const newLevel = xpToLevel(goblin.skillXp);
  if (newLevel > goblin.skillLevel) {
    goblin.skillLevel = newLevel;
    onLog?.(`⭐ leveled up to ${goblin.role} Lv.${newLevel}!`, 'info');
    return true;
  }
  return false;
}

// ── Role-specific bonuses ───────────────────────────────────────────────────

/** Bonus harvest yield for foragers/lumberjacks: +0.3 per skill level. */
export function skillYieldBonus(goblin: Goblin): number {
  if (goblin.role !== 'forager' && goblin.role !== 'lumberjack') return 0;
  return goblin.skillLevel * 0.3;
}

/** Bonus ore yield for miners: +0.3 per skill level. */
export function skillOreBonus(goblin: Goblin): number {
  if (goblin.role !== 'miner') return 0;
  return goblin.skillLevel * 0.3;
}

/** Bonus combat damage for fighters: +3 per skill level. */
export function skillDamageBonus(goblin: Goblin): number {
  if (goblin.role !== 'fighter') return 0;
  return goblin.skillLevel * 3;
}

/** Bonus vision radius for scouts: +1 per skill level (integer). */
export function skillVisionBonus(goblin: Goblin): number {
  if (goblin.role !== 'scout') return 0;
  return goblin.skillLevel;
}
