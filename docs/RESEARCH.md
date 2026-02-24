# Kobold — Research & Architecture Reference

> **Agent usage:** This document explains *why* decisions in `AGENTS.md` were made.
> Read it selectively — jump to the relevant section when you need rationale,
> not as a document to load in full every session.
> All implementation instructions live in `AGENTS.md`.

---

## Quick reference — decisions already made (do not re-litigate)

| Decision | Choice | Status |
|---|---|---|
| Game engine | Phaser 3.88+ | ✅ Locked |
| Roguelike algorithms | rot.js 2.x | ✅ Locked |
| ECS | Koota (pmndrs) | ✅ Locked |
| UI overlay | React 19 | ✅ Locked |
| Worker RPC | Comlink | ✅ Locked |
| Backend | Cloudflare Workers + Hono | ✅ Locked |
| LLM | Claude 3.5 Haiku | ✅ Locked |
| Art assets | Kenney 1-Bit Pack — colored variant (16×16, CC0) — `public/assets/kenney-1-bit/` | ✅ Locked |
| Map editor | Tiled Map Editor | ✅ Locked |
| Agent architecture | Sugarscape body + simplified PIANO mind | ✅ Locked |
| LLM call pattern | Async crisis triggers only, never per-tick | ✅ Locked |
| Custom tileset | Replace Kenney art with custom art in Phase 3 | 🔄 Phase 3 |
| Multiplayer | Not in scope yet | ⏸ Deferred |

---

## Table of contents

1. [Core design insight](#1-core-design-insight)
2. [World simulation layer — library decision](#2-world-simulation-layer--library-decision)
3. [Art assets decision](#3-art-assets-decision)
4. [PIANO architecture — what it is and how we simplified it](#4-piano-architecture--what-it-is-and-how-we-simplified-it)
5. [Sugarscape mechanics — what to borrow](#5-sugarscape-mechanics--what-to-borrow)
6. [The hybrid architecture](#6-the-hybrid-architecture)
7. [LLM integration patterns](#7-llm-integration-patterns)
8. [Open source projects reviewed](#8-open-source-projects-reviewed)
9. [Full tech stack rationale](#9-full-tech-stack-rationale)
10. [Risks and mitigations with code-level actions](#10-risks-and-mitigations-with-code-level-actions)
11. [Reference links](#11-reference-links)

---

## 1. Core design insight

> **Agent note:** Read this section if you're ever tempted to make agents talk to each other, generate dialogue, or behave like AI Town characters. This explains why Kobold is different.

Most LLM agent projects are social simulations — agents walk around and chat. Dwarf Fortress chaos comes from something different: **agents with needs colliding with a dynamic physical world that breaks in unexpected ways**.

DF's emergent chaos doesn't come from agents being smart. It comes from agents having *needs* operating inside a *world with its own physics*. The LLM's job is to make decisions when needs conflict ("I'm hungry but the food is on fire"), not to generate conversation.

**The wrong design:** LLM generates dialogue between dwarves → feels like AI Town.
**The right design:** LLM decides what a dwarf *does* under pressure → feels like DF.

---

## 2. World simulation layer — library decision

> **Agent note:** Read this section if you're questioning why we use both Phaser AND rot.js, or considering switching to a different engine.

### Why Phaser 3 + rot.js together

Phaser 3 handles **rendering and game structure**: tilemap support (orthogonal/isometric/hex), Tiled Map Editor integration, Arcade physics, touch input, and the largest HTML5 game community. Phaser 4 (RC6, Dec 2025) has 16× mobile performance improvement via bitECS, but v3 is the stable choice for now.

rot.js handles **roguelike algorithms Phaser lacks**: A* and Dijkstra pathfinding, field-of-view, cellular automata map generation, noise functions, and a scheduler. These import cleanly alongside Phaser.

They are complementary, not redundant. Phaser renders; rot.js computes.

### Why not the alternatives

| Library | Why rejected |
|---|---|
| PixiJS | Rendering engine only — no tilemap, pathfinding, or game structure. Would need to build everything from scratch. |
| KAPLAY | Designed for arcade/platformer games. Lacks tilemap depth and grid algorithm support. |
| Excalibur.js | TypeScript-native and clean, but much smaller ecosystem. |
| Phaser alone | No built-in FOV or pathfinding. RexRainbow plugin helps but rot.js is more complete. |

### Starter projects worth referencing

- **Red Blob Games 2023 colony sim** (redblobgames.com/x/2327-roguelike-dev) — browser JS fortress-mode sim with A*, colonist jobs, item systems. Best direct reference for Phase 1.
- **JSRL template** (github.com/slashman/jsrl) — TypeScript roguelike starter with turn system and tile display pre-wired.

---

## 3. Art assets decision

> **Agent note:** Read this section when setting up the asset pipeline or loading tiles. Assets are already in the repo — do not re-download or move them. Use the tilesheet spec below when calculating sprite frame positions.

**Kenney 1-Bit Pack** (kenney.nl/assets/1-bit-pack):
- CC0 — public domain, use freely including commercially, no attribution required
- **Already in repo at:** `public/assets/kenney-1-bit/`
- 1,078 tiles total (49 × 22 grid)
- Colored 1-bit aesthetic — distinct palette per tile type, works well on mobile

### File structure

```
public/assets/kenney-1-bit/
├── Instructions.url
├── License.txt
├── Preview.png
├── Sample_fantasy.png
├── Sample_interior.png
├── Sample_platformer.png
├── Sample_urban.png
├── Tilemap/
│   ├── sample_fantasy.tmx        ← Tiled sample maps (reference only)
│   ├── sample_interior.tmx
│   ├── sample_platformer.tmx
│   ├── sample_urban.tmx
│   ├── tileset_colored.tsx       ← Tiled tileset definition (colored variant)
│   └── tileset_legacy.png
├── Tilesheet/
│   ├── colored_packed.png        ← colored, no spacing (packed)
│   ├── colored-transparent_packed.png
│   ├── colored-transparent.png
│   ├── colored.png               ← colored, 1px spacing ← USE THIS
│   ├── monochrome_packed.png     ← monochrome, no spacing (packed)
│   ├── monochrome-transparent_packed.png
│   ├── monochrome-transparent.png
│   └── monochrome.png            ← monochrome, 1px spacing
├── Tilesheet.txt
├── Visit Kenney.url
└── Visit Patreon.url
```

### Which tilesheet to use

**Use `Tilesheet/colored.png`** — colored with 1px spacing between tiles. Matches the tilesheet spec below. The `_packed` variants have no spacing and require different frame math. The `tileset_colored.tsx` in `Tilemap/` is the matching Tiled tileset definition — use this when building maps in Tiled.

The `.tmx` sample maps in `Tilemap/` are Tiled reference files — useful for seeing how Kenney intended tiles to be arranged, but not loaded directly by Phaser.

### Tilesheet specification (for `colored.png`)

```
Tile size:                16px × 16px
Space between tiles:       1px × 1px
Total tiles (horizontal): 49
Total tiles (vertical):   22
Total tiles:              1,078
```

When calculating frame positions in Phaser (e.g. for `createFromCache` or manual UV math):

```typescript
const TILE_SIZE = 16;
const TILE_SPACING = 1;
const TILES_PER_ROW = 49;

const frameX = tileIndex % TILES_PER_ROW;
const frameY = Math.floor(tileIndex / TILES_PER_ROW);
const pixelX = frameX * (TILE_SIZE + TILE_SPACING);
const pixelY = frameY * (TILE_SIZE + TILE_SPACING);
```

### Loading in Phaser

```typescript
// In BootScene.ts preload():
this.load.spritesheet('tiles', 'assets/kenney-1-bit/Tilesheet/colored.png', {
  frameWidth: 16,
  frameHeight: 16,
  spacing: 1,
});
```

**Phase 3 note:** The colored 1-bit style works well as a permanent aesthetic — many successful colony sims use it. Phase 3 "custom art" likely means additional color tinting for game states (red tint for danger, blue for cold, etc.) and UI polish rather than a full tileset replacement.

---

## 4. PIANO architecture — what it is and how we simplified it

> **Agent note:** Read this section when implementing `LLMDecisionSystem.ts`, `MemoryManager.ts`, or `ActionAwareness.ts`. The full PIANO system has 10 concurrent modules — Kobold uses a simplified 7-step sequential version. Do not implement the full concurrent architecture.

### What PIANO is

From Project Sid (Altera.AI, arXiv:2411.00114) — designed for 10–1,000+ agents in real-time Minecraft. Built on two principles:

1. **Concurrency** — modules run in parallel at different timescales. Reflexes are instant. Goal generation is slow. Social awareness only activates during interactions.
2. **Cognitive Controller (CC) bottleneck** — a single decision-maker receives filtered info from all modules, makes one coherent decision, broadcasts to output modules. Prevents conflicting outputs (saying "sure!" while running away). Related to Global Workspace Theory of human consciousness.

**Results:** Full PIANO agents acquired 17 unique Minecraft items in 30 minutes (comparable to humans). Required GPT-4o quality models.

**Important:** Altera.AI's GitHub repo contains only the paper PDF — no source code. Implement from paper description.

### Kobold's simplified PIANO (implement this, not the full version)

Run sequentially per agent per decision cycle (~5–10 second intervals):

```
1. PERCEIVE    → gather visible tiles, nearby agents, threats, resource levels
2. RETRIEVE    → pull working memory + last 5 short-term events + long-term summary
3. FILTER      → compress into ~400 tokens (the CC bottleneck)
4. DECIDE (CC) → single LLM call → {action, reasoning, emotional_state, expectedOutcome}
5. EXECUTE     → map decision to game actions
6. VERIFY      → did outcome match expectedOutcome? (Action Awareness)
7. UPDATE      → write result to memory, update relationship scores
```

Less frequently (every N cycles): compress short-term into long-term, generate new goals, update mood.

### The two most critical concepts to implement correctly

**CC Bottleneck:** Every LLM prompt must produce ONE coherent decision covering action AND emotional state. Never split into multiple calls.

**Action Awareness** (prevents hallucination cascades — implement as a simple post-action check):

```typescript
// After executing an LLM-directed action:
if (outcome !== decision.expectedOutcome) {
  memoryManager.pushEvent(agentId, {
    description: `Decided to ${decision.action}. Expected: ${decision.expectedOutcome}. Actual: ${outcome}.`,
    importance: 7, // High — unexpected outcomes matter
    timestamp: currentTick
  });
}
```

---

## 5. Sugarscape mechanics — what to borrow

> **Agent note:** Read this section when implementing `HungerSystem.ts`, `HarvestSystem.ts`, `MovementSystem.ts`, and world resource layout. Implement these rules faithfully before adding any LLM layer — emergence comes from these rules, not from the LLM.

### The core movement rule (implement exactly)

Each tick, per agent:
1. Survey all unoccupied cells within `vision` range
2. Move to the cell with the most resources
3. Harvest all resources on that cell
4. Deduct `metabolism` from food wealth
5. If wealth ≤ 0: agent dies

This single rule, applied to agents with heterogeneous attributes on a heterogeneous map, produces emergent wealth inequality, migration, and carrying capacity with no additional logic.

### The four agent attributes that drive emergence

| Attribute | Range | Effect |
|---|---|---|
| Vision | 1–6 tiles | High vision = sees more options, finds resources faster |
| Metabolism | 1–4 food/tick | High metabolism = starves faster under scarcity |
| Wealth | Starting: 8–15 food | Accumulated resources = survival buffer |
| Max age | 20–55 years | Natural lifespan variation |

**Critical:** Heterogeneity in these attributes is what creates interesting dynamics. Do not give all dwarves the same values.

### Mapping to Kobold

| Sugarscape | Kobold | Notes |
|---|---|---|
| Sugar | Food/calories | Primary survival resource |
| Spice | Materials (wood, stone, metal) | Complementary distribution to food |
| Two resource peaks | NW food-rich zone + SE material-rich zone | Separated by river/mountain obstacle |
| Growback rate α | Farm/forest regeneration | Tune during Phase 2 — too fast = no scarcity, too slow = mass death |
| Combat rule | Conflict over resources | Triggered by high wealth disparity + scarcity |
| Cultural tags | Personality traits | Drive relationship clustering |

### 2025 validation (arXiv:2508.12920)

A 2025 paper placed LLM agents in a Sugarscape-style grid:
- Agents shared resources spontaneously when food was abundant
- Attack rates hit 80%+ under extreme scarcity (GPT-4o, Gemini-2.5-Pro)
- Agents abandoned assigned tasks to survive when goals conflicted with survival

This confirms the Sugarscape pressure model produces exactly the crisis moments that make LLM decisions meaningful.

---

## 6. The hybrid architecture

> **Agent note:** Read this section if you're unclear on what runs deterministically vs. what triggers an LLM call. This is the most important architectural boundary in the system.

```
EVERY TICK (deterministic, Web Worker, fast):
  Sugarscape movement rule → HarvestSystem → HungerSystem → death check
  Execute queued LLM decision (if any) OR BehaviorTree fallback
  CrisisDetectionSystem → enqueue LLM requests when triggers fire

ASYNC (LLM, non-blocking, fires on triggers only):
  Build context → compress to ~400 tokens → POST to CF Worker → parse response
  Queue result → consumed at start of next tick
```

The simulation tick **never awaits** an LLM call. LLM calls **never block** the game loop. Results land in a queue and get consumed at the start of the next tick.

---

## 7. LLM integration patterns

> **Agent note:** Read this section when implementing `LLMDecisionSystem.ts`, the Cloudflare Worker proxy, or `CrisisPromptBuilder.ts`.

### The "AI Commander" pattern

LLM = asynchronous strategic advisor. Issues high-level decisions. Deterministic systems execute them. Game never waits.

```typescript
class LLMDecisionSystem {
  private pendingRequests = new Map<string, Promise<Decision>>();
  private cooldownUntil = new Map<string, number>(); // tick count

  async requestDecision(agentId: string, context: AgentContext, currentTick: number) {
    if (this.pendingRequests.has(agentId)) return;            // already in flight
    if ((this.cooldownUntil.get(agentId) ?? 0) > currentTick) return; // on cooldown

    const promise = fetch('/api/llm-proxy', {
      method: 'POST',
      body: JSON.stringify({ context }),
      signal: AbortSignal.timeout(3000), // hard 3-second timeout
    })
      .then(r => r.json())
      .catch(() => null); // null → BehaviorTree fallback

    this.pendingRequests.set(agentId, promise);
    const decision = await promise;
    this.pendingRequests.delete(agentId);
    this.cooldownUntil.set(agentId, currentTick + 50); // 5s cooldown at 10 ticks/s
    if (decision) this.applyDecision(agentId, decision);
  }
}
```

### Crisis prompt format

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
  "expectedOutcome": "what you expect to happen",
  "orders": [{"target": "agent or group", "action": "command"}]
}`;
```

### Three-tier memory structure

| Tier | Content | Token budget | When updated |
|---|---|---|---|
| Working memory | Current situation | ~100 tokens | Every decision cycle |
| Short-term memory | Last 5–10 events, scored by importance | ~200 tokens | After every significant event |
| Long-term memory | Personality, relationships, compressed history | ~100 tokens | When short-term > 8 events |

**Memory scoring:** `importance (1–10, set at creation) × recency_decay`. Cave-in = 9. Routine mining = 2. Friend's death = 10 (mark unforgettable — never compress away).

### Cost analysis

At ~500 input + ~150 output tokens per call with Claude 3.5 Haiku:
- 50–100 calls/hour = **$0.06–$0.13/hour**
- 8-hour session ≈ **$0.50–$1.00 total**
- With Anthropic prompt caching on system prompt: **~$0.04–$0.08/hour**

Target: 3–8 LLM calls per dwarf per hour, 50–80 total/hour across the colony.

---

## 8. Open source projects reviewed

> **Agent note:** Read this section if you're looking for reference implementations. Summary: don't fork — borrow specific patterns noted below.

| Project | What to borrow | What to ignore |
|---|---|---|
| Generative Agents (Stanford) — github.com/joonspk-research/generative-agents | Memory stream + importance scoring | Social chat focus, Python stack |
| AI Town (a16z) — github.com/a16z-infra/ai-town | Convex real-time state patterns, agent scheduling | Entire premise — it's a chat sim, not survival |
| Project Sid — github.com/altera-al/project-sid | PIANO architecture (paper only, no code) | Minecraft-specific systems |
| CivAgent — github.com/fuxiAIlab/CivAgent | Insight: strategy games ideal for LLM agents | Civilization-specific mechanics |
| LLM Sugarscape — arxiv.org/abs/2508.12920 | Confirmation that scarcity → aggression works | Research framing |
| AgentScope — github.com/agentscope-ai/agentscope | Memory compression patterns | Too heavyweight for browser game |

### Why we didn't fork AI Town

AI Town is the most deployable existing project but is a social simulation — no resource system, no survival pressure, no physical world that breaks. Adding DF-style chaos would require replacing most of what makes it AI Town. Starting from Phaser + rot.js is cleaner.

### Key community insight

From Project Sid HN discussion: *"Each 'agent' is essentially a SQL view that maps a string template forming the prompt. The LLM is not meaningfully enriched by a fancy world representation."*

**Implication:** A clean tile grid + well-structured state objects is sufficient. Intelligence comes from prompt design and crisis detection, not simulation fidelity.

---

## 9. Full tech stack rationale

> **Agent note:** Read individual rows only when a specific technology choice is being questioned. These decisions are locked — see Quick Reference at top.

| Layer | Choice | Why this, not the alternative |
|---|---|---|
| Bundler | Vite 6.x | Native Web Worker support via `?worker` import. Phaser's official bundler. Hot reload works with Workers. Webpack requires significant config. |
| ECS | Koota | TypeScript-first with React bindings (unlike bitECS). Cleaner trait API than miniplex. Actively maintained by pmndrs team. |
| Worker RPC | Comlink | 1.1kB. Makes Worker calls look like async functions. Fully type-safe. Manual postMessage requires significant boilerplate. |
| Event bus | mitt | 200 bytes. Typed. No dependencies. Decouples systems (CrisisDetectionSystem fires event → LLMDecisionSystem listens) without tight coupling. |
| Backend | CF Workers + Hono | Edge deployment = <5ms latency. $0 at hobby scale (100k req/day free). Hono is 12kB, runs natively in CF Workers. Vercel Edge Functions has cold start issues. |
| KV store | Cloudflare KV | Co-located with CF Worker. Used for rate limiting and usage tracking. No separate database needed at this scale. |

### Why three loops instead of one

Simulation at 10 ticks/second + pathfinding for 10 agents on a 64×64 grid creates CPU spikes that drop frames on mobile if run on the main thread alongside Phaser. Web Worker separates concerns: main thread renders at 60fps guaranteed; Worker simulates and can spike freely. Comlink state snapshots carry state between them efficiently.

---

## 10. Risks and mitigations with code-level actions

> **Agent note:** Check this table before implementing any system in the Risk column. The Code-level action column is the specific thing to build to prevent the problem.

| Risk | Likelihood | Code-level action |
|---|---|---|
| LLM latency spikes (0.5–5s) | High | `AbortSignal.timeout(3000)` on every fetch. On timeout/error resolve with `null`. BehaviorTree runs as fallback. Pre-generate 5–10 generic fallback responses per crisis type to show instantly while real call completes in background. |
| Malformed LLM JSON | High | Wrap every `JSON.parse` in try/catch. Validate each field against a typed schema. Missing/wrong-type fields get typed defaults (`action: "idle"`). Never crash on bad output. Consider Anthropic tool-use to enforce JSON schema at API level. |
| API key exposed to client | Critical | Key lives only in `wrangler.toml` as env secret. CF Worker injects it server-side. Client only ever talks to `/api/llm-proxy`. Run `wrangler secret put ANTHROPIC_API_KEY` — never commit key to repo. |
| No crises arising (too boring) | Medium | Lower trigger thresholds. Reduce food growback rate α. Increase metabolism variance. Run 30-min sessions and count LLM calls in CF KV — target 50–80/hour. |
| Too many crises (chaotic, expensive) | Medium | Raise trigger thresholds. Increase per-agent cooldown from 50 ticks to 100+. Add global crisis rate limiter across all agents (max N simultaneous in-flight LLM requests). |
| Memory compression loses critical context | Medium | Score events at creation (importance 1–10). Never compress events with importance ≥ 8. Add `unforgettable: true` flag for deaths, betrayals, major discoveries. Periodically log long-term summaries during development to verify quality. |
| Mobile frame drops | Medium | Camera culling — only process tiles in viewport + 2-tile buffer. Sprite pooling — reuse sprite objects rather than create/destroy. Profile on a 3-year-old mid-range Android before Phase 3. |
| PIANO source code unavailable | Low | Implement from paper description (arXiv:2411.00114). CC bottleneck + action awareness are well-described. Monitor github.com/altera-al for future releases. |

---

## 11. Reference links

### Primary architecture references
- Project Sid (PIANO): https://arxiv.org/abs/2411.00114
- LLM Sugarscape survival study: https://arxiv.org/abs/2508.12920
- Sugarscape original rules: https://jasss.soc.surrey.ac.uk/12/1/6/appendixB/EpsteinAxtell1996.html
- Generative Agents (Stanford): https://github.com/joonspk-research/generative-agents
- LLM game agent survey (Nov 2025): https://arxiv.org/abs/2404.02039

### Open source projects
- AI Town: https://github.com/a16z-infra/ai-town
- CivAgent: https://github.com/fuxiAIlab/CivAgent
- AgentScope: https://github.com/agentscope-ai/agentscope
- Red Blob Games colony sim: https://www.redblobgames.com/x/2327-roguelike-dev/

### Libraries and tools
- Phaser 3 docs: https://newdocs.phaser.io/docs/3.88.0
- Phaser + React template: https://github.com/phaserjs/template-react-ts
- rot.js manual: https://ondras.github.io/rot.js/manual/
- RexRainbow Board plugin: https://rexrainbow.github.io/phaser3-rex-notes/docs/site/board/
- Koota ECS: https://github.com/pmndrs/koota
- Comlink: https://github.com/GoogleChromeLabs/comlink
- Kenney 1-Bit Pack: https://kenney.nl/assets/1-bit-pack
