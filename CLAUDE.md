# Dwarf Colony Sim — Agent Instructions

A browser-based colony survival game inspired by RimWorld and Dwarf Fortress . Small colony of LLM-driven dwarf agents operating in a tile-based world with emergent behavior arising from resource scarcity. The LLM is a crisis decision-maker, not a chatbot.

---

## Further reading
See `docs/RESEARCH.md` for detailed rationale behind stack decisions,
library comparisons, and agent architecture research.

---

## Commands

```bash
npm run dev          # dev server + LLM proxy at http://localhost:5173
npm run build        # tsc -b && vite build
npx tsc --noEmit     # type-check only (preferred before commits)
npm run lint         # eslint
python3 scripts/inspect-tiles.py --frame N   # inspect Kenney tile by frame index
```

**Required:** `ANTHROPIC_API_KEY=sk-...` in `.env.local` (gitignored) — LLM proxy won't work without it.
LLM is off by default in-game (🤖 toggle). HMR works for most changes; full reload needed for `crisis.ts` singleton.

## Phaser 3 camera gotcha

`cam.scrollX` is **not** the world position at the left edge — the camera uses a viewport-centred transform.
Zoom-to-cursor correct formula:
```typescript
const f = 1 / oldZoom - 1 / newZoom;
cam.scrollX += (ptr.x - cam.x - cam.width / 2) * f;
cam.scrollY += (ptr.y - cam.y - cam.height / 2) * f;
```

## Phaser 3 display-list render order

`this.add.graphics()` and `this.add.text()` are inserted into the scene's display list at call-time. Objects created **before** `map.createBlankLayer()` render underneath the terrain and will be invisible. Always create overlay Graphics/Text objects **after** the tilemap layer.

---

## Stack decisions

| Layer | Choice | Status | Notes |
|---|---|---|---|
| Language | TypeScript 5.x | ✅ live | End-to-end type safety |
| Bundler | Vite 7.x | ✅ live | Native TS, HMR, proxy plugin for LLM |
| Game engine | Phaser 3.90+ | ✅ live | TilemapLayer terrain + sprite dwarves |
| Roguelike algorithms | rot.js 2.x | ✅ live | A* pathfinding in `pathNextStep()` |
| UI overlay | React 19 | ✅ live | HUD, DwarfPanel, EventLog, TilePicker |
| Event bus | mitt (200 bytes) | ✅ live | Typed events for Phaser ↔ React |
| LLM | claude-haiku-4-5 | ✅ live | Via Vite dev-server proxy at `/api/llm-proxy` |
| Art assets | Kenney 1-bit Pack | ✅ live | `colored_packed.png` 49×22, 16×16 px, CC0 |
| ECS | Koota (pmndrs) | ⏸ deferred | Plain TS interfaces used instead; revisit at ~20+ dwarves |
| Worker RPC | Comlink (Google) | ⏸ deferred | Simulation runs on main thread for now |
| Backend | Cloudflare Workers + Hono | ⏸ deferred | Vite proxy used in dev; CF Worker is Phase 3 |
| KV store | Cloudflare KV | ⏸ deferred | No rate-limiting yet |
| Map editor | Tiled Map Editor | ✗ replaced | Procedural world gen + in-game tile picker (T key) |
| Grid plugin | RexRainbow Board | ✗ not needed | rot.js A* is sufficient |

### Koota ECS — when and how to revisit

**Trigger:** ~20+ simultaneous dwarves, or a measurable tick budget on entity iteration / React re-renders.
ECS cache-coherency and archetype-query benefits don't appear at 5–10 entities; the simulation bottleneck
at current scale is rot.js A* pathfinding, not entity iteration.

**If migrating, do dwarves first — never migrate tiles.**
The `grid[y][x]` 2D array gives O(1) spatial lookup that ECS entity queries cannot match; replacing it
would be a regression. Dwarves are the right candidate because:
- Component split is clear: `Position`, `Vitals`, `Inventory`, `LLMState`, `AgentMemory`, `SocialGraph`, `SpatialMemory` (~7 components)
- Koota's `useQuery` hooks would eliminate the current every-tick full-snapshot re-render in `ColonyGoalPanel` / `SelectedDwarfPanel`

**Hard problems to resolve before starting:**
1. `tickAgent` takes a mutable `Dwarf` reference and mutates it in place (~200 lines of BT) — must become `world.set(entity, Component, value)` throughout.
2. LLM async callbacks close over the `Dwarf` object reference. With Koota they'd close over an entity ID and need `world.isAlive(entity)` checks before mutating (dwarf may have died while the LLM call was in-flight).
3. `Map<string, Phaser.Sprite>` keyed by `dwarf.id` string → `Map<Entity, Phaser.Sprite>`; Koota recycles entity IDs by default, so sprite cleanup must be airtight.
4. `Dwarf` is trivially JSON-serializable today; Koota entities are not — write a serialization round-trip test before touching WorldScene if save/load is planned.

**Suggested phases:** (A) Dwarves only, grid stays plain 2D array → (B) Goblins → (C) Tiles only if growback/overlay iteration becomes measurable at very high entity counts.

---

## Actual architecture (as built)

```
Browser — single main thread
│
├── Phaser (game loop, ~150ms/tick via delta check)
│   └── WorldScene.ts — terrain tilemap, dwarf sprites, input
│        ↕ mitt event bus
├── React (HUD overlay, EventLog, DwarfPanel, TilePicker)
│
└── LLM calls (async, detached, never block the game loop)
     └── fetch('/api/llm-proxy')  →  Anthropic API
          Vite dev-server proxy injects ANTHROPIC_API_KEY
```

**No Web Worker.** Simulation runs on the main thread alongside Phaser.
**No Comlink.** React receives game state via `bus.emit('gameState', state)` each tick.
**No Cloudflare Worker in dev.** The Vite config handles the `/api/llm-proxy` route directly.

---

## Core design principles

**1. Sugarscape-style resource mechanics drive emergent behavior.**
Each dwarf has `vision` (tiles), `metabolism` (hunger/tick), and `inventory`. The core movement rule: scan visible cells, move to richest resource tile, harvest, increment hunger. If health hits zero the dwarf dies. Resource heterogeneity (food NW, ore SE, river barrier) creates natural migration, competition, and scarcity.

**2. PIANO-inspired cognitive architecture with a Cognitive Controller bottleneck.**
Short-term memory: last 5 decisions per dwarf fed into each LLM prompt (~200 tokens). When a crisis triggers, dwarf state + situation + memory compress into a single ~400-token context, and a single LLM call produces one coherent decision covering action, reasoning, intent, and expected outcome.

**3. LLM is a crisis decision-maker, not a tick-by-tick driver.**
~95% of agent behavior runs deterministically (behavior tree). LLM calls fire only at genuine decision points. Cooldown: 280 ticks (~40 s) between calls per dwarf. LLM is off by default — toggle with 🤖 button.

**4. Action awareness prevents hallucination cascades (VERIFY step).**
After each LLM-directed action, the simulation snapshots state. 40 ticks later it checks whether the outcome matched the expectation. Discrepancies are backfilled into the memory entry so the next prompt sees what actually happened.

**5. Always playable without LLM.**
If a request times out (5 s) or LLM is disabled, agents fall back silently to the deterministic behavior tree. No visible freezing.

---

## Agent data model

```typescript
// src/shared/types.ts — plain interfaces, no ECS framework

export type DwarfRole = 'forager' | 'miner' | 'scout' | 'fighter';
export type LLMIntent = 'eat' | 'forage' | 'rest' | 'avoid' | 'none';

export interface MemoryEntry {
  tick:     number;
  crisis:   string;
  action:   string;
  outcome?: string;  // backfilled by VERIFY step if action failed/surprised
}

export interface Dwarf {
  id:              string;
  name:            string;
  x:               number;
  y:               number;
  health:          number;
  maxHealth:       number;
  hunger:          number;       // 0–100; starvation starts at 100
  metabolism:      number;       // hunger added per tick (0.15–0.35)
  vision:          number;       // tile scan radius
  inventory:       Inventory;
  morale:          number;       // 0–100
  alive:           boolean;
  task:            string;       // display label (shown in HUD)
  role:            DwarfRole;    // permanent, assigned at spawn
  commandTarget:   { x: number; y: number } | null;
  llmReasoning:    string | null;
  llmIntent:       LLMIntent | null;  // active BT override; clears at llmIntentExpiry
  llmIntentExpiry: number;            // tick at which intent expires
  memory:          MemoryEntry[];     // rolling last-5 decisions
}
```

**Role stats (assigned round-robin at spawn: forager, miner, scout, forager, fighter):**
| Role    | Vision | HP  | Behavior |
|---------|--------|-----|----------|
| forager | 4–6    | 100 | harvests 4 food/tile (others: 3); main food collector |
| miner   | 2–4    | 100 | targets ore tiles when no food nearby (step 4.5 BT) |
| scout   | 5–8    | 100 | wide contest radius (4 tiles); early threat detection |
| fighter | 3–5    | 130 | hunts goblins within vision×2; deals 18 hp/hit (others: 8) |

**`tickAgent` signature (7 params):** `tickAgent(dwarf, grid, currentTick, dwarves?, onLog?, depot?, goblins?)` — all params after `currentTick` are optional. Adding a new param requires updating the WorldScene call site.

---

## Behavior tree (`tickAgent`, priority cascade)

```
1.   Starvation: hunger ≥ 100 AND inventory empty → health -= 2, morale -= 2
1.5  Stress metabolism: morale < 25 → hunger += metabolism × 1.3 (death spiral)
2.   Eat: hunger > eatThreshold AND inventory food > 0 → eat 3 units
       Trait-modified: lazy eats at 55 (not 70)
2.5  LLM intent:
       eat   → force-eat below normal threshold (hunger > 30)
       rest  → stay put this tick
       forage/avoid → handled in steps 4/5
2.7  Food sharing: food ≥ shareThreshold AND nearby dwarf (≤2 tiles) hunger > 60 AND food < 3
       → gift 3 food to hungriest neighbor; donor keeps ≥ keepMin
       Trait-modified: helpful shares at 6/keeps 3; greedy at 12/keeps 8; mean at 14
       Relation-gated: won't share if neighbor relation < shareRelationGate (default 30; mean: 55)
       Allies (relation ≥ 60) get cooperative yield bonus (+2) instead of contest penalty
2.8  Depot deposit/withdraw: when standing on depot tile
       food ≥ 10 → deposit (food − 6) to depot
       hunger > 60 AND food < 2 AND depot.food > 0 → withdraw min(4, depot.food)
3.   Player command: commandTarget set → pathfind toward it (A*)
3.5  Fighter hunt: (fighters only) nearest goblin within vision×2 → pathfind toward it;
       on contact tickGoblins handles combat (18 hp/hit vs 8 for other roles)
       Trait-modified: brave fights until hunger 95; paranoid flees at hunger 60
4.   Forage + harvest (Sugarscape rule):
       scan vision radius (or 10 if llmIntent='forage') for richest food tile
       move toward it, harvest on arrival
       Harvest yield scales with morale: 0.5× at morale 0, 1.0× at morale 100
       Contest yield: if hungrier dwarf on same tile → skip harvest this tick
         Allies (relation ≥ 60) yield peacefully with cooperation bonus (+2)
         Mean trait doubles contest penalty (−10 not −5)
4.3  Depot run: hunger > 65 AND food == 0 AND depot.food > 0 → pathfind to depot
4.5  Miner ore targeting: (miners only, when no food in vision)
       scan for richest material tile, mine 2 units/tick
5.   Wander / avoid:
       llmIntent='avoid' → maximize distance from nearest rival within 5 tiles
       otherwise → random walkable step
```

---

## Crisis detection (`detectCrisis`, runs every tick)

Fires a crisis (and queues an LLM call) for the first matching condition:

| Type | Condition |
|---|---|
| `low_supplies` | inventory.food ≤ 2 AND hunger ≥ 40 |
| `hunger` | hunger ≥ 65 |
| `morale` | morale ≤ 40 |
| `resource_contest` | alive rival within 2 tiles (scouts: 4) also has food < 3 |
| `resource_sharing` | own food ≥ 8 AND nearby rival hunger > 60 AND rival food < 3 |

Morale dynamics: decays −0.4/tick when hunger > 60; recovers +0.2/tick when hunger < 30.

---

## Trait modifiers (`TRAIT_MODS` in `agents.ts`)

Traits modify hardcoded BT thresholds via `traitMod()` helper:

| Trait | Behavioral effect |
|-------|-------------------|
| `helpful` | Shares food at 6 (not 8), keeps only 3; shares even with low-trust neighbors |
| `greedy` | Won't share until 12 food, keeps 8; won't share with rivals |
| `brave` | Fights goblins until 95 hunger (not 80) |
| `paranoid` | Flees combat at 60 hunger; drifts home 50% of the time (not 25%) |
| `lazy` | Eats at 55 hunger (not 70) — consumes food faster |
| `cheerful` | Shares at 6 food; shares with more neighbors (low relation gate) |
| `mean` | Won't share until 14 food; contest penalty doubled (−10 not −5); won't share with non-allies |
| `forgetful` | No modifier (flavor only — could later affect memory size) |

---

## Weather system (`src/simulation/weather.ts`)

Global state modifying growback rates and dwarf metabolism:

| Weather | Growback | Metabolism | When |
|---------|----------|------------|------|
| Clear | 1.0× | 1.0× | Default |
| Rain | 1.8× | 1.0× | Common in spring |
| Drought | 0.25× | 1.0× | Common in summer |
| Cold | 0.5× | 1.4× | Dominates winter |

Seasons cycle every 600 ticks (~85 s). Weather shifts at season boundaries and
randomly mid-season (0.2% per tick). Displayed in HUD top bar.
Touches zero agent code — modifies `growback()` multiplier and `tickAgent()` metabolism
multiplier; existing hunger/morale/sharing mechanics cascade from there.

---

## Tension-aware storyteller (`src/simulation/events.ts`)

Replaced flat 25/25/25/25 event distribution with colony-health-aware selection:

| Colony tension | Event bias |
|----------------|------------|
| High (>70) | 45% bounty, 40% mushroom, 15% ore (help colony) |
| Low (<30) | 50% blight, 25% ore, 25% mushroom (challenge colony) |
| Medium | Uniform random (unpredictable) |

Tension = f(avg hunger, avg morale, goblin count, recent deaths). Creates dramatic
pacing: a struggling colony gets relief, a thriving colony gets challenged.

---

## LLM prompt format (actual, `buildPrompt`)

```
You are {name}, a dwarf {roleLabel}
Role affects your priorities and decisions.
Status — Health: {h}/{max}, Hunger: {hunger}/100, Morale: {morale}/100
Food carried: {food} units. Current task: {task}.

CRISIS: {situation.description}
Colony context: {situation.colonyContext}

RECENT DECISIONS:                        ← omitted if memory empty
  [tick N] {crisisType}: "{action}" → OUTCOME: {outcome}   ← outcome only if VERIFY fired

Respond ONLY as valid JSON (no markdown, no extra text):
{
  "action": "one short sentence — what you will do next",
  "intent": "eat | forage | rest | avoid | none",
  "reasoning": "internal monologue, 1-2 sentences",
  "emotional_state": "3-5 words describing how you feel",
  "expectedOutcome": "one short sentence — what you expect to happen"
}
```

Model: `claude-haiku-4-5`. Max tokens: 256. Timeout: 5 s. Cooldown: 280 ticks/dwarf.

---

## World design

- **Grid:** 64×64 tiles, 16×16 px (Kenney 1-bit `colored_packed.png`)
- **Tile types:** Dirt, Grass, Forest, Water, Stone, Farmland, Ore, Mushroom
- **Layout:** Dual-noise biome classification (Red Blob Games pattern).
  `generateWorld(seed?)` returns `{ grid, spawnZone, seed }`:
  - **Noise fields:** Two independent Simplex noise fields (elevation + moisture) via
    `simplex-noise` npm package, seeded with Mulberry32 PRNG. Fractal Brownian motion
    (3 octaves, persistence 0.5, lacunarity 2.0) at each tile.
  - **Biome lookup:** `classifyBiome(elevation, moisture) → TileType`:
    - Water: elevation < 0.22 (natural lakes/ponds)
    - LOW (0.22–0.38): Mushroom / Farmland / Grass / Dirt by moisture
    - MED (0.38–0.58): Forest / Grass / Dirt by moisture
    - HIGH (0.58–0.78): Forest / Dirt / Stone by moisture
    - PEAK (≥ 0.78): Ore / Stone by moisture
  - **Resource values** derived from noise position (not random): `tileResourceValues()`
    maps tile type + elevation/moisture to food/material/growback using WORLD_CONFIG constants.
  - **No explicit river** — water bodies emerge naturally from the elevation field.
  - **Spawn zone:** 12×6 rectangle, best of 40 seeded random candidates + center fallback.
    Scored by walkability (>80% non-water) and nearby food count (15-tile radius).
    If < 20 food tiles nearby, a guaranteed mushroom patch is seeded ~6 tiles away.
  - **Fully seeded:** same seed = identical world. Seed displayed in console.
- **`FORAGEABLE_TILES`** (`src/simulation/agents.ts`): `Set<TileType>` listing harvestable
  tile types. Currently `{ Mushroom }`. Add one line to unlock a new food source.
- **Harvest split:** tile loses `depletionRate` (5–6) per visit but dwarf only gains
  `harvestYield` (1–2) — tiles exhaust fast, forcing dwarves to explore.
- **Growback rates:** Forest 0.04/tick · Farmland 0.02/tick · Mushroom 0.08/tick (slowest to refill)
- **World events** (every 300–600 ticks, layout-agnostic grid scan):
  - Blight: halves maxFood/foodValue in a 6-tile radius
  - Bounty: boosts food ×1.5 (cap 20) in a 5-tile radius
  - Ore discovery: spawns up to 5 new Ore tiles in a 3-tile cluster

---

## Tile frame config

Managed by `src/game/tileConfig.ts` (editable via in-game T-key tile picker):

```typescript
TILE_CONFIG = {
  Dirt:     [0, 1, 2],              // noise-selected variation
  Grass:    [5, 6, 7],
  Forest:   [49,50,51,52,53,54,101,102],
  Water:    [253],
  Stone:    [103],
  Farmland: [310],
  Ore:      [522],
  Mushroom: [554],
}
SPRITE_CONFIG = { dwarf: 318 }
```

Frame index = `row * 49 + col` (0-based, 49 cols × 22 rows, 16 px, no spacing).
Use `python3 scripts/inspect-tiles.py` to find frames by color.

---

## Actual file structure

```
src/
├── main.tsx                     # Vite entry — mounts React + Phaser
├── App.tsx                      # React root: HUD + EventLog + TilePicker
├── game/
│   ├── PhaserGame.tsx           # React component hosting Phaser canvas
│   ├── scenes/
│   │   ├── BootScene.ts         # Asset preload → starts WorldScene
│   │   └── WorldScene.ts        # Main scene: tilemap, sprites, input, game loop
│   └── tileConfig.ts            # Frame arrays per TileType; auto-saved by tile picker
├── simulation/
│   ├── world.ts                 # generateWorld(), growback(), isWalkable()
│   ├── agents.ts                # spawnDwarves(), tickAgent() behavior tree, TRAIT_MODS
│   ├── events.ts                # tickWorldEvents() — tension-aware storyteller
│   └── weather.ts               # Weather state, season cycling, growback/metabolism multipliers
├── ai/
│   ├── crisis.ts                # detectCrisis(), LLMDecisionSystem, buildPrompt()
│   └── types.ts                 # LLMDecision, CrisisSituation interfaces
├── ui/
│   ├── HUD.tsx                  # Top bar + DwarfPanel (role badge, bars, LLM toggle)
│   ├── EventLog.tsx             # Scrollable colored event feed
│   └── TilePicker.tsx           # In-game tile frame editor (T key)
└── shared/
    ├── types.ts                 # Dwarf, Tile, GameState, DwarfRole, LLMIntent, …
    ├── events.ts                # mitt bus type definitions
    └── constants.ts             # GRID_SIZE, TILE_SIZE, TICK_RATE_MS, MAX_INVENTORY_FOOD
public/
└── assets/kenney-1-bit/Tilesheet/colored_packed.png
vite.config.ts                   # assetsInclude, tileConfigWriterPlugin, llm-proxy
```

---

## Implementation status

### Iteration 1 ✅ — Procedural world + basic dwarves
- Procedural `generateWorld()` with dual-peak layout (NW food, SE ore, river, spawn zone)
- 5 dwarves spawning in cleared zone, Sugarscape foraging, starvation/death
- React HUD (dwarves, food, stone, tick)

### Iteration 2 ✅ — Kenney tileset
- `Phaser.Tilemaps.TilemapLayer` terrain with per-tile tinting for food density
- Sprite-based dwarves color-shifted green→red by hunger
- Selection ring + cyan command ring graphics

### Iteration 3 ✅ — Behavior tree, pathfinding, player commands, UI
- rot.js A* pathfinding (`pathNextStep`) replacing greedy step
- 6-priority behavior tree in `tickAgent()`
- Right-click player commands with yellow flag marker
- Resource overlay toggle (O key) — food/material density
- Scrollable color-coded EventLog
- LLM crisis detection fully working (model, proxy, JSON parsing)

### Iteration 4 ✅ — Camera, LLM execution, short-term memory
- WASD + drag pan, scroll-wheel zoom (0.5–5×, dynamic min = map-fill; cursor-anchored)
- WASD speed divided by `cam.zoom` for consistent apparent pan speed
- LLM `action` field drives `dwarf.task` display
- LLM `intent` field overrides behavior tree for 50 ticks
- Short-term memory (last 5 decisions) injected into LLM prompts
- LLM toggle (🤖/💤) — off by default

### Iteration 5 ✅ — Roles, VERIFY, world events, social behaviors
- Agent roles: forager/miner/scout (vision, harvest rate, ore targeting, contest radius)
- HUD role badge colored by role
- VERIFY step (PIANO §6): outcome snapshots backfilled into memory entries
- World events: blight/bounty/ore discovery every 300–600 ticks
- Food sharing (BT step 2.7): well-fed dwarves gift food to nearby starving neighbors
- Contest yield: hungrier dwarf harvests first on contested tile
- `resource_sharing` crisis type

### Iteration 6 ✅ — Procedural world, scarcity, UI polish
- **Fully procedural world generation:** river, forests, ore, mushrooms, farmland, and
  spawn zone are all randomly placed each game — no hardcoded layout
- **Sinusoidal river:** two overlapping sine waves produce an organic river shape
- **Mushroom-only foraging via `FORAGEABLE_TILES` Set:** data-driven, one-line extensible
- **Split depletion/yield:** tiles exhaust 5–6× faster than dwarves receive food → forces
  exploration and scarcity-driven crisis behaviour
- **Growback rates slashed** (×5–7 slower) to sustain scarcity pressure
- **Full-height EventLog** (360px right sidebar, top-to-bottom) with word-wrap
- **Memory panel in DwarfPanel:** last 5 LLM decisions shown in HUD (red ✗ for bad outcomes)
- **Dead-dwarf ghost sprites:** deceased dwarves persist as red, Y-flipped sprites
- **`[` / `]` hotkeys:** cycle selected dwarf through all alive dwarves

### Iteration 7 ✅ — Colony goal, depot, fighter role, succession
- **Colony-wide shared goal** cycling through `stockpile_food → survive_ticks → defeat_goblins`; completion grants +15 morale, scales next target by `1 + generation × 0.5`
- **Communal food depot** at spawn-zone center: dwarves auto-deposit surplus (food ≥ 10) and withdraw when starving; gold border + `D:N` label renders above the tile
- **Fighter role**: 130 HP, hunts goblins within vision×2 (BT step 3.5), deals 18 hp/hit vs 8 for others — kills a 30 HP goblin in 2 hits
- **Death & succession**: `spawnSuccessor()` queues a replacement ~300 ticks after each death with inherited memory fragments, muted relations, and an optional LLM arrival thought (`callSuccessionLLM()`)
- **`ColonyGoalPanel`** in right sidebar: gold progress bar for current goal + depot food level
- **Phaser render-order fix**: all overlay Graphics/Text must be created after `createBlankLayer()`

### Iteration 8 ✅ — Emergent behavior: traits, relations, morale, weather, storyteller
Prior to this iteration, traits/relations/morale/personal goals were wired into the data
model, rendered in UI, and sent to the LLM — but gated **zero** behavior tree decisions.
Every dwarf acted identically regardless of personality.

- **Trait modifiers → BT thresholds:** `TRAIT_MODS` map + `traitMod()` helper make 8 traits
  (helpful, greedy, brave, paranoid, lazy, cheerful, mean, forgetful) modify 6 hardcoded
  thresholds (eat, share, keep, fight-flee, contest penalty, relation gate)
- **Relations gate sharing and contests:** dwarves refuse to share food with neighbors whose
  relation score < `shareRelationGate` (30 default, 55 for mean). Allies (relation ≥ 60)
  yield peacefully with cooperation bonus instead of contest penalty
- **Morale affects BT:** stress metabolism (morale < 25 → +30% hunger/tick death spiral);
  harvest yield scales 0.5×–1.0× with morale
- **Weather system** (`src/simulation/weather.ts`): clear/rain/drought/cold modifies growback
  and metabolism multipliers. Seasons cycle every 600 ticks. Touches zero agent code — cascades
  through existing hunger/morale/sharing mechanics
- **Tension-aware storyteller:** colony health score biases world events — struggling colonies
  get bounty/mushroom relief, thriving colonies get blight challenges
- **Emergent cascades:** winter cold → fast depletion + high metabolism → hunger → low morale →
  reduced harvest + stress metabolism → greedy hoarding → relation grudges → sharing blocked →
  starvation spiral → storyteller sends relief → spring rain → recovery

### Iteration 9 ✅ — Dual-noise biome world generation
- **Simplex noise biome classification** (Red Blob Games pattern): two independent noise fields
  (elevation + moisture) with fractal Brownian motion → biome lookup table replaces hand-placed
  cluster stampers. Each seed produces genuinely different world topology
- **Seeded Mulberry32 PRNG** inline (~10 lines) instead of `alea` (CJS-only, incompatible with
  `verbatimModuleSyntax: true`). `simplex-noise` v4 accepts any `() => number`
- **Removed explicit sinusoidal river** — water bodies emerge naturally from elevation < 0.22
- **Removed cluster stampers** (`placeForestCluster`, `placeOreCluster`, `placeMushroomCluster`,
  `placeFarmland`) and 8-pass ordered placement system
- **Noise-based spawn placement**: best of 40 seeded random candidates + center fallback,
  scored by walkability (>80% non-water) and nearby food count (15-tile radius)
- **World seed saved and restored** in `SaveData` (`worldSeed?: string`, backward compatible)
- **Coherent biome regions**: forests cluster in moist midlands, mushroom bogs in wet lowlands,
  ore/stone on dry peaks — 2-3 distinct biome regions on 64×64 map

---

## Key constraints

- **Never block the game loop.** LLM calls are detached Promises — never awaited in `gameTick()`.
- **Never crash on bad LLM output.** Every JSON parse is wrapped in try/catch; every field has a fallback.
- **Keep prompts under 500 tokens.** Memory is capped at 5 entries; compress aggressively.
- **LLM decisions don't interrupt.** The callback fires asynchronously; `dwarf` is mutated in place and picked up on the next render tick.
- **One decision per crisis, not one per tick.** Cooldown: 280 ticks (~40 s) per dwarf.
- **Tile picker writes source files.** `POST /api/write-tile-config` → Vite plugin → `tileConfig.ts`. Restart not needed (HMR picks it up).
- **Kenney assets are CC0.** Use freely including for commercial release.

---

## Upcoming / Phase 3

**Gameplay depth**
- [ ] Ore gathered to community stockpile; dwarves build fortress walls
- [x] Seasons & weather: growback rate changes, winter food scarcity (Iteration 8)
- [ ] Trade: merchant caravans, negotiation LLM calls

**Intelligence depth**
- [ ] Long-term goal generation per dwarf (personal goals between crises)
- [ ] Memory compression: summarize old entries via cheap LLM call
- [x] Trait-driven behavior: personality traits modify BT thresholds (Iteration 8)
- [x] Relation-gated social behavior: sharing/contests depend on relation scores (Iteration 8)
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

## Reference links

- Phaser 3 docs: https://newdocs.phaser.io/docs/3.90.0
- rot.js docs: https://ondras.github.io/rot.js/manual/
- Kenney 1-bit Pack: https://kenney.nl/assets/1-bit-pack
- LLM Sugarscape survival study: https://arxiv.org/abs/2508.12920

---

## Appendix: Game design references

- [How RimWorld fleshes out the Dwarf Fortress formula](https://www.gamedeveloper.com/design/how-i-rimworld-i-fleshes-out-the-i-dwarf-fortress-i-formula)
- [Deep Emergent Play: RimWorld case study](https://steemit.com/gaming/@loreshapergames/deep-emergent-play-a-case-study)
- [PIANO cognitive architecture (Project Sid)](https://arxiv.org/abs/2411.00114)
- [Sugarscape model](https://jasss.soc.surrey.ac.uk/12/1/6/appendixB/EpsteinAxtell1996.html)
- [Red Blob Games — Terrain from Noise](https://www.redblobgames.com/maps/terrain-from-noise/)
- [Red Blob Games — Roguelike Dev](https://www.redblobgames.com/x/2327-roguelike-dev/)
