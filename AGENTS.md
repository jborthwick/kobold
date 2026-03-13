# Goblin Colony Sim — Agent Instructions

A browser-based colony survival game inspired by RimWorld and Dwarf Fortress. Small colony of goblin agents operating in a tile-based world with emergent behavior arising from resource scarcity. The LLM is used for narrative (storyteller chapter summaries when goals complete); optional future use for crisis/decision prompts. The tone is darkly humorous — goblins take themselves seriously despite constant chaos.

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

## Headless simulation (`scripts/headless.ts`)

Runs the full simulation (world gen, utility AI, weather, raids, diffusion, events) without
Phaser or React, many times faster than real-time. No LLM calls (deterministic only).
**Use this whenever tuning action scores, eligibility thresholds, or resource balance modifiers.**

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

| Label | Source |
|-------|--------|
| `traveling` | `→ target` movement tasks |
| `exploring` | `wander` action |
| `harvesting` | `forage` on tile |
| `mining` / `logging` | `mine` / `chop` |
| `socializing` | `socialize` |
| `fleeing to safety` | `seekSafety` |
| `idle` | execute returned early, no task set |

Aim for traveling/exploring dominant and idle low; spikes in fleeing or socializing often mean tuning or unmet needs. Exact targets depend on tuning; use headless output to compare runs.

**Action frequency normalization:** task strings are bucketed by stripping everything after
`(` or `→`. Navigation tasks starting with `→` are labeled `traveling`. Bare strings like
`'idle'`, `'socializing'`, `'brooding'` pass through unchanged. If `idle` spikes, check
for action `execute()` paths that return early without setting `goblin.task`.

**Workflow for tuning an action:**
1. Run 2–3 seeds at 3000 ticks; note the action's share and avg needs
2. Edit the `score()` or `eligible()` function
3. Re-run the same seeds; compare action share and need metrics
4. Type-check: `npx tsc --noEmit`

---

## Stack & architecture

TypeScript · Vite · Phaser · React · rot.js (A* pathfinding) · mitt event bus · claude-haiku-4-5 via `/api/llm-proxy` · Kenney 1-bit Pack (CC0). See `package.json` for versions.

Everything runs on **one main thread**: Phaser game loop drives simulation tick + React HUD overlay.
React receives state via `bus.emit('gameState', state)` each tick. LLM calls are async/detached, never block the loop.
Vite dev-server proxy handles `/api/llm-proxy` → Anthropic API (no Cloudflare Worker in dev).

---

## Core design principles

1. **Sugarscape resource mechanics** — scan visible cells, move to richest tile, harvest. Scarcity drives emergent competition/migration.
2. **PIANO cognitive architecture** — memory holds recent decisions/events for display and optional future LLM use. Currently only the storyteller LLM runs (see `storyteller.ts` for prompt size and timeouts).
3. **Always playable without LLM** — timeout or disabled → silent fallback to deterministic AI.
4. **Emergent over hardcoded:** – when adding actions, systems, agents, etc always favor building emergent behavior with overlapping simple systems.

---

## Utility AI (`tickAgentUtility` in `utilityAI.ts`, actions in `actions/`)

Every tick: (1) needs are updated (hunger, morale, fatigue, social), (2) all eligible actions are scored (0–1 via sigmoid/ramp curves), (3) central scarcity and resource balance modifiers scale scores, (4) trait bias adjusts scores per personality, (5) highest-scoring action runs.

Scoring curves: `sigmoid()` (0→1 as value rises), `inverseSigmoid()` (1→0 as value rises), `ramp()` (linear 0→1 between min/max).

**Central scarcity** (`computeResourceBalanceModifier()` in `utilityAI.ts`): one place computes tier pressures from stockpile totals. Tiers are consumables (food+meals) > raw materials (ore+wood) > upgrades (bars+planks). Each tier uses `inverseSigmoid(total, midpoint)` with tier-specific midpoints and weights so food/meals urgency dominates; actions use one of `consumablesPressure`, `materialsPressure`, or `upgradesPressure` instead of per-action scarcity curves. Cook, forage, withdraw use consumables; mine, chop use materials; smith, saw use upgrades.

**Resource balance**: when (ore+wood+bars+planks) >> (food+meals), `foodPriority` boosts food actions and `materialPriority` nerfs material actions (smith, saw, mine, chop use `0.6 + 0.4 * materialPriority`).

Traits shift sigmoid midpoints and apply score multipliers (see `traitActionBias.ts`).
Actions defined in `actions/`; see files for scoring formulas.


---

## LLM integration

**Storyteller LLM** (`storyteller.ts`): fires once per goal completion. Returns 2-4 sentence chapter. Falls back to deterministic text on failure. See `storyteller.ts` for prompt size and timeouts.

---

## World design

- **Grid:** tile-based; tile types include Dirt, Grass, Forest, Water, Stone, Farmland, Ore, Mushroom, Wall, WoodWall, StoneWall, Hearth, Fire, Pool, TreeStump.
- **World gen** (`world.ts`): dual Simplex noise (elevation + moisture) → biome classification.
  `generateWorld(seed?)` returns `{ grid, spawnZone, seed }`. Fully seeded — same seed = identical world.
- **`FORAGEABLE_TILES`** (`agents/sites.ts`): `Set<TileType>` — currently `{ Mushroom }`. Add one line to unlock new food source.
- **Harvest split** and **growback** drive exploration; **world events** (blight, bounty, ore discovery) add tension. See `world.ts`, `events.ts`, and `shared/types.ts` for sizes, rates, and intervals.

---

## Tile frame config

See `src/game/tileConfig.ts` (editable via in-game T-key tile picker).
Frame index = `row * 49 + col` (0-based, 49 cols × 22 rows, 16 px, no spacing).
Use `python3 scripts/inspect-tiles.py` to find frames by color.

---

## Key directories

- `src/game/` — Phaser scenes and game loop, tileConfig
- `src/simulation/` — game logic (agents, actions, utilityAI, world, weather, events, etc.)
- `src/ai/` — LLM integration: storyteller chapters
- `src/ui/` — React overlay: HUD, EventLog, MiniMap, StartMenu, TilePicker
- `src/shared/` — types, constants, events bus, goblinConfig, save/load

---

## Git Commit Conventions

Use conventional commit format for all commits:
- `feat:` new gameplay feature or system
- `fix:` bug fix
- `refactor:` code restructuring without behavior change
- `chore:` tooling, deps, config
- `docs:` comments or documentation only
- `test:` test additions or changes

Use a scope prefix when the change is scoped to a specific system:
`feat(mood):`, `fix(needs):`, `refactor(ai):`, etc.

Common Kobold scopes:
- `mood` — mood system, thought staging, lerp convergence
- `needs` — needs simulation and decay
- `ai` — agent behavior and decision-making
- `world` — map, tiles, world state
- `ui` — interface and HUD
- `data` — XML defs, data-driven config
- `core` — engine, tick system, foundational architecture

**One logical change per commit.** Don't bundle unrelated changes.
If you've touched more than 2-3 systems, split into multiple commits.

**Commit incrementally during the task, not all at once at the end.**
Commit at natural breakpoints:
- After a system is stubbed out
- After core logic works (even if not wired up)
- After wiring/integration
- After cleanup/refactor of the above

Write commit messages in imperative mood: "Add mood decay tick" not "Added mood decay tick."