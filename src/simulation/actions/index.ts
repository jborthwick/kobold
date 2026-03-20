/**
 * Registers all actions in ALL_ACTIONS. Order in the array does not set priority — scoring
 * does; comments on each entry document intent (e.g. seekSafety before rest). New actions:
 * add to this array and to ACTION_DISPLAY_NAMES in utilityAI.ts.
 */
export type { ActionContext, Action } from './types';

import { commandMove, eat, rest } from './survival';
import { share, socialize, avoidRival } from './social';
import { fight, seekSafety } from './combat';
import { forage, depositFood, withdrawFood } from './foraging';
import { mine, chop, depositOre, depositWood } from './materials';
import { buildWoodWall, buildStoneWall, buildHearth } from './building';
import { refuelHearth } from './hearth';
import { wander } from './exploration';
import { fightFire } from './firefighting';
import { establishStockpile } from './stockpiling';
import { cook } from './cooking';
import { saw } from './sawing';
import { smith } from './smithing';
import { captureChicken, depositChicken } from './chickens';
import type { Action } from './types';

export const ALL_ACTIONS: Action[] = [
  commandMove,
  eat,
  seekSafety,   // danger-driven flee — high urgency, runs before rest/work
  fightFire,    // fetch water → douse nearby fire; scores 0.75 when fire is in vision
  rest,
  share,
  fight,
  buildHearth,
  refuelHearth,
  establishStockpile,
  depositChicken,
  captureChicken,
  cook,
  saw,
  smith,
  forage,
  depositFood,
  withdrawFood,
  mine,
  chop,
  depositOre,
  depositWood,
  buildWoodWall,
  buildStoneWall,
  socialize,
  avoidRival,
  wander,
];
