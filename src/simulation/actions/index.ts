export type { ActionContext, Action } from './types';

import { commandMove, eat, rest } from './survival';
import { share, socialize, avoidRival } from './social';
import { fight, seekSafety } from './combat';
import { forage, depositFood, withdrawFood } from './foraging';
import { mine, chop, depositOre, depositWood } from './materials';
import { buildWall, buildHearth } from './building';
import { seekWarmth, wander } from './exploration';
import { fightFire } from './firefighting';
import { establishStockpile } from './stockpiling';
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
  establishStockpile,
  forage,
  depositFood,
  withdrawFood,
  mine,
  chop,
  depositOre,
  depositWood,
  buildWall,
  socialize,
  seekWarmth,   // comfort nudge — low score, loses to most work actions
  avoidRival,
  wander,
];
