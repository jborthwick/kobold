# Kobold — Research & Architecture Decisions

A reference document capturing the research, comparisons, and reasoning behind the technical decisions for Kobold, a browser-based colony survival game with LLM-driven dwarf agents.

---

## The core design insight

AI Town and most LLM agent projects are essentially **social simulations** — agents walk around and chat. The chaos in Dwarf Fortress comes from something fundamentally different: **agents with needs colliding with a dynamic physical world that breaks in unexpected ways**. 

The key realization: DF's emergent chaos doesn't come from agents being smart. It comes from agents having *needs* operating inside a *world that has its own physics*. The LLM's job is to make decisions when needs conflict ("I'm hungry but the food is on fire"), not to generate dialogue. This is a fundamentally different prompt design — you're passing world state + needs + constraints and asking for a *decision*, not a *conversation*.

---

## World simulation layer research

### Library comparison

| Feature | rot.js | Phaser 3 | KAPLAY | PixiJS | Excalibur |
|---|---|---|---|---|---|
| Tilemap support | Basic | Excellent (Tiled integration) | Basic | Via plugin | Good |
| Pathfinding | Built-in A*/Dijkstra | Via plugins (RexRainbow) | None | None | None |
| Mobile/touch | Minimal | Excellent | Partial | Excellent | Good |
| Physics | None | Arcade + Matter.js | Basic | None | Built-in |
| TypeScript | Native | Full definitions | Native | Native | Native |
| Colony sim fit | Algorithm toolkit | Best all-around | Too light | Rendering only | Moderate |

**Decision: Phaser 3 + rot.js together.**

Phaser 3 (v3.88, ~37,000 GitHub stars) wins for rendering: native tilemap support for orthogonal/isometric/hex grids, first-class Tiled Map Editor integration, Arcade physics, built-in touch/pointer handling, and the largest HTML5 game community. Phaser 4 (RC6 as of Dec 2025) uses bitECS internally with up to 16× mobile performance improvement, but v3 is the safer starting point.

rot.js (v2.x, native TypeScript) adds the roguelike algorithm layer Phaser lacks: A* and Dijkstra pathfinding, field-of-view calculations, cellular automata map generation, noise functions, and a scheduler/event queue. These are modular and import cleanly alongside Phaser.

**PixiJS** (46,600 stars) offers best-in-class WebGL/WebGPU rendering but is a rendering engine only — every game system would need to be built from scratch. **KAPLAY** is designed for simpler arcade/platformer games and lacks the tilemap depth needed. **Excalibur.js** is TypeScript-native with clean APIs but a much smaller ecosystem.

### Starter projects worth studying

- **Red Blob Games 2023 colony simulator** (redblobgames.com/x/2327-roguelike-dev) — a browser JS "fortress mode" colony sim with scrollable maps, A* pathfinding, colonist jobs, and item systems, by Amit Patel (the authority on grid algorithms).
- **JSRL template** (github.com/slashman/jsrl) — TypeScript roguelike starter with turn systems, tile display, and keyboard movement pre-wired.
- **RexRainbow Board plugin** — grid pathfinding, field-of-movement, chess-like movement rules specifically for strategy/simulation Phaser games.

---

## Art assets research

Phaser ships with zero art — you bring your own. The ecosystem options:

**Kenney.nl** — the gold standard for prototype assets. All CC0 (public domain, use for anything including commercial). The **Roguelike/RPG Pack** has 1,700+ tiles at 16×16 covering terrain, dungeon features, characters, and items. The **Micro Roguelike** pack has 8×8 tiles for a more minimal look. Clean, consistent, explicitly designed for grid games.

**itch.io free tier** — "16x16 DungeonTileset II", "Urizen 1Bit Tileset" (5,500+ free 12×12 tiles), and others. Urizen is interesting for a DF-style game — the 1-bit aesthetic scales well on mobile.

**Decision: Kenney Roguelike/RPG Pack** (16×16, CC0). Enough variety for terrain, resources, buildings, and characters without looking like a placeholder. Replace with custom art in Phase 3 when visual identity matters.

Note: The DF Steam edition's custom pixel art by Carolyn Jong is a benchmark for what a distinctive tileset can do for the feel of a colony sim on a modern platform. Worth keeping in mind for Phase 3.

---

## Agent architecture research

### PIANO architecture (Project Sid, Altera.AI — arXiv:2411.00114)

The PIANO architecture (Parallel Information Aggregation via Neural Orchestration) was designed for 10–1,000+ agents interacting in real-time Minecraft environments. It runs 10 distinct modules concurrently at different time scales, built on two principles:

**Principle 1: Concurrency.** Different cognitive modules run simultaneously at different speeds. Reflex modules use small, fast non-LLM neural networks for immediate reactions. Goal generation uses deliberate reasoning on a slower timescale. Social awareness modules only engage during social interactions.

**Principle 2: Coherence via information bottleneck.** A **Cognitive Controller (CC)** serves as the sole high-level decision-maker. It receives filtered information from all parallel modules through a designable bottleneck, makes one coherent decision, and broadcasts it to all output modules. This prevents the incoherence problem where concurrent modules produce conflicting outputs. The paper notes this bottleneck pattern "has been suggested as a core ingredient for human consciousness" (citing Global Workspace Theory).

In testing, full PIANO agents acquired 17 unique Minecraft items in 30 minutes (top performers: 30–40, comparable to human players). Only enabled by GPT-4o quality models.

**Key insight for Kobold:** The full 10-module concurrent architecture is overkill for 5–10 browser dwarves. The two transferable concepts are:
1. The **CC bottleneck**: structure every LLM prompt as "here's filtered context → make one coherent decision covering action AND intent"
2. **Action awareness**: after each LLM-directed action, check whether the outcome matched expectations. Feed discrepancies back into the next decision context. Prevents hallucination cascades.

**Note:** Altera.AI's GitHub repo contains only the paper PDF — no source code. The architecture must be reimplemented from the paper's descriptions.

### Sugarscape (Epstein & Axtell, 1996)

Sugarscape demonstrates that complex social phenomena emerge from devastatingly simple rules. On a 50×50 grid with two resource peaks, agents with just four attributes produce emergent wealth inequality, migration waves, trade networks, cultural segregation, and population oscillations.

**The core movement rule:** Survey all unoccupied cells within vision range → move to the cell with the most resources → harvest everything → deduct metabolism from wealth. If wealth hits zero, the agent dies.

**The four agent attributes:**
- **Vision** (1–6 tiles): how far they can see
- **Metabolism** (1–4): consumption rate per tick
- **Wealth**: accumulated resources
- **Max age**: lifespan

From this single rule + heterogeneous agent attributes + spatial resource heterogeneity: Pareto-like wealth distribution emerges within dozens of ticks, agents flow toward resource peaks in visible migration patterns, carrying capacity stabilizes naturally.

**Key parameters for interesting emergent behavior:** heterogeneity in agent attributes + spatial heterogeneity in resources. Give dwarves different vision ranges and metabolic rates. Place food and material deposits in distinct locations. Set growback rates low enough to create genuine scarcity.

**2025 validation (arXiv:2508.12920):** A paper placing LLM agents in a Sugarscape-style simulation found agents spontaneously shared resources when abundant but attacked others at 80%+ rates under scarcity (GPT-4o, Gemini-2.5-Pro). When survival conflicted with assigned tasks, many agents abandoned tasks to preserve themselves. This confirms the Sugarscape pressure model produces exactly the kind of crisis moments that make LLM decisions meaningful.

### The hybrid architecture

**Sugarscape body + PIANO mind:**

- **Sugarscape layer** (deterministic, every tick): update hunger, scan visible tiles, move toward richest resource, harvest, consume, check death. Handles ~95% of all behavior. Creates emergent macro dynamics.
- **PIANO layer** (LLM, event-triggered): activates only at decision points the Sugarscape rules can't resolve — two dwarves want the same resource, a threat appears, food runs critically low, emotional state crosses a threshold. CC bottleneck receives compressed Sugarscape state + personality + memories → outputs one coherent decision.

---

## LLM integration research

### When to call the LLM vs. deterministic logic

**Always deterministic:**
- Pathfinding and movement
- Resource gathering when target is known
- Eating when hunger > 80%
- Sleeping when fatigue > threshold
- Fleeing when health < 20% (hard reflex)
- Executing the current queued LLM decision
- Combat mechanics
- Building from blueprints

**LLM-triggered:**
- Resource scarcity dilemmas (share or hoard?)
- Interpersonal resource contests
- Moral judgments (injured dwarf consuming food, can't work)
- Crisis triage (cave-in OR fire — which first?)
- Novel discoveries (underground lake — no scripted response)
- Emotional breaking points (morale < 20% during dangerous task)
- Trade negotiations (merchant caravan events)
- Relationship conflicts (theft, betrayal)

### The "AI Commander" pattern

The LLM operates as an asynchronous strategic advisor that issues high-level decisions. The game engine's deterministic systems execute them immediately. **The game loop never waits for the LLM.**

Implementation: a priority queue with per-agent cooldowns (min 5 seconds between calls). Timeout at 3 seconds → fall back to deterministic behavior trees. Multiple in-flight requests allowed simultaneously across agents.

### Cost analysis

**Claude 3.5 Haiku** ($0.80/M input, $4.00/M output) or **Claude Haiku 4.5** ($1.00/M input, $5.00/M output).

At ~500 input tokens + ~150 output tokens per call:
- 50–100 calls/hour = **$0.06–$0.13/hour**
- 8-hour session ≈ **$0.50–$1.00**
- With Anthropic prompt caching (90% savings on cached system prompts): **~$0.04–$0.08/hour**

Target: 3–8 LLM calls per dwarf per hour, 50–80 calls/hour total across a 5–10 dwarf colony.

### Agent memory structure

Three-tier model from PIANO + Stanford Generative Agents:

| Tier | Content | Size |
|---|---|---|
| Working memory | Current situation context | ~100 tokens |
| Short-term memory | Rolling buffer of last 5–10 events | ~200 tokens |
| Long-term memory | Personality, relationships, key experiences (compressed) | ~100 tokens |

Total per-call context: ~400–500 tokens. Memories scored by `recency × importance × relevance`. Importance rated at creation (cave-in = 9/10, routine mining = 2/10). When short-term buffer > 8 events, compress oldest 5 into long-term via a cheap secondary LLM call.

---

## Open source projects reviewed

### Most relevant

**[Generative Agents](https://github.com/joonspk-research/generative-agents)** (Stanford, Park et al., 2023) — the canonical reference. A Sims-like village where LLM-powered agents remember, reflect, and plan. Memory stream → reflection → planning loop. Architecture maps onto a DF-style game.

**[AI Town](https://github.com/a16z-infra/ai-town)** (a16z, actively maintained) — deployable TypeScript/React starter for a virtual town with LLM characters. Built on Convex. Handles shared world state, agent scheduling, memory. **Key limitation for Kobold:** geared toward social simulation (agents walk around and chat). Not designed for the physical-world-collision chaos that makes DF interesting.

**[Project Sid](https://github.com/altera-al/project-sid)** (Altera.AL, late 2024) — most ambitious recent work. Up to 1,000 LLM agents in Minecraft, autonomously developing specialized roles, laws, cultural memes. Repo contains technical report only, no source code.

**[AgentScope 1.0](https://github.com/agentscope-ai/agentscope)** (Alibaba, updated Jan 2026) — most actively developed production-ready framework. Added database-backed memory compression and A2A protocol support. Heavyweight but worth knowing.

**[LLM Sugarscape study](https://arxiv.org/abs/2508.12920)** (2025) — LLM agents in a Sugarscape grid with energy, death, resource competition. Closest to the Kobold design. Showed spontaneous resource sharing under abundance and 80%+ attack rates under scarcity. Confirms the model.

**[CivAgent](https://github.com/fuxiAIlab/CivAgent)** (2024) — LLM agents playing the open-source Civilization clone Unciv. Key insight from authors: *"strategy/simulation games are the ideal platform for LLM agents — NPC count is low and decisions are high-stakes, which makes LLM calls worthwhile."*

### Useful observations from the community

From the Project Sid Hacker News thread: *"Each 'agent' is essentially a SQL view that maps a string template forming the prompt. You don't need an actual 3D world. The LLM does not seem to be meaningfully enriched by having a fancy representation underlie the prompt generation process."*

This validates the Kobold architecture: a clean tile grid + well-structured state objects is sufficient. The intelligence comes from the prompt design and crisis detection, not from simulation fidelity.

---

## Full tech stack rationale

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript 5.x | Type safety across game logic, ECS, API calls |
| Bundler | Vite 6.x | Native TS/Worker support, Phaser's official bundler |
| Game engine | Phaser 3.88+ | Best tilemap/mobile/community combo |
| Roguelike algorithms | rot.js 2.x | FOV, pathfinding, map gen, scheduler |
| Grid plugin | RexRainbow Board | Grid pathfinding + field-of-movement |
| UI framework | React 19 | Overlay HUD/menus; Phaser has official React template |
| ECS | Koota (pmndrs) | TypeScript-first, React bindings, clean trait API |
| Web Worker RPC | Comlink (Google, 1.1kB) | Type-safe Worker communication |
| Event bus | mitt (200 bytes) | Typed event emitter for system decoupling |
| Backend | Cloudflare Workers + Hono | Edge LLM proxy, rate limiting, secrets |
| KV store | Cloudflare KV | Session data, usage tracking at edge |
| LLM | Claude 3.5 Haiku | Best cost/performance for structured game decisions |
| Art | Kenney Roguelike/RPG Pack | CC0, 16×16, 1,700+ tiles |
| Map editor | Tiled Map Editor | Native Phaser integration |

### The three-loop architecture rationale

**Why a Web Worker for simulation?** The simulation loop at 10 ticks/second + pathfinding calculations for 10 agents can create frame drops on mobile if run on the main thread. Moving all game logic to a Web Worker means the render loop (Phaser) always gets its full 60fps budget regardless of simulation complexity. Comlink makes Worker communication typed and ergonomic.

**Why Cloudflare Workers for the LLM proxy?** The Anthropic API key must never be exposed to the client. A CF Worker adds <5ms latency (edge deployment), handles rate limiting via KV, and costs ~$0 at hobby scale (100k requests/day free tier). Hono is a 12kB router that runs in CF Workers natively.

**Why Koota over other ECS options?** Koota (pmndrs, the three.js ecosystem team) is TypeScript-first, has React bindings for UI integration, and uses a clean trait-based API. Alternatives considered: bitECS (fastest raw performance but complex API), miniplex (simpler but less featured), plain objects (fine for 10 agents but doesn't scale).

---

## Key risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| LLM latency variance (0.5–5s) | High | 3-second timeout → deterministic fallback. Pre-generate generic crisis responses as instant fallbacks. |
| Prompt engineering brittleness | High | Strict JSON validation, retry logic, typed fallbacks for every field. Use Anthropic tool-use to enforce JSON schema. |
| Emergent behavior calibration | Medium | Sugarscape parameters are a complex dynamical system. Expect extensive playtesting to tune crisis frequency. |
| Cost scaling (future multiplayer) | Low (now) | Shared response cache for similar crises. Per-session budget caps via KV. |
| Memory compression fidelity | Medium | Importance scoring at event creation. Player-markable "unforgettable" events. |
| No PIANO source code | Medium | Reimplement from paper. The CC bottleneck + action awareness patterns are well-described. |

---

## Reference links

- Project Sid (PIANO architecture): https://arxiv.org/abs/2411.00114
- LLM Sugarscape survival study: https://arxiv.org/abs/2508.12920
- Sugarscape original rules: https://jasss.soc.surrey.ac.uk/12/1/6/appendixB/EpsteinAxtell1996.html
- Generative Agents (Stanford): https://github.com/joonspk-research/generative-agents
- AI Town (a16z): https://github.com/a16z-infra/ai-town
- CivAgent: https://github.com/fuxiAIlab/CivAgent
- AgentScope: https://github.com/agentscope-ai/agentscope
- Red Blob Games colony sim reference: https://www.redblobgames.com/x/2327-roguelike-dev/
- Phaser 3 docs: https://newdocs.phaser.io/docs/3.88.0
- Phaser + React template: https://github.com/phaserjs/template-react-ts
- rot.js manual: https://ondras.github.io/rot.js/manual/
- RexRainbow Board plugin: https://rexrainbow.github.io/phaser3-rex-notes/docs/site/board/
- Koota ECS: https://github.com/pmndrs/koota
- Comlink: https://github.com/GoogleChromeLabs/comlink
- Kenney Roguelike/RPG Pack: https://kenney.nl/assets/roguelike-rpg-pack
- LLM game agent survey (updated Nov 2025): https://arxiv.org/abs/2404.02039
