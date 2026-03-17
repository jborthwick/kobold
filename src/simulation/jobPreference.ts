/**
 * Job preference for HUD display: trait + skill bonus per work category.
 * Used to show emoji badges (happy / none / sad) on the goblin panel job row.
 * Values match utilityAI skill-preference constants so display reflects actual scoring.
 */

import type { Goblin } from '../shared/types';
import { getTraitTagMultiplier } from './traitActionBias';
import { ALL_ACTIONS } from './actions';
import { CATEGORY_TO_ACTION_NAME, getSkillForCategory, type WorkCategoryId } from './workerTargets';
import { xpToLevel } from './skills';

/** Must match utilityAI.ts SKILL_PREFERENCE_PER_LEVEL. */
const SKILL_PREFERENCE_PER_LEVEL = 0.04;
/** Must match utilityAI.ts SKILL_PREFERENCE_CAP. */
const SKILL_PREFERENCE_CAP = 0.18;

export type JobPreferenceBreakdown = {
  /** Trait contribution, computed from job-specific tags (excludes generic 'work'). */
  traitDelta: number;
  /** Skill contribution, matching the utility AI constants. */
  skillBonus: number;
  /** Total preference = traitDelta + skillBonus. */
  total: number;
};

/**
 * Preference value for one work category: trait delta (job-specific tags only) + skill bonus.
 * Positive = goblin likes this job, negative = dislikes, ~0 = neutral.
 *
 * Note: we intentionally ignore the generic 'work' tag here so “I hate work” traits don't
 * paint every job red; the HUD is meant to show role affinity differences.
 */
export function getJobPreferenceBreakdown(goblin: Goblin, category: WorkCategoryId): JobPreferenceBreakdown {
  const actionName = CATEGORY_TO_ACTION_NAME[category];
  const action = ALL_ACTIONS.find(a => a.name === actionName);
  let traitMult = 1.0;
  if (action) {
    for (const tag of action.tags) {
      if (tag === 'work') continue;
      traitMult *= getTraitTagMultiplier(goblin.trait, tag);
    }
  }
  const traitDelta = traitMult - 1;

  const skillKey = getSkillForCategory(category);
  const level = skillKey ? xpToLevel(goblin.skills[skillKey]) : 0;
  const skillBonus = Math.min(SKILL_PREFERENCE_PER_LEVEL * level, SKILL_PREFERENCE_CAP);

  const total = traitDelta + skillBonus;
  return { traitDelta, skillBonus, total };
}

export function getJobPreference(goblin: Goblin, category: WorkCategoryId): number {
  return getJobPreferenceBreakdown(goblin, category).total;
}
