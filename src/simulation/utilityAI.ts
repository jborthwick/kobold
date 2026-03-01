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

import { TileType, type Dwarf, type Tile, type Goblin, type FoodStockpile, type OreStockpile, type WoodStockpile, type ColonyGoal } from '../shared/types';
import { GRID_SIZE, MAX_INVENTORY_FOOD } from '../shared/constants';
import { isWalkable } from './world';
import {
  pathNextStep, bestFoodTile, bestMaterialTile, bestWoodTile,
  fortWallSlots, fortEnclosureSlots,
  recordSite, FORAGEABLE_TILES, SITE_RECORD_THRESHOLD, PATCH_MERGE_RADIUS,
  traitMod,
} from './agents';
import { ALL_ACTIONS, type ActionContext, type Action } from './actions';

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
function shouldLog(dwarf: Dwarf, key: string, tick: number, cooldown: number): boolean {
  if (tick - (dwarf.lastLoggedTicks[key] ?? -Infinity) < cooldown) return false;
  dwarf.lastLoggedTicks[key] = tick;
  return true;
}

function updateNeeds(
  dwarf: Dwarf,
  dwarves: Dwarf[] | undefined,
  currentTick: number,
  weatherMetabolismMod: number,
  onLog?: LogFn,
): void {
  // Hunger grows every tick (cold weather burns calories faster)
  dwarf.hunger = Math.min(100, dwarf.hunger + dwarf.metabolism * weatherMetabolismMod);

  // Morale decays slowly when hungry, recovers when well-fed
  if (dwarf.hunger > 60) {
    dwarf.morale = Math.max(0, dwarf.morale - 0.4);
  } else if (dwarf.hunger < 30) {
    dwarf.morale = Math.min(100, dwarf.morale + 0.2);
  }
  // Stress metabolism — demoralized dwarves burn calories faster
  if (dwarf.morale < 25) {
    dwarf.hunger = Math.min(100, dwarf.hunger + dwarf.metabolism * 0.3);
    if (shouldLog(dwarf, 'morale_low', currentTick, 200)) {
      onLog?.('😤 morale is dangerously low', 'warn');
    }
  }
  if (dwarf.morale > 75 && shouldLog(dwarf, 'morale_high', currentTick, 300)) {
    onLog?.('😊 feeling great', 'info');
  }

  // Fatigue — tiny idle decay; traits via fatigueRate applied at action sites
  dwarf.fatigue = Math.max(0, dwarf.fatigue - 0.05);
  if (dwarf.fatigue > 90) {
    dwarf.morale = Math.max(0, dwarf.morale - 0.2);
  }
  if (dwarf.fatigue > 80 && shouldLog(dwarf, 'exhausted', currentTick, 150)) {
    onLog?.('😩 exhausted', 'warn');
  }

  // Social — check for friendly dwarf (relation >= 40) within 3 tiles
  if (dwarves) {
    const FRIEND_RADIUS = 3;
    const FRIEND_REL    = 40;
    const hasFriend = dwarves.some(
      other => other.id !== dwarf.id && other.alive &&
        Math.abs(other.x - dwarf.x) <= FRIEND_RADIUS &&
        Math.abs(other.y - dwarf.y) <= FRIEND_RADIUS &&
        (dwarf.relations[other.id] ?? 50) >= FRIEND_REL,
    );
    if (hasFriend) {
      const socialBonus = traitMod(dwarf, 'socialDecayBonus', 0);
      dwarf.social = Math.max(0, dwarf.social - (0.3 + socialBonus));
      dwarf.lastSocialTick = currentTick;
    } else if (currentTick - dwarf.lastSocialTick > 30) {
      dwarf.social = Math.min(100, dwarf.social + 0.15);
    }
  }
  if (dwarf.social > 60) {
    dwarf.morale = Math.max(0, dwarf.morale - 0.15);
    if (shouldLog(dwarf, 'lonely', currentTick, 200)) {
      onLog?.('😔 feeling lonely', 'warn');
    }
  }
}

// ── Selector loop ──────────────────────────────────────────────────────────────

export function tickAgentUtility(
  dwarf:              Dwarf,
  grid:               Tile[][],
  currentTick:        number,
  dwarves?:           Dwarf[],
  onLog?:             LogFn,
  foodStockpiles?:    FoodStockpile[],
  goblins?:           Goblin[],
  oreStockpiles?:     OreStockpile[],
  colonyGoal?:        ColonyGoal,
  woodStockpiles?:    WoodStockpile[],
  weatherMetabolismMod?: number,
): void {
  if (!dwarf.alive) return;

  // ── Safety: nudge off unwalkable tile ──────────────────────────────────
  if (!isWalkable(grid, dwarf.x, dwarf.y)) {
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    for (const d of dirs) {
      if (isWalkable(grid, dwarf.x + d.x, dwarf.y + d.y)) {
        dwarf.x += d.x; dwarf.y += d.y; break;
      }
    }
  }

  // 1. Update needs (hunger, morale, fatigue, social)
  updateNeeds(dwarf, dwarves, currentTick, weatherMetabolismMod ?? 1, onLog);

  // Fatigue > 70: 30% chance to skip action this tick (exhaustion stumble)
  if (dwarf.fatigue > 70 && Math.random() < 0.3) {
    dwarf.task = 'exhausted…';
    dwarf.fatigue = Math.max(0, dwarf.fatigue - 0.5);
    return;
  }

  // 2. Starvation damage (unconditional — not an action)
  if (dwarf.hunger >= 100 && dwarf.inventory.food === 0) {
    dwarf.health -= 2;
    dwarf.morale  = Math.max(0, dwarf.morale - 2);
    dwarf.task    = 'starving!';
    onLog?.(`is starving! (health ${dwarf.health})`, 'warn');
    if (dwarf.health <= 0) {
      dwarf.alive        = false;
      dwarf.task         = 'dead';
      dwarf.causeOfDeath = 'starvation';
      onLog?.('has died of starvation!', 'error');
      return;
    }
  }

  // 3. Expire stale LLM intent
  if (dwarf.llmIntent && currentTick > dwarf.llmIntentExpiry) {
    dwarf.llmIntent = null;
  }

  // ── 2.8-style deposit/withdraw when standing on stockpile ──────────────
  // These fire as instant reactions (not scored), same as original BT.
  const standingFoodStockpile = foodStockpiles?.find(d => d.x === dwarf.x && d.y === dwarf.y) ?? null;
  if (standingFoodStockpile) {
    if (dwarf.inventory.food >= 10) {
      const amount = dwarf.inventory.food - 6;
      const stored = Math.min(amount, standingFoodStockpile.maxFood - standingFoodStockpile.food);
      if (stored > 0) {
        standingFoodStockpile.food += stored;
        dwarf.inventory.food       -= stored;
        dwarf.task                  = `deposited ${stored.toFixed(0)} → stockpile`;
        return;
      }
    }
    if (dwarf.hunger > 60 && dwarf.inventory.food < 2 && standingFoodStockpile.food > 0) {
      const amount                = Math.min(4, standingFoodStockpile.food);
      standingFoodStockpile.food -= amount;
      dwarf.inventory.food        = Math.min(MAX_INVENTORY_FOOD, dwarf.inventory.food + amount);
      dwarf.task                  = `withdrew ${amount.toFixed(0)} from stockpile`;
      return;
    }
  }
  // Ore deposit (miners on stockpile)
  const standingOreStockpile = oreStockpiles?.find(s => s.x === dwarf.x && s.y === dwarf.y) ?? null;
  if (dwarf.role === 'miner' && standingOreStockpile && dwarf.inventory.materials > 0) {
    const stored = Math.min(dwarf.inventory.materials, standingOreStockpile.maxOre - standingOreStockpile.ore);
    if (stored > 0) {
      standingOreStockpile.ore  += stored;
      dwarf.inventory.materials -= stored;
      dwarf.task                 = `deposited ${stored.toFixed(0)} ore → stockpile`;
      return;
    }
  }
  // Wood deposit (lumberjacks on stockpile)
  const standingWoodStockpile = woodStockpiles?.find(s => s.x === dwarf.x && s.y === dwarf.y) ?? null;
  if (dwarf.role === 'lumberjack' && standingWoodStockpile && dwarf.inventory.materials > 0) {
    const stored = Math.min(dwarf.inventory.materials, standingWoodStockpile.maxWood - standingWoodStockpile.wood);
    if (stored > 0) {
      standingWoodStockpile.wood  += stored;
      dwarf.inventory.materials   -= stored;
      dwarf.task                   = `deposited ${stored.toFixed(0)} wood → stockpile`;
      return;
    }
  }

  // 4. Build action context — shared state that actions read from
  const ctx: ActionContext = {
    dwarf, grid, currentTick, dwarves, onLog,
    foodStockpiles, goblins, oreStockpiles, woodStockpiles, colonyGoal,
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
    if (dwarf.llmIntent && action.intentMatch === dwarf.llmIntent) {
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

  // Close-call log: top two scores within 0.08 and both meaningful — interesting decisions
  if (bestAction && secondScore >= 0 && bestScore - secondScore <= 0.08 && bestScore > 0.3) {
    if (shouldLog(dwarf, 'close_call', currentTick, 50)) {
      onLog?.(`⚖ torn between ${bestAction.name} and ${secondName} (${bestScore.toFixed(2)} vs ${secondScore.toFixed(2)})`, 'info');
    }
  }

  // 6. Execute highest-scoring action
  if (bestAction) {
    bestAction.execute(ctx);
  } else {
    dwarf.task = 'idle';
  }
}
