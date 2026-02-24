# Dwarf Colony Sim — Agent Instructions

A browser-based colony survival game inspired by Dwarf Fortress. Small colony of LLM-driven dwarf agents operating in a tile-based world with emergent behavior arising from resource scarcity. The LLM is a crisis decision-maker, not a chatbot.

---

## Further reading
See `docs/RESEARCH.md` for detailed rationale behind stack decisions,
library comparisons, and agent architecture research.


## Stack decisions

| Layer | Choice | Status | Notes |
|---|---|---|---|
| Language | TypeScript 5.x | ✅ live | End-to-end type safety |
| Bundler | Vite 7.x | ✅ live | Native TS, HMR, proxy plugin for LLM |
| Game engine | Phaser 3.88+ | ✅ live | TilemapLayer terrain + sprite dwarves |
| Roguelike algorithms | rot.js 2.x | ✅ live | A* pathfinding in `pathNextStep()` |
| UI overlay | React 19 | ✅ live | HUD, DwarfPanel, EventLog, TilePicker |
| Event bus | mitt (200 bytes) | ✅ live | Typed events for Phaser ↔ React |
| LLM | claude-haiku-4-5 | ✅ live | Via Vite dev-server proxy at `/api/llm-proxy` |
| Art assets | Kenney 1-bit Pack | ✅ live | `colored_packed.png` 49×22, 16×16 px, CC0 |
| ECS | Koota (pmndrs) | ⏸ deferred | Plain TS interfaces used instead |
| Worker RPC | Comlink (Google) | ⏸ deferred | Simulation runs on main thread for now |
| Backend | Cloudflare Workers + Hono | ⏸ deferred | Vite proxy used in dev; CF Worker is Phase 3 |
| KV store | Cloudflare KV | ⏸ deferred | No rate-limiting yet |
| Map editor | Tiled Map Editor | ✗ replaced | Procedural world gen + in-game tile picker (T key) |
| Grid plugin | RexRainbow Board | ✗ not needed | rot.js A* is sufficient |

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

export type DwarfRole = 'forager' | 'miner' | 'scout';
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

**Role stats (assigned round-robin at spawn):**
| Role | Vision | Behavior |
|---|---|---|
| forager | 4–6 | harvests 4 food/tile (others: 3); main food collector |
| miner | 2–4 | targets ore tiles when no food nearby (step 4.5 BT) |
| scout | 5–8 | wide contest radius (4 tiles); early threat detection |

---

## Behavior tree (`tickAgent`, priority cascade)

```
1.  Starvation: hunger ≥ 100 AND inventory empty → health -= 2, morale -= 2
2.  Eat: hunger > 70 AND inventory food > 0 → eat 3 units
2.5 LLM intent:
      eat   → force-eat below normal threshold (hunger > 30)
      rest  → stay put this tick
      forage/avoid → handled in steps 4/5
2.7 Food sharing: food ≥ 8 AND nearby dwarf (≤2 tiles) hunger > 60 AND food < 3
      → gift 3 food to hungriest neighbor; donor keeps ≥ 5
3.  Player command: commandTarget set → pathfind toward it (A*)
4.  Forage + harvest (Sugarscape rule):
      scan vision radius (or 10 if llmIntent='forage') for richest food tile
      move toward it, harvest on arrival
      Contest yield: if hungrier dwarf on same tile → skip harvest this tick
4.5 Miner ore targeting: (miners only, when no food in vision)
      scan for richest material tile, mine 2 units/tick
5.  Wander / avoid:
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
- **Tile types:** Dirt, Grass, Forest, Water, Stone, Farmland, Ore
- **Layout (enforced in `generateWorld()`):**
  - NW quadrant (x<28, y<30): dense Forest food peak (8–12 food/tile)
  - SE quadrant (x>36, y>36): Ore/Stone material peak (8–12 material/tile)
  - River barrier at y=30–32 with two walkable crossing gaps
  - Farmland strip at y=41–42, x<15 (fallback food patch)
  - Spawn zone x=20–28, y=33–37 (cleared, walkable)
- **Growback:** food tiles regenerate toward `maxFood` at `growbackRate`/tick
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
  Grass:    [6, 7, 8],
  Forest:   [49,50,51,52,53,54,101,102],
  Water:    [253],
  Stone:    [103],
  Farmland: [310],
  Ore:      [522],
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
│   ├── agents.ts                # spawnDwarves(), tickAgent() behavior tree
│   └── events.ts                # tickWorldEvents() — blight/bounty/ore discovery
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
- WASD + drag pan, scroll-wheel zoom (0.4–6×)
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
- [ ] Seasons: growback rate changes, winter food scarcity
- [ ] Threats: goblin raids, cave-ins — new crisis trigger sources
- [ ] Trade: merchant caravans, negotiation LLM calls
- [ ] Relationships: dwarf-to-dwarf scores affecting crisis decisions
- [ ] Death and succession: new dwarf arrives with colony memory fragment

**Intelligence depth**
- [ ] Long-term goal generation per dwarf (personal goals between crises)
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

## Reference links

- Phaser 3 docs: https://newdocs.phaser.io/docs/3.88.0
- rot.js docs: https://ondras.github.io/rot.js/manual/
- Project Sid (PIANO architecture): https://arxiv.org/abs/2411.00114
- Sugarscape paper: https://jasss.soc.surrey.ac.uk/12/1/6/appendixB/EpsteinAxtell1996.html
- LLM Sugarscape survival study: https://arxiv.org/abs/2508.12920
- Kenney 1-bit Pack: https://kenney.nl/assets/1-bit-pack
- Red Blob Games colony sim reference: https://www.redblobgames.com/x/2327-roguelike-dev/
