/**
 * Worker target allocation — colony-level soft headcount targets per work category.
 * Used by utilityAI to bias (not lock) job selection and by the UI for the planning panel.
 */

import type { Goblin, SkillSet } from '../shared/types';

export type WorkCategoryId =
  | 'foraging'
  | 'cooking'
  | 'mining'
  | 'woodcutting'
  | 'sawing'
  | 'smithing';

export interface WorkCategoryEntry {
  id: WorkCategoryId;
  label: string;
}

export const WORK_CATEGORIES: WorkCategoryEntry[] = [
  { id: 'foraging', label: 'Foraging' },
  { id: 'cooking', label: 'Cooking' },
  { id: 'mining', label: 'Mining' },
  { id: 'woodcutting', label: 'Woodcutting' },
  { id: 'sawing', label: 'Sawing' },
  { id: 'smithing', label: 'Smithing' },
];

const ACTION_TO_CATEGORY: Record<string, WorkCategoryId> = {
  forage: 'foraging',
  cook: 'cooking',
  mine: 'mining',
  chop: 'woodcutting',
  saw: 'sawing',
  smith: 'smithing',
};

/** Work category → action name (for preference scoring and UI). */
export const CATEGORY_TO_ACTION_NAME: Record<WorkCategoryId, string> = {
  foraging: 'forage',
  cooking: 'cook',
  mining: 'mine',
  woodcutting: 'chop',
  sawing: 'saw',
  smithing: 'smith',
};

/** Ticks to still count a goblin in their last work category when doing non-job actions (eat, rest, etc.). */
export const LAST_JOB_PERSIST_TICKS = 45;

/**
 * Map an action name (from action.name) to a work category, or null if not a targetable work category.
 */
export function actionNameToWorkCategory(actionName: string): WorkCategoryId | null {
  return ACTION_TO_CATEGORY[actionName] ?? null;
}

/**
 * Count of alive goblins currently in each work category. When currentTick is provided, goblins
 * doing non-job actions (eat, rest, etc.) are still counted in lastWorkCategory for up to
 * LAST_JOB_PERSIST_TICKS so headcount is stable.
 */
export function getCurrentHeadcounts(goblins: Goblin[], currentTick?: number): Record<WorkCategoryId, number> {
  const out: Record<WorkCategoryId, number> = {
    foraging: 0,
    cooking: 0,
    mining: 0,
    woodcutting: 0,
    sawing: 0,
    smithing: 0,
  };
  for (const g of goblins) {
    if (!g.alive) continue;
    const name = g.lastActionName ?? '';
    let cat = actionNameToWorkCategory(name);
    if (cat == null && currentTick != null && g.lastWorkCategory != null) {
      const age = currentTick - (g.lastWorkCategoryTick ?? 0);
      if (age <= LAST_JOB_PERSIST_TICKS) cat = g.lastWorkCategory;
    }
    if (cat) out[cat]++;
  }
  return out;
}

export type WorkerTargets = Partial<Record<WorkCategoryId, number>>;

/** Work category → skill key for skill-preference scoring. */
const CATEGORY_SKILL: Partial<Record<WorkCategoryId, keyof SkillSet>> = {
  foraging: 'forage',
  cooking: 'cook',
  mining: 'mine',
  woodcutting: 'chop',
  sawing: 'saw',
  smithing: 'smith',
};

export function getSkillForCategory(category: WorkCategoryId): keyof SkillSet | null {
  return CATEGORY_SKILL[category] ?? null;
}
