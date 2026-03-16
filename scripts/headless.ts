/**
 * Headless simulation harness — runs the full Kobold sim without Phaser/React.
 * Uses the same simulation APIs (world, utilityAI, diffusion, fire, adventurers, etc.)
 * with a minimal harness: fixed rooms/stockpiles, no UI. Used for tuning (action
 * frequencies, need drift) and regression runs (see AGENTS.md headless section).
 *
 * Usage:
 *   npx tsx scripts/headless.ts [ticks] [seed]
 *
 * Examples:
 *   npx tsx scripts/headless.ts              # 2000 ticks, random seed
 *   npx tsx scripts/headless.ts 5000         # 5000 ticks
 *   npx tsx scripts/headless.ts 2000 42      # reproducible run with seed 42
 *
 * Output: summary table + action frequency bar chart + trait bias + oscillation log.
 * Optional JSON dump: DUMP_JSON=1 npx tsx scripts/headless.ts 1000
 */

import { generateWorld, growback } from '../src/simulation/world';
import { tickFire, tickBurningGoblins } from '../src/simulation/fire';
import { tickLightning } from '../src/simulation/lightning';
import { tickPooling } from '../src/simulation/pooling';
import { spawnGoblins, spawnSuccessor, SUCCESSION_DELAY } from '../src/simulation/agents';
import { tickAgentUtility } from '../src/simulation/utilityAI';
import { maybeSpawnRaid, tickAdventurers, resetAdventurers, spawnInitialAdventurers } from '../src/simulation/adventurers';
import { createDangerField, computeGoblinWarmth, computeDanger, updateTraffic } from '../src/simulation/diffusion';
import { createWeather, tickWeather, growbackModifier, metabolismModifier } from '../src/simulation/weather';
import { tickWorldEvents, setNextEventTick, tickMushroomSprout } from '../src/simulation/events';
import { expandStockpilesInRooms, expandLumberHutWoodStockpiles, expandBlacksmithOreStockpiles, clearRoomGroundToDirt } from '../src/simulation/rooms';
import { rollWound } from '../src/simulation/wounds';
import { getGoblinConfig } from '../src/shared/goblinConfig';
import { GRID_SIZE, HEARTH_FUEL_MAX } from '../src/shared/constants';
import type { Goblin, FoodStockpile, MealStockpile, OreStockpile, WoodStockpile, PlankStockpile, BarStockpile, ColonyGoal, Adventurer, Room } from '../src/shared/types';
import { TileType } from '../src/shared/types';
import { FORAGEABLE_TILES } from '../src/simulation/agents/sites';

// ── CLI args ──────────────────────────────────────────────────────────────────
// argv[2] = tick count (default 2000), argv[3] = optional seed for reproducible worlds.

const TICKS = parseInt(process.argv[2] ?? '2000', 10);
const SEED_ARG = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
const DUMP_JSON = process.env['DUMP_JSON'] === '1';

// Headless reporting constants (tuning / output shape)
const SNAPSHOT_INTERVAL = 10;
const TOP_ACTIONS_COUNT = 15;
const MIN_TRAIT_TICKS = 50;
const BAR_WIDTH = 20;
const SPAWN_NEAR_RADIUS = 30;

// ── Stats (recording buffers) ─────────────────────────────────────────────────
// These are filled during the tick loop and printed in the report section.

interface TickSnapshot {
  tick: number;
  alive: number;
  totalFood: number;
  totalOre: number;
  totalWood: number;
  avgHunger: number;
  avgMorale: number;
  avgFatigue: number;
  raiders: number;
}

const snapshots: TickSnapshot[] = [];
const actionCounts: Record<string, number> = {};
/** Per-trait action counts for trait-bias validation (brave vs flee, lazy rest, etc.) */
const actionCountsByTrait: Record<string, Record<string, number>> = {};
const deathLog: { tick: number; name: string; cause: string }[] = [];
const raidLog: { tick: number; count: number }[] = [];
const goalLog: { tick: number; type: string; generation: number }[] = [];
const warnLog: { tick: number; name: string; message: string }[] = [];
const fireLog: { tick: number; message: string }[] = [];
const oscillationLog: Array<{
  tick: number;
  name: string;
  role: string;
  task: string;
  positions: string[];
  tasks: string[];  // unique tasks during oscillation
}> = [];
let fireTilesMax = 0;  // peak simultaneous fire tile count
let fireTilesTotal = 0;  // cumulative tiles that burned or were extinguished
let fireTilesRainedOut = 0;  // tiles extinguished by rain

/** Normalize raw task string to a short bucket label for the action frequency table (e.g. "→ kitchen" → "traveling to kitchen"). */
function normalizeTaskLabel(task: string): string {
  if (task.startsWith('→')) {
    const match = task.match(/→\s*([a-z]+)/);
    return match ? `traveling to ${match[1]}` : 'traveling';
  }
  return task.replace(/\s*[(→].*/, '').trim() || 'idle';
}

/** Record one goblin-tick's action into global actionCounts and actionCountsByTrait for the report. */
function recordAction(goblin: Goblin, task: string) {
  const key = normalizeTaskLabel(task);
  actionCounts[key] = (actionCounts[key] ?? 0) + 1;
  const trait = goblin.trait;
  if (!actionCountsByTrait[trait]) actionCountsByTrait[trait] = {};
  actionCountsByTrait[trait][key] = (actionCountsByTrait[trait][key] ?? 0) + 1;
}

/** Sum action counts; optional keyPredicate limits to keys matching a predicate (e.g. rest/fight/flee). */
function sumActionCounts(counts: Record<string, number>, keyPredicate?: (key: string) => boolean): number {
  if (!keyPredicate) return Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.entries(counts).reduce((s, [k, v]) => (keyPredicate(k) ? s + v : s), 0);
}

/** Log world seed and harvestable tile stats at startup. */
function logHeadlessInit(seed: string, forageableNearSpawn: number, totalForageable: number): void {
  console.log(`   World seed: ${seed}`);
  console.log(`   Harvestable: ${forageableNearSpawn} tiles within ${SPAWN_NEAR_RADIUS} of spawn`);
  console.log(`   Total: ${totalForageable} ${[...FORAGEABLE_TILES].join('/')} tiles across ${GRID_SIZE}x${GRID_SIZE} map`);
}

// ── Goal helpers ──────────────────────────────────────────────────────────────
// Contract: keep in sync with src/game/scenes/WorldGoals.ts (makeGoal scale/targets)
// and goal progress (cook_meals = meal count, survive_ticks = tick delta, defeat_adventurers = kill count).
// Headless uses a subset cycle (no build_rooms) and tracks progress from stockpiles/tick/kills.

type GoalType = ColonyGoal['type'];
const GOAL_CYCLE: GoalType[] = ['cook_meals', 'survive_ticks', 'defeat_adventurers'];

/** Build a colony goal with scaled target; scale increases per generation so later goals are harder. */
function makeGoal(type: GoalType, generation: number): ColonyGoal {
  const scale = 1 + generation * 0.6;
  const desc = getGoblinConfig().goalDescriptions;
  switch (type) {
    case 'cook_meals': return { type, description: desc.cook_meals(Math.round(20 * scale)), progress: 0, target: Math.round(20 * scale), generation };
    case 'survive_ticks': return { type, description: desc.survive_ticks(Math.round(400 * scale)), progress: 0, target: Math.round(400 * scale), generation };
    case 'defeat_adventurers': return { type, description: desc.defeat_adventurers(Math.round(5 * scale)), progress: 0, target: Math.round(5 * scale), generation };
  }
  return { type: 'cook_meals' as const, description: '', progress: 0, target: 20, generation };
}

// ── Init ──────────────────────────────────────────────────────────────────────
// Build world, spawn agents, set up rooms/stockpiles/hearth and diffusion state.
// No Phaser/React — same simulation APIs as the game, with a minimal harness.

console.log(`\n🧌 Kobold headless sim — ${TICKS} ticks${SEED_ARG !== undefined ? `, seed ${SEED_ARG}` : ''}\n`);

const { grid, spawnZone, seed } = generateWorld(SEED_ARG?.toString());

// Count harvestable tiles (forageable near spawn and total) for startup diagnostics.
let totalForageable = 0;
let forageableNearSpawn = 0;
const spawnCx = spawnZone.x + Math.floor(spawnZone.w / 2);
const spawnCy = spawnZone.y + Math.floor(spawnZone.h / 2);
for (let y = 0; y < GRID_SIZE; y++) {
  for (let x = 0; x < GRID_SIZE; x++) {
    if (FORAGEABLE_TILES.has(grid[y][x].type)) {
      totalForageable++;
      const dist = Math.sqrt((x - spawnCx) ** 2 + (y - spawnCy) ** 2);
      if (dist < SPAWN_NEAR_RADIUS) forageableNearSpawn++;
    }
  }
}
logHeadlessInit(seed, forageableNearSpawn, totalForageable);

const goblins: Goblin[] = spawnGoblins(grid, spawnZone);
let adventurers: Adventurer[] = spawnInitialAdventurers(grid, 3);
resetAdventurers();

const depotX = Math.floor(spawnZone.x + spawnZone.w / 2);
const depotY = Math.floor(spawnZone.y + spawnZone.h / 2);

// Starter layout: one storage room near spawn, matching GUI new-colony flow (no kitchen/lumber_hut/blacksmith).
const storageRoom: Room = { id: 'room-storage', type: 'storage', x: depotX - 2, y: depotY - 2, w: 5, h: 5 };
const rooms: Room[] = [storageRoom];

// Place a hearth a short walk from spawn so warmth/diffusion behave similarly to the main game.
const hearthCell = grid[depotY + 8][depotX + 8];
grid[depotY + 8][depotX + 8] = { ...hearthCell, type: TileType.Hearth, foodValue: 0, maxFood: 0, materialValue: 0, maxMaterial: 0, growbackRate: 0, hearthFuel: HEARTH_FUEL_MAX };

// Stockpiles: start with a single empty food stockpile in storage; other piles will be established by actions.
const foodStockpiles: FoodStockpile[] = [{ x: storageRoom.x + 1, y: storageRoom.y + 1, food: 0, maxFood: 200 }];
const mealStockpiles: MealStockpile[] = [];
const oreStockpiles: OreStockpile[] = [];
const woodStockpiles: WoodStockpile[] = [];
const plankStockpiles: PlankStockpile[] = [];
const barStockpiles: BarStockpile[] = [];

for (const g of goblins) {
  g.homeTile = { x: depotX, y: depotY };
}

let colonyGoal = makeGoal('cook_meals', 0);
let goalStartTick = 0;
let adventurerKills = 0;
const pendingSuccessions: { deadGoblinId: string; spawnAtTick: number }[] = [];
const combatHits = new Map<string, number>();

const weather = createWeather(0);
const dangerField = createDangerField();
const dangerPrev = createDangerField();

setNextEventTick(300 + Math.floor(Math.random() * 300));

// ── Oscillation tracking ──────────────────────────────────────────────────────
// Per-goblin position/task history; used to detect agents cycling among few tiles (e.g. A↔B↔C).
const posHistory = new Map<string, Array<{x: number, y: number, task: string}>>();
const HISTORY_LEN = 20;  // ticks of history to keep
const OSCILLATION_THRESHOLD = 10;  // min ticks in loop to flag
const MAX_UNIQUE_POSITIONS = 3;  // flag if cycling among ≤ this many tiles

// ── Simulation tick steps ──────────────────────────────────────────────────────
// Each function runs one part of the tick. Order matches game logic: weather → diffusion → agents → fire/env → raids → events → succession → stockpiles → goal/snapshot.

function runWeatherTick(tick: number): void {
  tickWeather(weather, tick);
}

/** Per-goblin warmth (shelter-style); danger from adventurers; traffic. */
function runDiffusionTick(tick: number): void {
  computeDanger(grid, adventurers, dangerPrev, dangerField);
  dangerPrev.set(dangerField);
  updateTraffic(grid, goblins);
  for (const g of goblins) {
    if (g.alive) {
      const raw = computeGoblinWarmth(g, grid, rooms, weather.type);
      g.warmth = (g.warmth ?? raw) * 0.95 + raw * 0.05;
    }
  }
}

/** Run utility AI for each goblin; record action and log death/succession when one just died. */
function runAgentTicks(tick: number): void {
  for (const g of goblins) {
    const wasAlive = g.alive;
    tickAgentUtility(
      g, grid, tick, goblins,
      (message, level) => {
        if (level === 'warn' || level === 'error') {
          warnLog.push({ tick, name: g.name, message });
        }
      },
      foodStockpiles, adventurers, oreStockpiles, colonyGoal, woodStockpiles,
      metabolismModifier(weather), dangerField, weather.type, rooms, mealStockpiles,
      plankStockpiles, barStockpiles,
    );
    if (g.alive) recordAction(g, g.task);
    if (wasAlive && !g.alive) {
      deathLog.push({ tick, name: g.name, cause: g.causeOfDeath ?? 'unknown' });
      pendingSuccessions.push({ deadGoblinId: g.id, spawnAtTick: tick + SUCCESSION_DELAY });
    }
  }
}

/** Append current position/task to history; if recent history has ≤MAX_UNIQUE_POSITIONS unique tiles, log oscillation. */
function recordOscillation(tick: number): void {
  for (const g of goblins) {
    if (!g.alive) continue;
    const hist = posHistory.get(g.id) ?? [];
    hist.push({ x: g.x, y: g.y, task: g.task });
    if (hist.length > HISTORY_LEN) hist.shift();
    posHistory.set(g.id, hist);

    // Oscillation = cycling among few tiles in the last OSCILLATION_THRESHOLD ticks.
    if (hist.length >= OSCILLATION_THRESHOLD) {
      const recent = hist.slice(-OSCILLATION_THRESHOLD);
      const uniquePos = new Set(recent.map(p => `${p.x},${p.y}`));
      const uniqueTasks = new Set(recent.map(p => normalizeTaskLabel(p.task)));
      if (uniquePos.size <= MAX_UNIQUE_POSITIONS) {
        oscillationLog.push({
          tick,
          name: g.name,
          role: g.role,
          task: g.task,
          positions: [...uniquePos],
          tasks: [...uniqueTasks],
        });
      }
    }
  }
}

/** Burning goblins, growback, pooling, lightning, fire spread; accumulate fire stats for report. */
function runFireAndEnvironment(tick: number): void {
  const fireCb = (msg: string, level: string) => {
    if (level === 'warn' || level === 'error') fireLog.push({ tick, message: msg });
  };
  tickBurningGoblins(grid, tick, goblins, fireCb);
  growback(grid, growbackModifier(weather), tick);
  tickPooling(grid, tick, weather.type);
  tickLightning(grid, tick, weather.type, fireCb);
  const fireResult = tickFire(grid, tick, goblins, weather.type, fireCb);
  fireTilesTotal += fireResult.burnouts;
  fireTilesRainedOut += fireResult.extinguished;

  let fireTileCount = 0;
  for (let fy = 0; fy < GRID_SIZE; fy++)
    for (let fx = 0; fx < GRID_SIZE; fx++)
      if (grid[fy][fx].type === TileType.Fire) fireTileCount++;
  if (fireTileCount > fireTilesMax) fireTilesMax = fireTileCount;
}

/** Maybe spawn a raid (log to raidLog); tick adventurers, apply damage/wounds, log deaths and schedule succession. */
function runRaidsAndCombat(tick: number): void {
  const raid = maybeSpawnRaid(grid, goblins, tick);
  if (raid) {
    adventurers.push(...raid.adventurers);
    raidLog.push({ tick, count: raid.count });
  }

  if (adventurers.length > 0) {
    const gr = tickAdventurers(adventurers, goblins, grid, tick);
    for (const { goblinId, damage } of gr.attacks) {
      const g = goblins.find(d => d.id === goblinId);
      if (g && g.alive) {
        g.health = Math.max(0, g.health - damage);
        g.morale = Math.max(0, g.morale - 5);
        if (g.health <= 0) {
          g.alive = false;
          g.task = 'dead';
          g.causeOfDeath = 'killed by adventurers';
          deathLog.push({ tick, name: g.name, cause: g.causeOfDeath });
          pendingSuccessions.push({ deadGoblinId: g.id, spawnAtTick: tick + SUCCESSION_DELAY });
        } else {
          const hits = (combatHits.get(g.id) ?? 0) + 1;
          combatHits.set(g.id, hits);
          const w = rollWound(g, tick);
          if (w) g.wound = w;
        }
      }
    }
    adventurerKills += gr.adventurerDeaths.length;
    const deadIds = new Set(gr.adventurerDeaths);
    adventurers = adventurers.filter(a => !deadIds.has(a.id));
    combatHits.forEach((_, id) => { if (deadIds.has(id)) combatHits.delete(id); });
  }
}

/** World events + mushroom sprout; then process pending successions (spawn replacement goblins after SUCCESSION_DELAY). */
function runWorldEventsAndSuccession(tick: number): void {
  tickWorldEvents(grid, tick, goblins, adventurers);
  tickMushroomSprout(grid, tick);

  // At tick 400, add a lumber hut near storage so headless matches a mid-game GUI where the player
  // has built their first wood-processing room. This lets us observe chop/saw/wood stockpiling.
  if (tick === 400) {
    const lumberX = storageRoom.x - 8;
    const lumberY = storageRoom.y;
    clearRoomGroundToDirt(grid, lumberX, lumberY, 5, 5);
    const lumberRoom: Room = {
      id: 'room-lumber',
      type: 'lumber_hut',
      x: lumberX,
      y: lumberY,
      w: 5,
      h: 5,
    };
    rooms.push(lumberRoom);
    // Match GUI: place an initial empty wood stockpile at (x+1,y+1) inside the lumber hut.
    woodStockpiles.push({ x: lumberX + 1, y: lumberY + 1, wood: 0, maxWood: 200 });
  }

  for (let i = pendingSuccessions.length - 1; i >= 0; i--) {
    const s = pendingSuccessions[i];
    if (tick < s.spawnAtTick) continue;
    pendingSuccessions.splice(i, 1);
    const dead = goblins.find(g => g.id === s.deadGoblinId);
    if (!dead) continue;
    const successor = spawnSuccessor(dead, grid, spawnZone, goblins, tick);
    const home = foodStockpiles[0] ?? { x: depotX, y: depotY };
    successor.homeTile = { x: home.x, y: home.y };
    goblins.push(successor);
    successor.memory.push({ tick, crisis: 'arrival', action: `arrived to replace ${dead.name}` });
  }
}

/** Expand storage/lumber/blacksmith stockpiles when rooms qualify (callbacks are no-op; no UI). */
function runStockpileExpansion(): void {
  const noop = () => {};
  expandStockpilesInRooms(
    grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles,
    noop, noop, noop,
  );
  expandLumberHutWoodStockpiles(grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles, noop);
  expandBlacksmithOreStockpiles(grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles, noop);
}

/** Update goal progress from stockpiles/tick/kills; on completion bump morale, cycle to next goal, push to goalLog. Every SNAPSHOT_INTERVAL ticks push a snapshot for need drift / final report. */
function runGoalProgressAndSnapshot(tick: number): void {
  const aliveNow = goblins.filter(g => g.alive);
  switch (colonyGoal.type) {
    case 'cook_meals': colonyGoal.progress = mealStockpiles.reduce((s, d) => s + d.meals, 0); break;
    case 'survive_ticks': colonyGoal.progress = tick - goalStartTick; break;
    case 'defeat_adventurers': colonyGoal.progress = adventurerKills; break;
  }
  if (colonyGoal.progress >= colonyGoal.target) {
    for (const g of aliveNow) g.morale = Math.min(100, g.morale + 15);
    goalLog.push({ tick, type: colonyGoal.type, generation: colonyGoal.generation });
    const curr = GOAL_CYCLE.indexOf(colonyGoal.type);
    const next = GOAL_CYCLE[(curr + 1) % GOAL_CYCLE.length];
    if (next === 'defeat_adventurers') adventurerKills = 0;
    goalStartTick = tick;
    colonyGoal = makeGoal(next, colonyGoal.generation + 1);
  }

  if (tick % SNAPSHOT_INTERVAL === 0) {
    snapshots.push({
      tick,
      alive: aliveNow.length,
      totalFood: foodStockpiles.reduce((s, d) => s + d.food, 0),
      totalOre: oreStockpiles.reduce((s, d) => s + d.ore, 0),
      totalWood: woodStockpiles.reduce((s, d) => s + d.wood, 0),
      avgHunger: aliveNow.length ? aliveNow.reduce((s, g) => s + g.hunger, 0) / aliveNow.length : 0,
      avgMorale: aliveNow.length ? aliveNow.reduce((s, g) => s + g.morale, 0) / aliveNow.length : 0,
      avgFatigue: aliveNow.length ? aliveNow.reduce((s, g) => s + g.fatigue, 0) / aliveNow.length : 0,
      raiders: adventurers.length,
    });
  }
}

/** Runs one full simulation tick. runAgentTicks also records action counts and death/succession; recordOscillation runs after agents. */
function runSimulationTick(tick: number): void {
  runWeatherTick(tick);
  runDiffusionTick(tick);
  runAgentTicks(tick);
  recordOscillation(tick);
  runFireAndEnvironment(tick);
  runRaidsAndCombat(tick);
  runWorldEventsAndSuccession(tick);
  runStockpileExpansion();
  runGoalProgressAndSnapshot(tick);
}

/** Reserved for any recording that must run after the full tick (currently unused). */
function recordTickResults(_tick: number): void {}

// ── Tick loop ─────────────────────────────────────────────────────────────────
// Run TICKS simulation ticks; recording (actionCounts, logs, snapshots) happens inside runSimulationTick.

const t0 = Date.now();

for (let tick = 1; tick <= TICKS; tick++) {
  runSimulationTick(tick);
  recordTickResults(tick);
}

const elapsed = Date.now() - t0;

// ── Report helpers ────────────────────────────────────────────────────────────
// Each function prints one section of the final report (results table, deaths, goals, action frequencies, trait bias, oscillation). No game state changes.

function printResultsTable(
  ticks: number,
  elapsedMs: number,
  aliveCount: number,
  totalSpawned: number,
  deaths: number,
  raids: number,
  adventurerKills: number,
  goalsDone: number,
  last: TickSnapshot | undefined,
  fireLogLen: number,
  fireTilesTotal: number,
  fireTilesRainedOut: number,
  fireTilesMax: number,
): void {
  console.log(`\n${'─'.repeat(56)}`);
  console.log(` RESULTS  (${ticks} ticks in ${elapsedMs}ms — ${(ticks / (elapsedMs / 1000)).toFixed(0)} ticks/sec)`);
  console.log(`${'─'.repeat(56)}`);
  console.log(` Survivors:   ${aliveCount} / ${totalSpawned} total spawned`);
  console.log(` Deaths:      ${deaths}`);
  console.log(` Raids:       ${raids} (${adventurerKills} adventurers killed)`);
  console.log(` Goals done:  ${goalsDone}`);
  console.log(` Food stored: ${last?.totalFood.toFixed(0) ?? 0}`);
  console.log(` Ore stored:  ${last?.totalOre.toFixed(0) ?? 0}`);
  console.log(` Wood stored: ${last?.totalWood.toFixed(0) ?? 0}`);
  console.log(` Avg hunger:  ${last?.avgHunger.toFixed(1) ?? '?'}`);
  console.log(` Avg morale:  ${last?.avgMorale.toFixed(1) ?? '?'}`);
  console.log(` Avg fatigue: ${last?.avgFatigue.toFixed(1) ?? '?'}`);
  console.log(` Fire events: ${fireLogLen} ignitions · ${fireTilesTotal} tiles burned · ${fireTilesRainedOut} rained out · peak ${fireTilesMax} simultaneous`);
}

function printWarnings(log: { tick: number; name: string; message: string }[]): void {
  if (log.length === 0) return;
  console.log(`\n Warnings:`);
  for (const w of log) {
    console.log(`   [${w.tick}] ${w.name}: ${w.message}`);
  }
}

function printDeaths(log: { tick: number; name: string; cause: string }[]): void {
  if (log.length === 0) return;
  console.log(`\n Deaths:`);
  for (const d of log) {
    console.log(`   [${d.tick}] ${d.name} — ${d.cause}`);
  }
}

function printGoalsCompleted(log: { tick: number; type: string; generation: number }[]): void {
  if (log.length === 0) return;
  console.log(`\n Goals completed:`);
  for (const g of log) {
    console.log(`   [${g.tick}] ${g.type} (gen ${g.generation})`);
  }
}

/** Print top TOP_ACTIONS_COUNT actions with bar chart and percentage of total goblin-ticks. */
function printActionFrequencies(counts: Record<string, number>): void {
  console.log(`\n Action frequencies (top ${TOP_ACTIONS_COUNT}):`);
  const total = sumActionCounts(counts);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, TOP_ACTIONS_COUNT);
  const maxCount = sorted[0]?.[1] ?? 1;
  for (const [action, count] of sorted) {
    const bar = '█'.repeat(Math.round((count / maxCount) * BAR_WIDTH));
    const pct = total ? ((count / total) * 100).toFixed(1) : '0';
    console.log(`   ${action.padEnd(24)} ${bar.padEnd(BAR_WIDTH)} ${pct}%`);
  }
}

/** Print per-trait action share (rest/fight/flee) and sanity checks for brave vs paranoid, lazy rest. */
function printTraitBias(
  byTrait: Record<string, Record<string, number>>,
  counts: Record<string, number>,
): void {
  const traitsPresent = Object.keys(byTrait);
  if (traitsPresent.length === 0) return;
  const totalTicks = sumActionCounts(counts);
  const colonyRestTicks = sumActionCounts(counts, k => k.startsWith('resting'));
  const colonyRestPct = totalTicks ? (colonyRestTicks / totalTicks) * 100 : 0;
  const colonyFightTicks = sumActionCounts(counts, k => k.startsWith('fighting'));
  const colonyFleeTicks = counts['fleeing to safety'] ?? 0;
  const colonyCombatTicks = colonyFightTicks + colonyFleeTicks;
  const restKeys = Object.entries(counts).filter(([k]) => k.startsWith('resting'));

  console.log(`\n Trait bias check (action share by personality):`);
  console.log(`   Colony totals: rest ${colonyRestTicks} ticks, fight ${colonyFightTicks}, flee ${colonyFleeTicks}${restKeys.length ? ` (rest keys: ${restKeys.map(([k, v]) => `${k}=${v}`).join(', ')})` : ' (no rest keys in action list)'}`);
  let braveFightRatio: number | null = null;
  let paranoidFightRatio: number | null = null;
  let lazyRestPct: number | null = null;

  for (const trait of traitsPresent.sort()) {
    const traitCounts = byTrait[trait];
    const traitTotal = Object.values(traitCounts).reduce((a, b) => a + b, 0);
    if (traitTotal < MIN_TRAIT_TICKS) continue;
    const rest = Object.entries(traitCounts).reduce((s, [k, v]) => (k.startsWith('resting') ? s + v : s), 0);
    const fight = Object.entries(traitCounts).reduce((s, [k, v]) => (k.startsWith('fighting') ? s + v : s), 0);
    const flee = traitCounts['fleeing to safety'] ?? 0;
    const combatTotal = fight + flee;
    const restPct = traitTotal ? (rest / traitTotal) * 100 : 0;
    const fightRatio = combatTotal > 10 ? fight / combatTotal : null;

    if (trait === 'brave' && fightRatio !== null) braveFightRatio = fightRatio;
    if (trait === 'paranoid' && fightRatio !== null) paranoidFightRatio = fightRatio;
    if (trait === 'lazy') lazyRestPct = restPct;

    const restVsColony = colonyRestPct > 0 ? (restPct / colonyRestPct).toFixed(2) : '—';
    const combatNote = combatTotal > 10 ? ` fight/(fight+flee)=${(fightRatio! * 100).toFixed(0)}%` : '';
    console.log(`   ${trait.padEnd(12)} rest ${restPct.toFixed(1)}% (${rest}/${traitTotal} ticks, vs colony ${restVsColony}x)${combatNote}`);
  }

  const checks: string[] = [];
  if (braveFightRatio !== null && paranoidFightRatio !== null && braveFightRatio >= paranoidFightRatio) {
    checks.push('brave fight ratio ≥ paranoid');
  } else if (braveFightRatio !== null && paranoidFightRatio !== null) {
    checks.push('brave fight ratio < paranoid (unexpected)');
  }
  if (lazyRestPct !== null && colonyRestPct > 0 && lazyRestPct >= colonyRestPct * 0.9) {
    checks.push('lazy rest share ≥ colony avg');
  } else if (lazyRestPct !== null && colonyRestPct > 0) {
    checks.push('lazy rest share below colony avg');
  }
  if (checks.length > 0) {
    console.log(`   → ${checks.join('; ')}`);
  }
  if (colonyRestTicks === 0 || colonyCombatTicks === 0) {
    console.log(`   Tip: ${colonyRestTicks === 0 ? 'Rest action rarely wins in headless (fatigue stays low). ' : ''}${colonyCombatTicks === 0 ? 'No fight/flee ticks (raids or danger not in range). ' : ''}Trait bias applies when those actions occur.`);
  }
}

/** Group oscillation log by goblin name, dedupe to first occurrence per goblin, print one line per oscillator. */
function printOscillation(
  log: Array<{ tick: number; name: string; role: string; task: string; positions: string[]; tasks: string[] }>,
): void {
  const groups = new Map<string, number>();
  for (const e of log) {
    groups.set(e.name, (groups.get(e.name) ?? 0) + 1);
  }
  if (groups.size === 0) {
    console.log('\n✓ No oscillation detected.');
    return;
  }
  console.log('\n=== OSCILLATION LOG ===');
  const seen = new Map<string, typeof log[0]>();
  for (const e of log) {
    if (!seen.has(e.name)) seen.set(e.name, e);
  }
  for (const [name, count] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
    const first = seen.get(name)!;
    const taskStr = first.tasks.length > 1 ? `tasks=[${first.tasks.join(' ↔ ')}]` : `task="${first.task}"`;
    console.log(
      `  ${name} (${first.role}): oscillated ${count} ticks | ${taskStr} | tiles=[${first.positions.join(', ')}]`
    );
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
// Print all sections from the recording buffers; optionally write full JSON when DUMP_JSON=1.

const alive = goblins.filter(g => g.alive);
const last = snapshots[snapshots.length - 1];

printResultsTable(
  TICKS,
  elapsed,
  alive.length,
  goblins.length,
  deathLog.length,
  raidLog.length,
  adventurerKills,
  goalLog.length,
  last,
  fireLog.length,
  fireTilesTotal,
  fireTilesRainedOut,
  fireTilesMax,
);
printWarnings(warnLog);
printDeaths(deathLog);
printGoalsCompleted(goalLog);
printActionFrequencies(actionCounts);
printTraitBias(actionCountsByTrait, actionCounts);
printOscillation(oscillationLog);

if (DUMP_JSON) {
  const outPath = `headless-${seed}-${TICKS}.json`;
  const fs = await import('node:fs/promises');
  await fs.writeFile(outPath, JSON.stringify({ seed, ticks: TICKS, snapshots, deathLog, raidLog, goalLog, actionCounts, actionCountsByTrait, warnLog, fireLog, fireTilesMax, fireTilesTotal, fireTilesRainedOut, oscillationLog }, null, 2));
  console.log(`\n JSON dumped → ${outPath}`);
}

console.log();
