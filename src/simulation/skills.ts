/**
 * Skills & XP system — all goblins have the same skill slots.
 * XP accrues per action type; no role-based specialization.
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

import type { Goblin, SkillSet } from '../shared/types';

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

// ── Level calculation ───────────────────────────────────────────────────────

export function xpToLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp / 10));
}

/**
 * Grant 1 XP to a specific skill.
 * Returns true if the goblin leveled up in that skill (caller may want to log).
 */
export function grantXp(
  goblin: Goblin,
  skill: keyof SkillSet,
  _tick: number,
  onLog?: LogFn
): boolean {
  const oldLevel = xpToLevel(goblin.skills[skill]);
  goblin.skills[skill] += 1;
  const newLevel = xpToLevel(goblin.skills[skill]);

  if (newLevel > oldLevel) {
    onLog?.(`⭐ ${skill} Lv.${newLevel}!`, 'info');
    return true;
  }
  return false;
}

// ── Skill-based bonuses ────────────────────────────────────────────────────

/** Bonus harvest yield for foragers: +0.3 per forage skill level. */
export function skillYieldBonus(goblin: Goblin): number {
  return xpToLevel(goblin.skills.forage) * 0.3;
}

/** Bonus ore yield for miners: +0.3 per mine skill level. */
export function skillOreBonus(goblin: Goblin): number {
  return xpToLevel(goblin.skills.mine) * 0.3;
}

/** Bonus chop yield for lumberjacks: +0.3 per chop skill level. */
export function skillChopBonus(goblin: Goblin): number {
  return xpToLevel(goblin.skills.chop) * 0.3;
}

/** Bonus combat damage for fighters: +3 per combat skill level. */
export function skillDamageBonus(goblin: Goblin): number {
  return xpToLevel(goblin.skills.combat) * 3;
}

/** Bonus vision radius for scouts: +1 per scout skill level (integer). */
export function skillVisionBonus(goblin: Goblin): number {
  return xpToLevel(goblin.skills.scout);
}

/**
 * Return the goblin's highest skill name and level (for HUD display).
 * If all skills are 0, returns null.
 */
export function topSkill(goblin: Goblin): { skill: keyof SkillSet; level: number } | null {
  let bestSkill: keyof SkillSet | null = null;
  let bestLevel = 0;

  for (const skill of ['forage', 'mine', 'chop', 'combat', 'scout'] as const) {
    const level = xpToLevel(goblin.skills[skill]);
    if (level > bestLevel) {
      bestSkill = skill;
      bestLevel = level;
    }
  }

  return bestSkill ? { skill: bestSkill, level: bestLevel } : null;
}
