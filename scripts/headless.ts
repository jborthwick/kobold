/**
 * Headless simulation harness — runs the full Kobold sim without Phaser/React.
 *
 * Usage:
 *   npx tsx scripts/headless.ts [ticks] [seed]
 *
 * Examples:
 *   npx tsx scripts/headless.ts              # 2000 ticks, random seed
 *   npx tsx scripts/headless.ts 5000         # 5000 ticks
 *   npx tsx scripts/headless.ts 2000 42      # reproducible run with seed 42
 *
 * Output: summary table + optional JSON dump (set DUMP_JSON=1 for full per-tick data)
 *   DUMP_JSON=1 npx tsx scripts/headless.ts 1000
 */

import { generateWorld, growback } from '../src/simulation/world';
import { tickFire, tickBurningGoblins } from '../src/simulation/fire';
import { tickLightning } from '../src/simulation/lightning';
import { tickPooling } from '../src/simulation/pooling';
import { spawnGoblins, spawnSuccessor, SUCCESSION_DELAY, roomWallSlots } from '../src/simulation/agents';
import { tickAgentUtility } from '../src/simulation/utilityAI';
import { maybeSpawnRaid, tickAdventurers, resetAdventurers, spawnInitialAdventurers } from '../src/simulation/adventurers';
import { createWarmthField, createDangerField, computeWarmth, computeDanger, updateTraffic, findHearths } from '../src/simulation/diffusion';
import { createWeather, tickWeather, growbackModifier, metabolismModifier } from '../src/simulation/weather';
import { tickWorldEvents, setNextEventTick, tickMushroomSprout } from '../src/simulation/events';
import { expandStockpilesInRooms, expandLumberHutWoodStockpiles, expandBlacksmithOreStockpiles } from '../src/simulation/rooms';
import { rollWound } from '../src/simulation/wounds';
import { getActiveFaction } from '../src/shared/factions';
import { GRID_SIZE } from '../src/shared/constants';
import type { Goblin, Tile, FoodStockpile, MealStockpile, OreStockpile, WoodStockpile, PlankStockpile, BarStockpile, ColonyGoal, Adventurer, Room } from '../src/shared/types';
import { TileType } from '../src/shared/types';
import { FORAGEABLE_TILES } from '../src/simulation/agents/sites';

// ── CLI args ──────────────────────────────────────────────────────────────────

const TICKS = parseInt(process.argv[2] ?? '2000', 10);
const SEED_ARG = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
const DUMP_JSON = process.env['DUMP_JSON'] === '1';

// ── Stats ─────────────────────────────────────────────────────────────────────

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

function normalizeTaskLabel(task: string): string {
  if (task.startsWith('→')) {
    // Extract destination type: "→ kitchen", "→ water", "→ fire", "→ ore", etc.
    const match = task.match(/→\s*([a-z]+)/);
    return match ? `traveling to ${match[1]}` : 'traveling';
  }
  return task.replace(/\s*[(→].*/, '').trim() || 'idle';
}

function recordAction(goblin: Goblin, task: string) {
  const key = normalizeTaskLabel(task);
  actionCounts[key] = (actionCounts[key] ?? 0) + 1;
  const trait = goblin.trait;
  if (!actionCountsByTrait[trait]) actionCountsByTrait[trait] = {};
  actionCountsByTrait[trait][key] = (actionCountsByTrait[trait][key] ?? 0) + 1;
}

// ── Goal helpers (replicated from WorldScene) ─────────────────────────────────

type GoalType = ColonyGoal['type'];
const GOAL_CYCLE: GoalType[] = ['cook_meals', 'survive_ticks', 'defeat_adventurers'];

function makeGoal(type: GoalType, generation: number): ColonyGoal {
  const scale = 1 + generation * 0.6;
  const desc = getActiveFaction().goalDescriptions;
  switch (type) {
    case 'cook_meals': return { type, description: desc.cook_meals(Math.round(20 * scale)), progress: 0, target: Math.round(20 * scale), generation };
    case 'survive_ticks': return { type, description: desc.survive_ticks(Math.round(400 * scale)), progress: 0, target: Math.round(400 * scale), generation };
    case 'defeat_adventurers': return { type, description: desc.defeat_adventurers(Math.round(5 * scale)), progress: 0, target: Math.round(5 * scale), generation };
  }
  return { type: 'cook_meals' as const, description: '', progress: 0, target: 20, generation };
}

// ── Init ──────────────────────────────────────────────────────────────────────

console.log(`\n🧌 Kobold headless sim — ${TICKS} ticks${SEED_ARG !== undefined ? `, seed ${SEED_ARG}` : ''}\n`);

const { grid, spawnZone, seed } = generateWorld(SEED_ARG?.toString());
console.log(`   World seed: ${seed}`);

// World stats for diagnostics
let totalForageable = 0;
let forageableNearSpawn = 0;
const spawnCx = spawnZone.x + Math.floor(spawnZone.w / 2);
const spawnCy = spawnZone.y + Math.floor(spawnZone.h / 2);
for (let y = 0; y < GRID_SIZE; y++) {
  for (let x = 0; x < GRID_SIZE; x++) {
    if (FORAGEABLE_TILES.has(grid[y][x].type)) {
      totalForageable++;
      const dist = Math.sqrt((x - spawnCx) ** 2 + (y - spawnCy) ** 2);
      if (dist < 30) forageableNearSpawn++;
    }
  }
}
console.log(`   Harvestable: ${forageableNearSpawn} tiles within 30 of spawn`);
console.log(`   Total: ${totalForageable} ${[...FORAGEABLE_TILES].join('/')} tiles across ${GRID_SIZE}x${GRID_SIZE} map`);

const goblins: Goblin[] = spawnGoblins(grid, spawnZone);
let adventurers: Adventurer[] = spawnInitialAdventurers(grid, 3);
resetAdventurers();

const depotX = Math.floor(spawnZone.x + spawnZone.w / 2);
const depotY = Math.floor(spawnZone.y + spawnZone.h / 2);

// Mockup rooms: one generalized storage, one kitchen, one lumber hut, one blacksmith
const storageRoom = { id: 'room-storage', type: 'storage' as const, x: depotX - 2, y: depotY - 2, w: 5, h: 5 };
const rooms: Room[] = [
  storageRoom,
  { id: 'room-kitchen', type: 'kitchen', x: depotX + 6, y: depotY + 6, w: 5, h: 5 },
  { id: 'room-lumber', type: 'lumber_hut', x: depotX - 10, y: depotY - 2, w: 5, h: 5 },
  { id: 'room-blacksmith', type: 'blacksmith', x: depotX + 6, y: depotY - 2, w: 5, h: 5 },
];

// Hearth in kitchen
grid[depotY + 8][depotX + 8].type = TileType.Hearth;

// Initial stockpiles: one of each type inside the single storage room; meals in kitchen; wood in lumber hut corner; ore in blacksmith corner
const foodStockpiles: FoodStockpile[] = [{ x: storageRoom.x + 1, y: storageRoom.y + 1, food: 0, maxFood: 200 }];
const mealStockpiles: MealStockpile[] = [{ x: depotX + 7, y: depotY + 7, meals: 0, maxMeals: 100 }];
const oreStockpiles: OreStockpile[] = [{ x: depotX + 7, y: depotY - 1, ore: 150, maxOre: 200 }];
const woodStockpiles: WoodStockpile[] = [{ x: depotX - 9, y: depotY - 1, wood: 0, maxWood: 200 }];
const plankStockpiles: PlankStockpile[] = [];
const barStockpiles: BarStockpile[] = [];

for (const g of goblins) g.homeTile = { x: depotX, y: depotY };

let colonyGoal = makeGoal('cook_meals', 0);
let goalStartTick = 0;
let adventurerKills = 0;
const pendingSuccessions: { deadGoblinId: string; spawnAtTick: number }[] = [];
const combatHits = new Map<string, number>();

const weather = createWeather(0);
const warmthField = createWarmthField();
const dangerField = createDangerField();
const dangerPrev = createDangerField();

setNextEventTick(300 + Math.floor(Math.random() * 300));

// ── Oscillation tracking ──────────────────────────────────────────────────────
const posHistory = new Map<string, Array<{x: number, y: number, task: string}>>();
const HISTORY_LEN = 20;  // ticks of history to keep
const OSCILLATION_THRESHOLD = 10;  // min ticks in loop to flag
const MAX_UNIQUE_POSITIONS = 3;  // flag if cycling among ≤ this many tiles

// ── Tick loop ─────────────────────────────────────────────────────────────────

const t0 = Date.now();

for (let tick = 1; tick <= TICKS; tick++) {

  // Weather
  tickWeather(weather, tick);

  // Diffusion
  const hearths = findHearths(grid);
  computeWarmth(grid, hearths, foodStockpiles, weather.type, warmthField);
  computeDanger(grid, adventurers, dangerPrev, dangerField);
  dangerPrev.set(dangerField);
  updateTraffic(grid, goblins);
  for (const g of goblins) {
    if (g.alive) {
      const raw = warmthField[g.y * GRID_SIZE + g.x];
      g.warmth = (g.warmth ?? raw) * 0.95 + raw * 0.05;
    }
  }

  // Agent ticks
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
      metabolismModifier(weather), warmthField, dangerField, weather.type, rooms, mealStockpiles,
      plankStockpiles, barStockpiles,
    );
    if (g.alive) recordAction(g, g.task);
    if (wasAlive && !g.alive) {
      deathLog.push({ tick, name: g.name, cause: g.causeOfDeath ?? 'unknown' });
      pendingSuccessions.push({ deadGoblinId: g.id, spawnAtTick: tick + SUCCESSION_DELAY });
    }
  }

  // Record goblin positions and detect oscillation
  for (const g of goblins) {
    if (!g.alive) continue;
    const hist = posHistory.get(g.id) ?? [];
    hist.push({ x: g.x, y: g.y, task: g.task });
    if (hist.length > HISTORY_LEN) hist.shift();
    posHistory.set(g.id, hist);

    // Check for oscillation: if recent history cycles among ≤ MAX_UNIQUE_POSITIONS
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

  // Burning goblins + Growback + Pooling + Fire
  tickBurningGoblins(grid, tick, goblins, (msg, level) => {
    if (level === 'warn' || level === 'error') fireLog.push({ tick, message: msg });
  });
  growback(grid, growbackModifier(weather), tick);
  tickPooling(grid, tick, weather.type);
  tickLightning(grid, tick, weather.type, (msg, level) => {
    if (level === 'warn' || level === 'error') fireLog.push({ tick, message: msg });
  });
  const fireResult = tickFire(grid, tick, goblins, weather.type, (msg, level) => {
    if (level === 'warn' || level === 'error') fireLog.push({ tick, message: msg });
  });
  fireTilesTotal += fireResult.burnouts;
  fireTilesRainedOut += fireResult.extinguished;

  // Track peak fire tile count
  let fireTileCount = 0;
  for (let fy = 0; fy < GRID_SIZE; fy++)
    for (let fx = 0; fx < GRID_SIZE; fx++)
      if (grid[fy][fx].type === TileType.Fire) fireTileCount++;
  if (fireTileCount > fireTilesMax) fireTilesMax = fireTileCount;

  // Raids
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

  // World events
  tickWorldEvents(grid, tick, goblins, adventurers);
  tickMushroomSprout(grid, tick);

  // Succession
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

  // Stockpile expansion (generalized storage + lumber hut + blacksmith)
  const noop = () => {};
  expandStockpilesInRooms(
    grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles,
    noop, noop, noop,
  );
  expandLumberHutWoodStockpiles(grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles, noop);
  expandBlacksmithOreStockpiles(grid, rooms, foodStockpiles, oreStockpiles, woodStockpiles, noop);

  // Goal progress
  const alive = goblins.filter(g => g.alive);
  switch (colonyGoal.type) {
    case 'cook_meals': colonyGoal.progress = mealStockpiles.reduce((s, d) => s + d.meals, 0); break;
    case 'survive_ticks': colonyGoal.progress = tick - goalStartTick; break;
    case 'defeat_adventurers': colonyGoal.progress = adventurerKills; break;
  }
  if (colonyGoal.progress >= colonyGoal.target) {
    for (const g of alive) g.morale = Math.min(100, g.morale + 15);
    goalLog.push({ tick, type: colonyGoal.type, generation: colonyGoal.generation });
    const curr = GOAL_CYCLE.indexOf(colonyGoal.type);
    const next = GOAL_CYCLE[(curr + 1) % GOAL_CYCLE.length];
    if (next === 'defeat_adventurers') adventurerKills = 0;
    goalStartTick = tick;
    colonyGoal = makeGoal(next, colonyGoal.generation + 1);
  }

  // Snapshot every 10 ticks
  if (tick % 10 === 0) {
    const aliveNow = goblins.filter(g => g.alive);
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

const elapsed = Date.now() - t0;

// ── Report ────────────────────────────────────────────────────────────────────

const alive = goblins.filter(g => g.alive);
const last = snapshots[snapshots.length - 1];

console.log(`\n${'─'.repeat(56)}`);
console.log(` RESULTS  (${TICKS} ticks in ${elapsed}ms — ${(TICKS / (elapsed / 1000)).toFixed(0)} ticks/sec)`);
console.log(`${'─'.repeat(56)}`);
console.log(` Survivors:   ${alive.length} / ${goblins.length} total spawned`);
console.log(` Deaths:      ${deathLog.length}`);
console.log(` Raids:       ${raidLog.length} (${adventurerKills} adventurers killed)`);
console.log(` Goals done:  ${goalLog.length}`);
console.log(` Food stored: ${last?.totalFood.toFixed(0) ?? 0}`);
console.log(` Ore stored:  ${last?.totalOre.toFixed(0) ?? 0}`);
console.log(` Wood stored: ${last?.totalWood.toFixed(0) ?? 0}`);
console.log(` Avg hunger:  ${last?.avgHunger.toFixed(1) ?? '?'}`);
console.log(` Avg morale:  ${last?.avgMorale.toFixed(1) ?? '?'}`);
console.log(` Avg fatigue: ${last?.avgFatigue.toFixed(1) ?? '?'}`);
console.log(` Fire events: ${fireLog.length} ignitions · ${fireTilesTotal} tiles burned · ${fireTilesRainedOut} rained out · peak ${fireTilesMax} simultaneous`);

if (deathLog.length > 0) {
  console.log(`\n Deaths:`);
  for (const d of deathLog) {
    console.log(`   [${d.tick}] ${d.name} — ${d.cause}`);
  }
}

if (goalLog.length > 0) {
  console.log(`\n Goals completed:`);
  for (const g of goalLog) {
    console.log(`   [${g.tick}] ${g.type} (gen ${g.generation})`);
  }
}

// Action frequency table — top 15
console.log(`\n Action frequencies (top 15):`);
const totalTicks = Object.values(actionCounts).reduce((a, b) => a + b, 0);
const sorted = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
const maxCount = sorted[0]?.[1] ?? 1;
for (const [action, count] of sorted) {
  const bar = '█'.repeat(Math.round((count / maxCount) * 20));
  const pct = totalTicks ? ((count / totalTicks) * 100).toFixed(1) : '0';
  console.log(`   ${action.padEnd(24)} ${bar.padEnd(20)} ${pct}%`);
}

// Trait bias sanity check: brave vs paranoid (fight vs flee), lazy (rest share)
const traitsPresent = Object.keys(actionCountsByTrait);
const restKeys = Object.entries(actionCounts).filter(([k]) => k.startsWith('resting'));
const colonyRestTicks = restKeys.reduce((s, [, v]) => s + v, 0);
const colonyRestPct = totalTicks ? (colonyRestTicks / totalTicks) * 100 : 0;
const colonyFightTicks = Object.entries(actionCounts).reduce((s, [k, v]) => (k.startsWith('fighting') ? s + v : s), 0);
const colonyFleeTicks = actionCounts['fleeing to safety'] ?? 0;
const colonyCombatTicks = colonyFightTicks + colonyFleeTicks;

if (traitsPresent.length > 0) {
  console.log(`\n Trait bias check (action share by personality):`);
  console.log(`   Colony totals: rest ${colonyRestTicks} ticks, fight ${colonyFightTicks}, flee ${colonyFleeTicks}${restKeys.length ? ` (rest keys: ${restKeys.map(([k, v]) => `${k}=${v}`).join(', ')})` : ' (no rest keys in action list)'}`);
  let braveFightRatio: number | null = null;
  let paranoidFightRatio: number | null = null;
  let lazyRestPct: number | null = null;

  for (const trait of traitsPresent.sort()) {
    const byTrait = actionCountsByTrait[trait];
    const traitTotal = Object.values(byTrait).reduce((a, b) => a + b, 0);
    if (traitTotal < 50) continue; // skip traits with too few ticks to be meaningful
    const rest = Object.entries(byTrait).reduce((s, [k, v]) => (k.startsWith('resting') ? s + v : s), 0);
    const fight = Object.entries(byTrait).reduce((s, [k, v]) => (k.startsWith('fighting') ? s + v : s), 0);
    const flee = byTrait['fleeing to safety'] ?? 0;
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

// Oscillation summary
const oscGroups = new Map<string, number>(); // goblin name → count
for (const e of oscillationLog) {
  oscGroups.set(e.name, (oscGroups.get(e.name) ?? 0) + 1);
}
if (oscGroups.size > 0) {
  console.log('\n=== OSCILLATION LOG ===');
  // Dedupe: only print first occurrence per goblin
  const seen = new Map<string, typeof oscillationLog[0]>();
  for (const e of oscillationLog) {
    if (!seen.has(e.name)) seen.set(e.name, e);
  }
  for (const [name, count] of [...oscGroups.entries()].sort((a, b) => b[1] - a[1])) {
    const first = seen.get(name)!;
    const taskStr = first.tasks.length > 1 ? `tasks=[${first.tasks.join(' ↔ ')}]` : `task="${first.task}"`;
    console.log(
      `  ${name} (${first.role}): oscillated ${count} ticks | ${taskStr} | tiles=[${first.positions.join(', ')}]`
    );
  }
} else {
  console.log('\n✓ No oscillation detected.');
}

if (DUMP_JSON) {
  const outPath = `headless-${seed}-${TICKS}.json`;
  const fs = await import('node:fs/promises');
  await fs.writeFile(outPath, JSON.stringify({ seed, ticks: TICKS, snapshots, deathLog, raidLog, goalLog, actionCounts, actionCountsByTrait, warnLog, fireLog, fireTilesMax, fireTilesTotal, oscillationLog }, null, 2));
  console.log(`\n JSON dumped → ${outPath}`);
}

console.log();
