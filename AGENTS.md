# Dwarf Colony Sim — Agent Instructions

A browser-based, mobile-friendly colony survival game inspired by Dwarf Fortress. Small colony of LLM-driven dwarf agents operating in a tile-based world with emergent behavior arising from resource scarcity. The LLM is a crisis decision-maker, not a chatbot.

---

## Stack decisions (locked in)

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x | End-to-end type safety |
| Bundler | Vite 6.x | Native TS + Web Worker support, Phaser's official bundler |
| Game engine | Phaser 3.88+ | Best tilemap/mobile/community combo |
| Roguelike algorithms | rot.js 2.x | A*, FOV, map gen, scheduler — imported alongside Phaser |
| Grid plugin | RexRainbow Board | Grid pathfinding + field-of-movement for Phaser |
| UI overlay | React 19 | HUD, menus, event log — Phaser has an official React template |
| ECS | Koota (pmndrs) | TypeScript-first, React bindings, clean trait API |
| Worker RPC | Comlink (Google) | Type-safe Web Worker communication |
| Event bus | mitt (200 bytes) | Typed events for system decoupling |
| Backend | Cloudflare Workers + Hono | Edge LLM proxy, rate limiting, secrets |
| KV store | Cloudflare KV | Session data and usage tracking at edge |
| LLM | Claude 3.5 Haiku | Best cost/latency for structured game decisions |
| Art assets | Kenney Roguelike/RPG Pack | CC0, 16×16, free, ships with terrain/characters/items |
| Map editor | Tiled Map Editor | Integrates natively with Phaser tilemaps |

---

## Architecture overview

Three decoupled loops running in parallel:

```
Browser ─────────────────────────────────────────────────
│ Main Thread: Phaser render (60fps) + React HUD overlay │
│     ↕ Comlink (state snapshots + player inputs)         │
│ Web Worker: Koota ECS simulation (10 ticks/second)      │
│     ↕ fetch (async, non-blocking)                       │
─────────────────────────────────────────────────────────
          │ REST
          ▼
Cloudflare Workers (Hono) ──/api/llm-proxy──→ Anthropic API
```

- **Loop 1 — Render (main thread, 60fps):** Phaser renders sprites, camera, animations. React renders HTML overlay. Never runs game logic.
- **Loop 2 — Simulation (Web Worker, 10 ticks/s):** Koota ECS runs all game systems. Receives player inputs and queued LLM responses. Posts state snapshots to main thread after each tick.
- **Loop 3 — AI decisions (async, event-driven):** Crisis triggers fire async LLM requests to the Cloudflare proxy. Responses queue back into the simulation. Multiple in-flight requests allowed simultaneously.

---

## Core design principles

**1. Sugarscape-style resource mechanics drive emergent behavior.**
Each dwarf has `vision` (1–6 tiles), `metabolism` (hunger rate 1–4/tick), and `wealth` (accumulated food). The core movement rule: scan visible cells, move to richest resource tile, harvest, deduct metabolism. If wealth hits zero, the dwarf dies. Resource heterogeneity (food-rich zone vs. material-rich zone, spatially separated) creates natural migration, competition, and scarcity.

**2. PIANO-inspired cognitive architecture with a Cognitive Controller bottleneck.**
Each agent has a three-tier memory: Working Memory (current situation, ~100 tokens), Short-Term Memory (last 10 events, ~200 tokens), Long-Term Memory (personality, relationships, key experiences, ~100 tokens). When a crisis triggers, these compress into a single ~400-token context payload, and a single LLM call produces one coherent decision covering action, reasoning, and emotional state.

**3. LLM is a crisis decision-maker, not a tick-by-tick driver.**
~95% of agent behavior runs deterministically (pathfinding, foraging, eating, sleeping, routine tasks). LLM calls fire only at genuine decision points with no deterministic answer. Target: 3–8 LLM calls per dwarf per hour, 50–80 calls/hour total across the colony.

**4. Action awareness prevents hallucination cascades.**
After each LLM-directed action, the simulation checks whether the outcome matched the expectation. Discrepancies feed into the next decision context. Example: "You decided to mine iron in Shaft B. The shaft collapsed. Update: task failed."

**5. Always playable without LLM.**
If a request times out (>3 seconds) or the API is unavailable, agents fall back silently to deterministic behavior trees. No visible freezing. A subtle UI indicator shows when "deep thinking" is unavailable.

---

## Agent data model

```typescript
// Koota traits — each is a separate component
type Position = { x: number; y: number };
type Health = { current: number; max: number };
type Hunger = { current: number; max: number; metabolism: number };
type Vision = { range: number }; // 1–6 tiles
type Inventory = { food: number; materials: number; tools: number };
type Morale = { current: number }; // 0–100
type Personality = {
  name: string;
  traits: string[];      // e.g. ["pragmatic", "protective", "haunted"]
  fears: string[];
  skills: string[];
  age: number;
};
type Memory = {
  working: string;       // Current situation context
  shortTerm: MemoryEvent[]; // Last 10 events with timestamps
  longTerm: string;      // Compressed summary
  relationships: Record<string, RelationshipScore>;
};
type CurrentTask = {
  type: TaskType;
  targetTile?: { x: number; y: number };
  targetAgent?: string;
  expiresAt?: number;    // Tick count
  llmDirected: boolean;  // Whether this task came from an LLM decision
};
type CrisisState = {
  pending: boolean;      // LLM call in flight
  cooldownUntil: number; // Tick count — min 5 seconds between calls
  lastDecision?: Decision;
};
```

---

## Crisis trigger taxonomy

### Always deterministic (never call LLM)
- Pathfinding and movement toward a known target tile
- Harvesting when standing on a resource tile
- Eating from inventory when hunger > 80%
- Sleeping when fatigue > threshold
- Hard flee reflex when health < 20%
- Executing the queued action from the last LLM decision
- Combat damage calculation and resolution
- Building placement from player-designated blueprints

### LLM triggers (async, event-driven)
| Trigger | Condition | Example decision prompt |
|---|---|---|
| Resource scarcity | Colony food supply < 3 days | Share personal stash or hoard? |
| Resource contest | Two agents path to same tile | Back down or confront? |
| Moral dilemma | Injured dwarf consuming food, can't work | What does the colony decide? |
| Crisis triage | Multiple simultaneous threats | Cave-in OR spreading fire — which first? |
| Novel discovery | Unexplored tile type found | Underground lake — what do you do? |
| Emotional breaking point | Morale < 20% during dangerous task | Continue or abandon post? |
| Trade negotiation | Merchant event fires | Accept iron tools for half the food stockpile? |
| Interpersonal conflict | Relationship score crosses negative threshold | Confront the dwarf who stole from your stockpile? |

---

## Crisis prompt format

```typescript
const buildCrisisPrompt = (agent: Agent, situation: CrisisSituation): string => `
SYSTEM: You are ${agent.personality.name}, a dwarf (age ${agent.personality.age}).
Personality: ${agent.personality.traits.join(", ")}.
Fears: ${agent.personality.fears.join(", ")}.

YOUR STATUS: Health ${agent.health.current}/${agent.health.max}, 
Hunger ${agent.hunger.current}/${agent.hunger.max}, 
Morale ${agent.morale.current}/100

CRISIS: ${situation.description}
Colony context: ${situation.colonyContext}
Relevant relationships: ${situation.relationships}

RECENT EVENTS:
${agent.memory.shortTerm.slice(-5).map(e => `- ${e.description}`).join("\n")}

Respond ONLY as JSON:
{
  "action": "primary action to take",
  "reasoning": "internal monologue, 1-2 sentences",
  "emotional_state": "how you feel right now",
  "orders": [{"target": "agent or group", "action": "command"}]
}`;
```

---

## World design

- **Grid size:** 64×64 tiles (expandable)
- **Tile size:** 16×16px (Kenney Roguelike/RPG Pack)
- **Resource layout:** Two spatially separated peaks following Sugarscape dual-peak pattern — food-rich zone (farmland, orchards) and material-rich zone (stone, ore deposits). Separated by terrain obstacles (water, mountain).
- **Growback:** Food regenerates at configurable rate α (tune during Phase 2 playtesting)
- **Starting colony:** 5 dwarves, randomized attributes within these ranges:
  - Vision: 2–5 tiles
  - Metabolism: 1–3 food/tick
  - Starting food: 8–15 units
  - Age: 20–55

---

## File structure

```
/
├── index.html
├── vite.config.ts
├── src/
│   ├── main.ts                  # Vite entry — mounts React + Phaser
│   ├── game/
│   │   ├── PhaserGame.tsx       # React component hosting Phaser canvas
│   │   ├── scenes/
│   │   │   ├── BootScene.ts     # Asset loading
│   │   │   ├── WorldScene.ts    # Main game scene — tilemap, sprites
│   │   │   └── UIScene.ts       # Phaser UI scene (optional)
│   │   └── workers/
│   │       ├── simulation.worker.ts  # Web Worker entry
│   │       └── SimulationBridge.ts   # Comlink wrapper
│   ├── simulation/
│   │   ├── world.ts             # Tile grid, resource map, growback
│   │   ├── systems/
│   │   │   ├── MovementSystem.ts
│   │   │   ├── HungerSystem.ts
│   │   │   ├── HarvestSystem.ts
│   │   │   ├── CombatSystem.ts
│   │   │   ├── BuildSystem.ts
│   │   │   └── CrisisDetectionSystem.ts
│   │   ├── agents/
│   │   │   ├── AgentFactory.ts  # Creates dwarves with randomized traits
│   │   │   ├── BehaviorTree.ts  # Deterministic fallback behaviors
│   │   │   ├── MemoryManager.ts # Three-tier memory, compression
│   │   │   └── CrisisPromptBuilder.ts
│   │   └── ecs.ts               # Koota world + trait definitions
│   ├── ai/
│   │   ├── LLMDecisionSystem.ts # Priority queue, cooldowns, timeouts
│   │   ├── ActionAwareness.ts   # Outcome verification
│   │   └── types.ts             # Decision, CrisisSituation types
│   ├── ui/
│   │   ├── HUD.tsx              # Resource bars, colony status
│   │   ├── DwarfPanel.tsx       # Selected dwarf detail
│   │   ├── EventLog.tsx         # LLM decisions + world events
│   │   └── Minimap.tsx
│   └── shared/
│       ├── events.ts            # mitt event bus types
│       └── constants.ts         # Tick rate, tile size, grid size
├── worker/
│   └── llm-proxy/
│       ├── index.ts             # Cloudflare Worker + Hono routes
│       └── wrangler.toml
└── public/
    └── assets/
        └── kenney-roguelike/    # Kenney Roguelike/RPG Pack tiles
```

---

## Phased implementation plan

### Phase 0 — Project scaffold (day 1)
The goal is a running shell with all major systems wired together before any game logic is written.

- [ ] Init project: `npm create vite@latest -- --template react-ts`
- [ ] Install deps: `phaser`, `rot-js`, `koota`, `comlink`, `mitt`, `hono`
- [ ] Set up Vite config for Web Worker support and Phaser's `import.meta.url` asset loading
- [ ] Mount Phaser inside a React component using the official Phaser + React template pattern
- [ ] Set up Comlink bridge: main thread ↔ simulation Web Worker with typed RPC
- [ ] Set up Cloudflare Worker with Hono, `wrangler.toml`, local dev via `wrangler dev`
- [ ] Verify end-to-end: React renders, Phaser canvas shows, Worker receives a ping, CF Worker responds to a test request

**Done when:** Browser shows a Phaser canvas inside a React app with no console errors. Worker ping succeeds.

---

### Phase 1 — World + basic agents, no LLM (days 2–7)
Goal: a playable colony sim with deterministic dwarves. Must feel alive before adding intelligence.

**Days 2–3: World rendering**
- [ ] Import Kenney Roguelike/RPG Pack into `/public/assets/kenney-roguelike/`
- [ ] Create a 64×64 tilemap in Tiled with terrain types: grass, stone, water, forest, farmland, ore deposit
- [ ] Place two resource peaks: food-rich zone (NW quadrant) and material-rich zone (SE quadrant), separated by a river/mountain
- [ ] Load and render the Tiled map in `WorldScene.ts`
- [ ] Add camera with drag/pan and pinch-zoom (mobile-friendly)
- [ ] Implement resource overlay toggle: show food density / material density as colored overlay

**Days 4–5: ECS and agents**
- [ ] Define all Koota traits: `Position`, `Health`, `Hunger`, `Vision`, `Inventory`, `Morale`, `Personality`, `Memory`, `CurrentTask`, `CrisisState`
- [ ] `AgentFactory.ts`: spawn 5 dwarves with randomized Sugarscape attributes (vision 2–5, metabolism 1–3, starting food 8–15)
- [ ] Render dwarf sprites on the tilemap synced to Worker ECS state snapshots via Comlink
- [ ] Implement `HungerSystem.ts`: deduct metabolism from food inventory each tick. Death at 0.
- [ ] Implement `MovementSystem.ts`: agents pathfind toward their `CurrentTask.targetTile` using rot.js A*
- [ ] Implement `HarvestSystem.ts`: when on a resource tile, harvest amount based on tile richness. Reduce tile value.

**Days 6–7: Behavior and UI**
- [ ] `BehaviorTree.ts`: implement deterministic fallback behaviors in priority order:
  1. If health < 20%: flee from nearest threat
  2. If hunger > 80%: forage for food (Sugarscape movement rule)
  3. If food tile underfoot: harvest
  4. If player-assigned task exists: pathfind to it
  5. Else: wander toward richest visible tile
- [ ] Resource growback: each tick, depleted tiles regenerate at rate α. Tune α so scarcity is real but not instant death.
- [ ] React HUD overlay: food stockpile bar, material stockpile bar, population count, current tick
- [ ] Click/tap a dwarf to open `DwarfPanel.tsx`: shows name, stats, current task, personality traits
- [ ] Player can tap a tile and issue a "mine here" / "farm here" command to selected dwarf

**Phase 1 done when:** 5 dwarves autonomously forage, migrate toward resources, compete for tiles, and die of starvation when food runs out. No LLM needed. This should feel like a working game.

---

### Phase 2 — LLM crisis decisions (days 8–14)
Goal: add intelligence to the moments that matter. Dwarves should surprise you.

**Days 8–9: Backend and decision queue**
- [ ] Cloudflare Worker: implement `/api/llm-proxy` route — validate request, inject `ANTHROPIC_API_KEY` from env, forward to Anthropic, return response
- [ ] Rate limiting: max 200 LLM calls/session/hour via Cloudflare KV. Return 429 with retry-after header.
- [ ] `LLMDecisionSystem.ts` in the Web Worker:
  - Priority queue of pending crisis requests (one per agent max)
  - Per-agent cooldown: min 5-second gap between calls
  - 3-second timeout: if no response, resolve with `null` and fall back to BehaviorTree
  - Non-blocking: all calls are async, simulation tick never awaits them
- [ ] Parse and validate LLM JSON responses. Log malformed responses. Never crash on bad output.

**Days 10–11: Memory and context system**
- [ ] `MemoryManager.ts`:
  - `pushEvent(agentId, event)`: prepend to short-term buffer, cap at 10 events, score each by `recency × importance` (importance 1–10 set at creation time)
  - `compressMemory(agentId)`: when short-term buffer > 8 events, summarize oldest 5 into long-term via a cheap LLM call
  - `buildContext(agentId)`: assemble working + short-term + long-term into ~400 tokens
- [ ] `CrisisPromptBuilder.ts`: construct the full crisis prompt from agent state + situation + context. Always output structured JSON request.
- [ ] Personality system: each dwarf gets a personality template at spawn with `traits`, `fears`, and `skills`. These go in the cached portion of the system prompt to minimize token cost.

**Days 12–13: Crisis triggers and integration**
- [ ] `CrisisDetectionSystem.ts`: runs every simulation tick, checks all trigger conditions for all agents. Enqueues LLM requests when conditions are met.
- [ ] Wire up all triggers from the taxonomy table above. Start with the highest-drama ones: resource scarcity, resource contest, and morale breaking point.
- [ ] `ActionAwareness.ts`: after each LLM-directed action completes (or fails), push an outcome event to memory. Format: "Decided to [action]. Result: [success/failure/unexpected outcome]."
- [ ] Apply LLM decisions to agent state: map `action` field to a `CurrentTask`. The dwarf executes deterministically from there.

**Day 14: Event log and tuning**
- [ ] `EventLog.tsx`: show a scrollable feed of significant events. LLM decisions appear with the dwarf's `reasoning` field displayed as flavor text (e.g., *"Urist decides to share his food stash. 'The young ones need it more than I do.'"*)
- [ ] Tune crisis frequency: target 3–8 LLM calls per dwarf per hour. Adjust trigger thresholds until crises arise naturally, not constantly.
- [ ] Test cost: run a 30-minute session, check Cloudflare KV usage counter. Should be under $0.05.

**Phase 2 done when:** A dwarf faces a genuine moral dilemma, the LLM generates a surprising decision, and the event log shows the dwarf's reasoning. The colony's fate diverges based on that decision.

---

### Phase 3 — Iteration and polish (ongoing after v0.1)

These are not sequential — do them in whatever order makes the game more fun.

**Gameplay depth**
- [ ] Add 3–5 more dwarf agents (scale to 8–10 total)
- [ ] Seasons: growback rate changes, winter creates food scarcity pressure
- [ ] Threats: goblin raids, cave-ins, flooding — sources of crisis triggers
- [ ] Trade: merchant caravans arrive periodically, trigger negotiation LLM calls
- [ ] Specialization: dwarves develop skills over time based on tasks performed (PIANO-style role emergence)
- [ ] Relationships: track dwarf-to-dwarf relationship scores. Friendships and grudges affect crisis decisions.
- [ ] Death and succession: when a dwarf dies, a new one arrives with partial memory of colony history

**Intelligence depth**
- [ ] Long-term goal generation: every N minutes, each dwarf generates a personal goal via LLM ("build a workshop", "earn the respect of the elder") that guides their behavior between crises
- [ ] Memory compression quality: experiment with summarization prompts to preserve more nuanced context
- [ ] Factional behavior: if relationships cluster, dwarves form informal factions that act in coordination

**Mobile polish**
- [ ] PWA manifest + service worker for installable app
- [ ] Offline mode: full deterministic play, LLM disabled, with clear UI indicator
- [ ] Touch controls: tap-to-select, tap-to-command, pinch-zoom, swipe-to-pan
- [ ] Performance pass: camera culling, sprite pooling, target 30fps on mid-range Android
- [ ] Responsive HUD: phone layout vs. tablet layout

**Visual identity**
- [ ] Replace Kenney placeholder art with custom tileset (commission or generate with Aseprite + reference art)
- [ ] Animated dwarf sprites: idle, walk, work, sleep, panic states
- [ ] Particle effects: dust when mining, smoke when fire, sparkle when discovering something

---

## Key constraints and reminders

- **Never block the render loop.** All simulation and LLM work lives in the Web Worker. Comlink state snapshots are the only bridge.
- **Never crash on bad LLM output.** Every JSON parse is wrapped in try/catch. Every field has a typed fallback.
- **Keep prompts under 500 tokens.** The memory bottleneck exists for a reason — compress aggressively.
- **LLM decisions queue, not interrupt.** The simulation applies LLM responses at the start of the next tick, never mid-tick.
- **One decision per crisis, not one per tick.** A dwarf in crisis gets one LLM call. The result drives their behavior for the next 10–30 seconds before another can fire.
- **Kenney assets are CC0.** Use freely including for commercial release. No attribution required (though appreciated).
- **Cloudflare KV is the usage gate.** Never expose the Anthropic API key to the client. All LLM calls go through the CF Worker proxy.

---

## Reference links

- Phaser 3 docs: https://newdocs.phaser.io/docs/3.88.0
- Phaser + React template: https://github.com/phaserjs/template-react-ts
- rot.js docs: https://ondras.github.io/rot.js/manual/
- RexRainbow Board plugin: https://rexrainbow.github.io/phaser3-rex-notes/docs/site/board/
- Koota ECS: https://github.com/pmndrs/koota
- Comlink: https://github.com/GoogleChromeLabs/comlink
- Kenney Roguelike/RPG Pack: https://kenney.nl/assets/roguelike-rpg-pack
- Project Sid (PIANO architecture): https://arxiv.org/abs/2411.00114
- Sugarscape paper: https://jasss.soc.surrey.ac.uk/12/1/6/appendixB/EpsteinAxtell1996.html
- LLM Sugarscape survival study: https://arxiv.org/abs/2508.12920
- Red Blob Games colony sim reference: https://www.redblobgames.com/x/2327-roguelike-dev/
