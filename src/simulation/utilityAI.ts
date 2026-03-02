/**
 * Utility AI — replaces the fixed-priority behavior tree with scored action selection.
 *
 * Every tick each eligible action scores 0–1. The highest-scoring action wins.
 * Traits shift sigmoid midpoints (not thresholds), creating organic personality-driven
 * divergence. LLM intents add +0.5 to matching action scores (capped at 1.0) instead
 * of hard-overriding the BT.
 *
 * Flow:
 *   1. updateNeeds()           — hunger, morale, fatigue, social
 *   2. starvation damage       — unconditional, not an action
 *   3. expire stale LLM intent
 *   4. score all eligible actions (+ LLM boost)
 *   5. execute highest-scoring action
 */

import { type Goblin, type Tile, type Adventurer, type FoodStockpile, type OreStockpile, type WoodStockpile, type ColonyGoal, type WeatherType } from '../shared/types';
import { getWarmth } from './diffusion';
import { MAX_INVENTORY_FOOD } from '../shared/constants';
import { isWalkable } from './world';
import {
  traitMod,
} from './agents';
import { ALL_ACTIONS, type ActionContext, type Action } from './actions';
import { tickWoundHealing } from './wounds';

// ── Response curves ────────────────────────────────────────────────────────────

/** S-curve: 0 at low values, 1 at high values. Steepness controls transition sharpness. */
export function sigmoid(value: number, midpoint: number, steepness = 0.15): number {
  return 1 / (1 + Math.exp(-steepness * (value - midpoint)));
}

/** 1 − sigmoid: 1 at low values, 0 at high values. */
export function inverseSigmoid(value: number, midpoint: number, steepness = 0.15): number {
  return 1 - sigmoid(value, midpoint, steepness);
}

/** Linear ramp: 0 below min, 1 above max, linear in between. */
export function ramp(value: number, min: number, max: number): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

// ── Needs update (runs every tick before action selection) ──────────────────────

type LogFn = (message: string, level: 'info' | 'warn' | 'error') => void;

/** Cooldown-gated log: returns true (and records the tick) at most once per `cooldown` ticks. */
function shouldLog(goblin: Goblin, key: string, tick: number, cooldown: number): boolean {
  if (tick - (goblin.lastLoggedTicks[key] ?? -Infinity) < cooldown) return false;
  goblin.lastLoggedTicks[key] = tick;
  return true;
}

function updateNeeds(
  goblin: Goblin,
  goblins: Goblin[] | undefined,
  currentTick: number,
  weatherMetabolismMod: number,
  warmthField: Float32Array | undefined,
  weatherType: WeatherType | undefined,
  onLog?: LogFn,
): void {
  // Hunger grows every tick (cold weather burns calories faster)
  goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * weatherMetabolismMod);

  // Exposure penalty — freezing in the open during cold weather
  if (weatherType === 'cold' && warmthField) {
    const warmth = getWarmth(warmthField, goblin.x, goblin.y);
    if (warmth < 25) {
      goblin.fatigue = Math.min(100, goblin.fatigue + 0.25);
      goblin.morale  = Math.max(0, goblin.morale - 0.2);
      goblin.hunger  = Math.min(100, goblin.hunger + goblin.metabolism * 0.2);
      if (shouldLog(goblin, 'freezing', currentTick, 150)) {
        onLog?.('🥶 freezing in the open', 'warn');
      }
    }
  }

  // Morale decays slowly when hungry, recovers when well-fed
  if (goblin.hunger > 60) {
    goblin.morale = Math.max(0, goblin.morale - 0.4);
  } else if (goblin.hunger < 30) {
    goblin.morale = Math.min(100, goblin.morale + 0.2);
  }
  // Stress metabolism — demoralized goblins burn calories faster
  if (goblin.morale < 25) {
    goblin.hunger = Math.min(100, goblin.hunger + goblin.metabolism * 0.3);
    if (shouldLog(goblin, 'morale_low', currentTick, 200)) {
      onLog?.('😤 morale is dangerously low', 'warn');
    }
  }
  // High morale is the default state — not worth logging individually
  // (colony-wide morale shifts are reported by world events instead)

  // Fatigue — tiny idle decay; traits via fatigueRate applied at action sites
  goblin.fatigue = Math.max(0, goblin.fatigue - 0.05);
  // Bruised wound: extra fatigue drain (+0.3/tick)
  if (goblin.wound?.type === 'bruised') {
    goblin.fatigue = Math.min(100, goblin.fatigue + 0.3);
  }
  if (goblin.fatigue > 90) {
    goblin.morale = Math.max(0, goblin.morale - 0.2);
  }
  if (goblin.fatigue > 80 && shouldLog(goblin, 'exhausted', currentTick, 150)) {
    onLog?.('😩 exhausted', 'warn');
  }

  // Wound healing — check and clear expired wounds
  tickWoundHealing(goblin, currentTick, onLog);

  // Social — check for friendly goblin (relation >= 40) within 3 tiles
  if (goblins) {
    const FRIEND_RADIUS = 3;
    const FRIEND_REL    = 40;
    const hasFriend = goblins.some(
      other => other.id !== goblin.id && other.alive &&
        Math.abs(other.x - goblin.x) <= FRIEND_RADIUS &&
        Math.abs(other.y - goblin.y) <= FRIEND_RADIUS &&
        (goblin.relations[other.id] ?? 50) >= FRIEND_REL,
    );
    if (hasFriend) {
      const socialBonus = traitMod(goblin, 'socialDecayBonus', 0);
      goblin.social = Math.max(0, goblin.social - (0.3 + socialBonus));
      goblin.lastSocialTick = currentTick;
    } else if (currentTick - goblin.lastSocialTick > 30) {
      goblin.social = Math.min(100, goblin.social + 0.15);
    }
  }
  if (goblin.social > 60) {
    goblin.morale = Math.max(0, goblin.morale - 0.15);
    if (shouldLog(goblin, 'lonely', currentTick, 200)) {
      onLog?.('😔 feeling lonely', 'warn');
    }
  }
}

// ── Narrative action names for log display ─────────────────────────────────────

const ACTION_DISPLAY_NAMES: Record<string, string> = {
  eat:          'eating',
  rest:         'resting',
  forage:       'foraging',
  mine:         'mining',
  chop:         'logging',
  fight:        'fighting',
  share:        'sharing food',
  depositFood:  'stockpiling food',
  withdrawFood: 'raiding the stockpile',
  depositOre:   'hauling ore',
  depositWood:  'hauling wood',
  buildWall:    'building',
  buildHearth:  'building a hearth',
  seekWarmth:   'seeking warmth',
  seekSafety:   'fleeing to safety',
  socialize:    'socializing',
  avoidRival:   'avoiding a rival',
  wander:       'exploring',
  commandMove:  'following orders',
};

// ── Selector loop ──────────────────────────────────────────────────────────────

export function tickAgentUtility(
  goblin:              Goblin,
  grid:               Tile[][],
  currentTick:        number,
  goblins?:           Goblin[],
  onLog?:             LogFn,
  foodStockpiles?:    FoodStockpile[],
  adventurers?:           Adventurer[],
  oreStockpiles?:     OreStockpile[],
  colonyGoal?:        ColonyGoal,
  woodStockpiles?:    WoodStockpile[],
  weatherMetabolismMod?: number,
  warmthField?:       Float32Array,
  dangerField?:       Float32Array,
  weatherType?:       WeatherType,
): void {
  if (!goblin.alive) return;

  // ── Safety: nudge off unwalkable tile ──────────────────────────────────
  if (!isWalkable(grid, goblin.x, goblin.y)) {
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    for (const d of dirs) {
      if (isWalkable(grid, goblin.x + d.x, goblin.y + d.y)) {
        goblin.x += d.x; goblin.y += d.y; break;
      }
    }
  }

  // 1. Update needs (hunger, morale, fatigue, social)
  updateNeeds(goblin, goblins, currentTick, weatherMetabolismMod ?? 1, warmthField, weatherType, onLog);

  // Fatigue > 70: 30% chance to skip action this tick (exhaustion stumble)
  if (goblin.fatigue > 70 && Math.random() < 0.3) {
    goblin.task = 'exhausted…';
    goblin.fatigue = Math.max(0, goblin.fatigue - 0.5);
    return;
  }

  // 2. Starvation damage (unconditional — not an action)
  if (goblin.hunger >= 100 && goblin.inventory.food === 0) {
    goblin.health -= 2;
    goblin.morale  = Math.max(0, goblin.morale - 2);
    goblin.task    = 'starving!';
    onLog?.(`is starving! (health ${goblin.health})`, 'warn');
    if (goblin.health <= 0) {
      goblin.alive        = false;
      goblin.task         = 'dead';
      goblin.causeOfDeath = 'starvation';
      onLog?.('has died of starvation!', 'error');
      return;
    }
  }

  // 3. Expire stale LLM intent
  if (goblin.llmIntent && currentTick > goblin.llmIntentExpiry) {
    goblin.llmIntent = null;
  }

  // ── 2.8-style deposit/withdraw when standing on stockpile ──────────────
  // These fire as instant reactions (not scored), same as original BT.
  const standingFoodStockpile = foodStockpiles?.find(d => d.x === goblin.x && d.y === goblin.y) ?? null;
  if (standingFoodStockpile) {
    if (goblin.inventory.food >= 10) {
      const amount = goblin.inventory.food - 6;
      const stored = Math.min(amount, standingFoodStockpile.maxFood - standingFoodStockpile.food);
      if (stored > 0) {
        standingFoodStockpile.food += stored;
        goblin.inventory.food       -= stored;
        goblin.task                  = `deposited ${stored.toFixed(0)} → stockpile`;
        return;
      }
    }
    if (goblin.hunger > 60 && goblin.inventory.food < 2 && standingFoodStockpile.food > 0) {
      const amount                = Math.min(4, standingFoodStockpile.food);
      standingFoodStockpile.food -= amount;
      goblin.inventory.food        = Math.min(MAX_INVENTORY_FOOD, goblin.inventory.food + amount);
      goblin.task                  = `withdrew ${amount.toFixed(0)} from stockpile`;
      return;
    }
  }
  // Ore deposit (miners on stockpile)
  const standingOreStockpile = oreStockpiles?.find(s => s.x === goblin.x && s.y === goblin.y) ?? null;
  if (goblin.role === 'miner' && standingOreStockpile && goblin.inventory.materials > 0) {
    const stored = Math.min(goblin.inventory.materials, standingOreStockpile.maxOre - standingOreStockpile.ore);
    if (stored > 0) {
      standingOreStockpile.ore  += stored;
      goblin.inventory.materials -= stored;
      goblin.task                 = `deposited ${stored.toFixed(0)} ore → stockpile`;
      return;
    }
  }
  // Wood deposit (lumberjacks on stockpile)
  const standingWoodStockpile = woodStockpiles?.find(s => s.x === goblin.x && s.y === goblin.y) ?? null;
  if (goblin.role === 'lumberjack' && standingWoodStockpile && goblin.inventory.materials > 0) {
    const stored = Math.min(goblin.inventory.materials, standingWoodStockpile.maxWood - standingWoodStockpile.wood);
    if (stored > 0) {
      standingWoodStockpile.wood  += stored;
      goblin.inventory.materials   -= stored;
      goblin.task                   = `deposited ${stored.toFixed(0)} wood → stockpile`;
      return;
    }
  }

  // 4. Build action context — shared state that actions read from
  const ctx: ActionContext = {
    goblin, grid, currentTick, goblins, onLog,
    foodStockpiles, adventurers, oreStockpiles, woodStockpiles, colonyGoal,
    warmthField, dangerField, weatherType,
  };

  // 5. Score all eligible actions (+ LLM boost)
  let bestAction: Action | null = null;
  let bestScore = -1;
  let secondName = '';
  let secondScore = -1;

  for (const action of ALL_ACTIONS) {
    if (!action.eligible(ctx)) continue;
    let score = action.score(ctx);
    // LLM intent boost: +0.5 to the matching action, capped at 1.0
    if (goblin.llmIntent && action.intentMatch === goblin.llmIntent) {
      score = Math.min(1.0, score + 0.5);
    }
    if (score > bestScore) {
      secondScore = bestScore;
      secondName  = bestAction?.name ?? '';
      bestScore   = score;
      bestAction  = action;
    } else if (score > secondScore) {
      secondScore = score;
      secondName  = action.name;
    }
  }

  // Close-call log: only truly agonizing decisions (within 0.03, both urgent)
  if (bestAction && secondScore >= 0 && bestScore - secondScore <= 0.03 && bestScore > 0.45) {
    if (shouldLog(goblin, 'close_call', currentTick, 400)) {
      const nameA = ACTION_DISPLAY_NAMES[bestAction.name] ?? bestAction.name;
      const nameB = ACTION_DISPLAY_NAMES[secondName] ?? secondName;
      onLog?.(`⚖ agonizing over ${nameA} vs ${nameB}`, 'info');
    }
  }

  // 6. Execute highest-scoring action
  // Reset task to a descriptive idle string first — execute will override if it does real work
  goblin.task = idleDescription(goblin);
  if (bestAction) {
    bestAction.execute(ctx);
  }
}

/** Describe why a goblin is between actions — shown when execute returns early or nothing wins. */
function idleDescription(goblin: Goblin): string {
  if (goblin.fatigue > 60)              return 'exhausted, catching breath';
  if (goblin.fatigue > 20)              return 'catching breath';
  if ((goblin.warmth ?? 100) < 20)      return 'looking for warmth';
  if (goblin.morale < 25)               return 'brooding';
  if (goblin.hunger > 70)               return 'desperately hungry';
  if (goblin.hunger > 50)               return 'hungry, looking for food';
  if (goblin.social > 65)               return 'feeling lonely';
  if ((goblin.warmth ?? 100) < 35)      return 'a bit chilly';
  return 'idle';
}
