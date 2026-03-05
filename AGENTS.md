# Goblin Colony Sim — Agent Instructions

A browser-based colony survival game inspired by RimWorld and Dwarf Fortress. Small colony of LLM-driven goblin agents operating in a tile-based world with emergent behavior arising from resource scarcity. The LLM is a crisis decision-maker, not a chatbot. The tone is darkly humorous — goblins take themselves seriously despite constant chaos.

---

## Commands

```bash
npm run dev          # dev server + LLM proxy at http://localhost:5173
npm run build        # tsc -b && vite build
npx tsc --noEmit     # type-check only (preferred before commits)
npm run lint         # eslint
npm run headless     # headless sim (2000 ticks, random seed) — see below
python3 scripts/inspect-tiles.py --frame N   # inspect Kenney tile by frame index
```

**Required:** At least one API Key in `.env.local` (gitignored) — LLM proxy won't work without it.
LLM is off by default in-game (🤖 toggle). HMR works for most changes; full reload needed for `crisis.ts` singleton.

## Headless simulation (`scripts/headless.ts`)

Runs the full simulation (world gen, utility AI, weather, raids, diffusion, events) without
Phaser or React at ~1600 ticks/sec — about 240× real-time. No LLM calls (deterministic only).
**Use this whenever tuning action scores, eligibility thresholds, or need curves.**

```bash
npm run headless                      # 2000 ticks, random seed
npx tsx scripts/headless.ts 5000      # 5000 ticks
npx tsx scripts/headless.ts 3000 42   # reproducible run (same seed = same world)
DUMP_JSON=1 npx tsx scripts/headless.ts 1000   # full per-tick JSON to stdout
```

Output includes a **summary table** (survivors, deaths, goals, stockpile levels, avg needs)
and an **action frequency bar chart** that shows the percentage of goblin-ticks spent in each
task bucket. This is the primary tool for catching:

- **Score imbalances** — an action dominating (>20%) that shouldn't, or never firing (<0.5%) when it should
- **Need drift** — avg hunger/morale/fatigue trending wrong over time
- **Starvation cascades** — deaths clustered in specific tick ranges
- **Goal throughput** — how many goals complete in N ticks (regression test for difficulty)

**Interpreting the action frequency table:**

| Label | Source | Healthy range |
|-------|--------|---------------|
| `traveling` | `→ target` movement tasks | 40–55% (goblins move a lot) |
| `exploring` | `wander` action | 15–30% (fallback when no urgent need) |
| `harvesting` | `forage` on tile | >1% (forager role present) |
| `mining` / `logging` | `mine` / `chop` | scales with need; drops to ~0.2 when stockpile full |
| `socializing` | `socialize` | <8% (spikes mean social need isn't being met) |
| `fleeing to safety` | `seekSafety` | <5% (spikes mean raid pressure too high) |
| `idle` | execute returned early, no task set | <2% (any spike = action bug) |

**Action frequency normalization:** task strings are bucketed by stripping everything after
`(` or `→`. Navigation tasks starting with `→` are labeled `traveling`. Bare strings like
`'idle'`, `'socializing'`, `'brooding'` pass through unchanged. If `idle` spikes, check
for action `execute()` paths that return early without setting `goblin.task`.

**Workflow for tuning an action:**
1. Run 2–3 seeds at 3000 ticks; note the action's share and avg needs
2. Edit the `score()` or `eligible()` function
3. Re-run the same seeds; compare action share and need metrics
4. Type-check: `npx tsc --noEmit`

## Phaser 3 camera gotcha

`cam.scrollX` is **not** the world position at the left edge — the camera uses a viewport-centred transform.
Zoom-to-cursor correct formula:
```typescript
const f = 1 / oldZoom - 1 / newZoom;
cam.scrollX += (ptr.x - cam.x - cam.width / 2) * f;
cam.scrollY += (ptr.y - cam.y - cam.height / 2) * f;
```

---

## Stack & architecture

TypeScript 5 · Vite 7 · Phaser 3.90+ · React 19 · rot.js 2 (A* pathfinding) · mitt event bus · claude-haiku-4-5 via `/api/llm-proxy` · Kenney 1-bit Pack (CC0)

Everything runs on **one main thread**: Phaser game loop (~150ms/tick) + React HUD overlay + simulation.
React receives state via `bus.emit('gameState', state)` each tick. LLM calls are async/detached, never block the loop.
Vite dev-server proxy handles `/api/llm-proxy` → Anthropic API (no Cloudflare Worker in dev).

---

## Core design principles

1. **Sugarscape resource mechanics** — scan visible cells, move to richest tile, harvest. Scarcity drives emergent competition/migration.
2. **PIANO cognitive architecture** — last 5 decisions + goblin state compress into ~400-token LLM prompt for crisis decisions.
3. **LLM is crisis-only** — ~95% deterministic Utility AI. LLM fires at decision points only. Cooldown. Off by default (🤖 toggle).
4. **Always playable without LLM** — timeout (5 s) or disabled → silent fallback to deterministic AI.
5. **Emergent over hardcoded:** – when adding actions, base eligibility/scoring on the goblin's personal state (hunger, warmth, etc.) not fixed map locations. Clustering near home should emerge from where goblins spend time, not proximity-to-homeTile gates.

---

## Agent roles

Agent data model is in `src/shared/types.ts` (plain interfaces, no ECS). Roles assigned round-robin at spawn:
| Role       | Vision | HP  | Behavior |
|------------|--------|-----|----------|
| forager    | 4–6    | 100 | harvests 2 food/tile (others: 1); main food collector |
| miner      | 2–4    | 100 | targets ore tiles; builds fort walls from ore stockpile |
| scout      | 5–8    | 100 | wide vision; early threat detection; XP on exploration |
| lumberjack | 5–8    | 100 | chops forest tiles for wood; deposits to wood stockpile |
| fighter    | 3–5    | 130 | hunts adventurers within vision×2; deals 18 hp/hit (others: 8) |

---

## Utility AI (`tickAgentUtility` in `utilityAI.ts`, actions in `actions.ts`)

Every tick: `updateNeeds()` → starvation damage → expire LLM intent → stockpile
deposit/withdraw → score all eligible actions (0–1 via sigmoid/ramp curves) → execute
highest. Traits shift sigmoid midpoints. LLM intents add +0.5 to matching action scores.
16 actions defined in `actions.ts`; see file for scoring formulas.

**Close-call logging:** top two actions within 0.03 → "⚖ agonizing over X vs Y".
**Fatigue:** 0–100; >70 → 30% skip action; >90 → morale decay. Rest recovers 1.5/tick.
**Stockpile instant actions:** deposit (inv≥10) and withdraw (hunger>60, inv<2) are early-returns in `tickAgentUtility` that bypass all action scoring — a goblin standing on a stockpile skips the scored pipeline that tick.

---

## Game systems (see source files for exact values)

- **Crisis detection** (`crisis.ts`): 5 crisis types trigger LLM calls. Morale decays when hungry, recovers when fed.
- **Traits** (`agents.ts` `TRAIT_MODS`): 8 traits shift sigmoid midpoints via `traitMod()`. See table in source.
- **Weather** (`weather.ts`): clear/rain/drought/cold/storm modify growback + metabolism. Seasons cycle every 600 ticks. Storm = heavy rain + lightning strikes.
- **Skills** (`skills.ts`): one skill per role, level = `floor(sqrt(xp/10))`. XP on primary action, +0.3 yield or +3 dmg per level.
- **Wounds** (`wounds.ts`): single slot, 60% chance on hit. 4 types (bruised/leg/arm/eye). `effectiveVision()` replaces raw vision everywhere.
- **Factions** (`factions.ts`): cosmetic only — `getActiveFaction()` returns display config. Goblins (default) or Dwarves. Persists in save.
- **Storyteller** (`events.ts`): tension-aware event distribution — struggling colonies get relief, thriving colonies get challenged.
- **Warmth diffusion** (`diffusion.ts`): BFS from `TileType.Hearth` and `TileType.Fire` tiles; walls block propagation entirely. Goblin `warmth` smoothed in WorldScene (0.95/0.05 blend — no Math.round or it fixed-points at 10%). Use entry/exit hysteresis in eligible checks to prevent oscillation.
- **Fire system** (`fire.ts`): hearths ignite adjacent flammable tiles (Grass/Forest/Mushroom/Farmland/TreeStump). Slow-wave spread: high probability per attempt but long interval between attempts, staggered by `fireTick`. Rain/storm extinguishes. Burnout→Dirt. Goblins on fire tiles take damage and can catch fire. Fire tiles are danger and warmth sources in diffusion.
- **Burning goblins** (`fire.ts` `tickBurningGoblins`): `onFire` state triggers early-return in `tickAgentUtility` — goblin sprints to nearest Water/Pool. DoT damage per tick; can spread fire to terrain underfoot; adjacent goblins can smother flames. Extinguished by Water/Pool tiles.
- **Rain pooling** (`pooling.ts`): during rain, Dirt/Grass/Farmland adjacent to Water/Pool can flood to `TileType.Pool`. Pools evaporate back to `priorType` when dry (drought accelerates). Storms pool faster. Pools extinguish burning goblins.
- **Lightning** (`lightning.ts`): during storms, chance per tick to strike a random tile. Flammable → ignite; Water/Pool/Fire → absorb silently; else → scorch to Dirt.
- **Firefighting action** (`actions/firefighting.ts`): two-phase — fetch water from lake/pool → douse fire tile. Small chance of getting singed (sets `onFire=true`) on a failed douse.

---

## LLM integration

**Crisis LLM** (`crisis.ts`): `buildPrompt()` compresses goblin state + situation + last 5
memories into ~400 tokens. Returns JSON `{action, intent, reasoning, emotional_state, expectedOutcome}`.
Model: `claude-haiku-4-5`. Max tokens: 256. Timeout: 5 s. Cooldown: 280 ticks/goblin.

**Storyteller LLM** (`storyteller.ts`): fires once per goal completion. ~300 token prompt.
Returns 2-4 sentence chapter. Timeout: 8 s. Falls back to deterministic text on failure.

---

## World design

- **Grid:** 64×64 tiles, 16×16 px. Tile types: Dirt, Grass, Forest, Water, Stone, Farmland, Ore, Mushroom, Wall, Hearth, Fire, Pool, TreeStump
- **World gen** (`world.ts`): dual Simplex noise (elevation + moisture) → biome classification.
  `generateWorld(seed?)` returns `{ grid, spawnZone, seed }`. Fully seeded — same seed = identical world.
- **`FORAGEABLE_TILES`** (`agents.ts`): `Set<TileType>` — currently `{ Mushroom }`. Add one line to unlock new food source.
- **Harvest split:** tiles deplete 5–6× per visit, goblins gain only 1–2 → forces exploration
- **Growback:** Forest 0.04/tick · Farmland 0.02/tick · Mushroom 0.08/tick
- **World events** (every 300–600 ticks): blight, bounty, ore discovery — tension-aware distribution

---

## Tile frame config

See `src/game/tileConfig.ts` (editable via in-game T-key tile picker).
Frame index = `row * 49 + col` (0-based, 49 cols × 22 rows, 16 px, no spacing).
Use `python3 scripts/inspect-tiles.py` to find frames by color.

---

## Key directories

- `src/game/` — Phaser scenes (WorldScene.ts is the main game loop), tileConfig
- `src/simulation/` — game logic: agents, actions, utilityAI, world, weather, skills, wounds, events, adventurers, fire, pooling, lightning
- `src/ai/` — LLM integration: crisis detection, storyteller chapters
- `src/ui/` — React overlay: HUD, EventLog, MiniMap, StartMenu, TilePicker
- `src/shared/` — types, constants, events bus, factions, save/load

---

## Implementation status

**Current: Iteration 25.** See `git log` for full changelog. Key milestones:
1–3: World gen, tileset, pathfinding, BT, LLM crisis detection.
4–6: Camera, LLM execution, memory, roles, VERIFY, procedural world, scarcity.
7–9: Colony goals, depot, fighter role, succession, traits/weather/storyteller, dual-noise biomes.
10: Utility AI (replaced BT), skills/XP, wounds, fatigue, social need, spatial memory.
11: Lumberjack role, ore/wood stockpiles, fort building (`fortWallSlots`), minimap.
12: Goblin migration (dwarf→goblin rename), comedic tone, save v2.
13: Faction system (goblins vs dwarves), chronicle chapters, storyteller LLM.
14–17: Actions split to `actions/` modules, HUD split to `HUD/` modules, dead BT removed.
18–19: Inventory capacity shared across ore/wood/food; need-based chop/mine scoring.
20: Headless sim harness; fixed idle measurement, foraging threshold, socializing loop.
21: Foraging search radius widened; withdrawFood trigger tuned.
22: Fire system (hearth ignition, tile spread, burnout, goblin damage) + firefighting action.
23: Rain pooling — lowland tiles flood during rain, evaporate after; pools extinguish goblins.
24: Burning goblins — `onFire` state, flee-to-water override, DoT, terrain spread, friendly extinguish.
25: Thunderstorms — new weather type; 3× faster pooling; lightning strikes ignite/scorch tiles.

---

## Key constraints

- **Never block the game loop.** LLM calls are detached Promises — never awaited in `gameTick()`.
- **Never crash on bad LLM output.** Every JSON parse is wrapped in try/catch; every field has a fallback.
- **Keep prompts under 500 tokens.** Memory is capped at 5 entries; compress aggressively.
- **LLM decisions don't interrupt.** The callback fires asynchronously; `goblin` is mutated in place and picked up on the next render tick.
- **One decision per crisis, not one per tick.** Cooldown: 280 ticks (~40 s) per goblin.
- **Tile picker writes source files.** `POST /api/write-tile-config` → Vite plugin → `tileConfig.ts`. Restart not needed (HMR picks it up).
- **Kenney assets are CC0.** Use freely including for commercial release.
- **Save migration:** new optional `Goblin` fields need `if (d.field === undefined) d.field = default;` in `loadGame()` (`save.ts`). See existing migrations (skillXp, knownHearthSites) as template.

---

## Upcoming

**Gameplay depth**
- [ ] Mechanical faction differences: different starting stats, trait distributions, sigmoid shifts
- [ ] Trade: merchant caravans, negotiation LLM calls

**Intelligence depth**
- [ ] Long-term goal generation per goblin (personal goals between crises)
- [ ] Memory compression: summarize old entries via cheap LLM call
- [ ] Factional behavior: relationship clusters → informal coordinated factions

**Infrastructure**
- [ ] Cloudflare Worker `/api/llm-proxy` (replaces Vite proxy for production)
- [ ] Rate limiting via Cloudflare KV (max calls/session/hour)
- [ ] PWA manifest + offline deterministic mode

**Mobile polish**
- [ ] Touch controls: tap-to-select, tap-to-command, pinch-zoom
- [ ] Responsive HUD layout (phone vs. tablet)
- [ ] Performance: camera culling, sprite pooling, target 30fps mid-range Android

---

## References

Phaser 3: https://newdocs.phaser.io/docs/3.90.0 
rot.js: https://ondras.github.io/rot.js/manual/ 
Design influences:
[PIANO architecture](https://arxiv.org/abs/2411.00114)
[Sugarscape](https://jasss.soc.surrey.ac.uk/12/1/6/appendixB/EpsteinAxtell1996.html)
[LLM Sugarscape study](https://arxiv.org/abs/2508.12920)
[Red Blob Games noise terrain](https://www.redblobgames.com/maps/terrain-from-noise/)
