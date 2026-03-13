/**
 * Central configuration for colony goals.
 *
 * Each entry defines:
 *   baseTarget    — raw difficulty before generation scaling
 *   scaleFactor   — per-generation multiplier (target = baseTarget * (1 + gen * scaleFactor))
 *   actionBonuses — score multipliers applied to named actions while this goal is active
 *
 * Tune actionBonuses here to nudge goblins toward goal-relevant work without hard overrides.
 * Multipliers stack multiplicatively on top of the normal utility score, so 1.5 is a
 * strong nudge; 1.2 is a gentle preference. Keep survival actions (eat, rest) unlisted
 * unless the goal specifically calls for survival focus — those already score highly from needs.
 */

import type { ColonyGoalType } from '../shared/types';

export interface GoalDef {
  baseTarget: number;
  scaleFactor: number;
  /** Multipliers applied after normal scoring. Keys are action.name strings. */
  actionBonuses: Partial<Record<string, number>>;
}

export const GOAL_CONFIG: Record<ColonyGoalType, GoalDef> = {
  build_rooms: {
    baseTarget: 2,
    scaleFactor: 0,           // room count doesn't scale with generation
    actionBonuses: {
      buildWoodWall:  1.4,
      buildStoneWall: 1.4,
      saw:            1.25,   // need planks for wood walls
      smith:          1.25,   // need bars for stone walls
      chop:           1.3,    // gather wood for future planks/walls
      mine:           1.2,    // keep ore flowing for bars/stone walls
    },
  },
  cook_meals: {
    baseTarget: 20,
    scaleFactor: 0.6,
    actionBonuses: {
      cook:   1.5,
      forage: 1.2,            // need food input
      chop:   1.2,            // need wood input
    },
  },
  survive_ticks: {
    baseTarget: 400,
    scaleFactor: 0.6,
    actionBonuses: {
      eat:          1.3,
      rest:         1.2,
      withdrawFood: 1.2,
    },
  },
  defeat_adventurers: {
    baseTarget: 5,
    scaleFactor: 0.6,
    actionBonuses: {
      fight: 1.5,
    },
  },
};

/** Ordered cycle of goal types. Goals advance through this list on completion. */
export const GOAL_ORDER: ColonyGoalType[] = [
  'build_rooms',
  'cook_meals',
  'survive_ticks',
  'defeat_adventurers',
];
