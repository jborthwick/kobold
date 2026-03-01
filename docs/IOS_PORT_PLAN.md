# Kobold → iOS Native Port Plan

A complete guide for porting the Dwarf Colony Sim from Phaser 3 + React (web) to
SpriteKit + SwiftUI + GameplayKit (iOS native). Written for a new Claude agent or
developer to execute from scratch in a new repository.

---

## Table of Contents

1. [Strategic Decisions](#1-strategic-decisions)
2. [Architecture Overview](#2-architecture-overview)
3. [Project Structure](#3-project-structure)
4. [Implementation Phases](#4-implementation-phases)
5. [Data Model (Swift Codable)](#5-data-model-swift-codable)
6. [Simulation Engine](#6-simulation-engine)
7. [World Generation](#7-world-generation)
8. [Agent Behavior Tree](#8-agent-behavior-tree)
9. [Crisis Detection & LLM Integration](#9-crisis-detection--llm-integration)
10. [World Events](#10-world-events)
11. [Rendering (SpriteKit)](#11-rendering-spritekit)
12. [UI (SwiftUI)](#12-ui-swiftui)
13. [Camera & Input](#13-camera--input)
14. [On-Device AI (Apple Foundation Models)](#14-on-device-ai-apple-foundation-models)
15. [Emergent Systems Upgrades](#15-emergent-systems-upgrades)
16. [Save/Load & App Lifecycle](#16-saveload--app-lifecycle)
17. [Constants Reference](#17-constants-reference)
18. [Non-Obvious Gotchas](#18-non-obvious-gotchas)
19. [Reference Links](#19-reference-links)

---

## 1. Strategic Decisions

These decisions were made after evaluating Capacitor wrapping, Rust+WASM+UniFFI
shared core, Kotlin Multiplatform, and pure Swift. See the web prototype's
`CLAUDE.md` and `docs/RESEARCH.md` for the full evaluation.

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Platform | iOS-only (pure Swift) | Web was the prototype; iOS is the product |
| Rendering | SpriteKit | Native Metal perf, built-in camera/physics, first-class iOS citizen |
| UI | SwiftUI | Overlays compose naturally with SpriteKit via `SpriteView` |
| Simulation | Port to Swift | ~1000 lines of pure logic; translates line-for-line |
| Pathfinding | GameplayKit `GKGridGraph` | Apple's built-in A\*, replaces rot.js |
| World gen noise | `GKNoise` / `GKNoiseMap` | Native Perlin/Simplex/Voronoi, no dependency |
| AI (default) | Apple Foundation Models | Zero cost, offline, good enough for crisis decisions |
| AI (premium) | Claude API via URLSession | Better quality; opt-in for players who want it |
| State management | Combine (`ObservableObject`) | Replaces mitt event bus; native reactive framework |
| Persistence | Codable + FileManager | Auto-save on lifecycle events; replaces localStorage |
| Code sharing | None | Simulation is ~1000 lines; maintaining a bridge costs more than the port |

### Why not share code with the web version?

The simulation logic (the part worth sharing) is the smallest, most stable part of
the codebase. The rendering, input, UI, and platform integration (the parts you
can't share) are where all the time goes. Options evaluated:

- **TypeScript in JavaScriptCore:** Works but has ~50KB/tick serialization overhead,
  no access to GameplayKit, and debugging spans two toolchains.
- **Rust core (wasm-bindgen + UniFFI):** Architecturally correct but requires a full
  rewrite into Rust, heavier build toolchain, and slower iteration.
- **Kotlin Multiplatform:** Strong for Android+iOS, less compelling for web+iOS only.

For a codebase this size, two clean implementations beat one shared-but-bridged
implementation. The TypeScript version remains a living specification.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  iOS App (Swift 5.9+, iOS 18.1+)                │
├─────────────────────────────────────────────────┤
│                                                  │
│  SwiftUI Layer                                   │
│  ├─ ContentView (root)                           │
│  ├─ HUDView (top bar, stats, controls)           │
│  ├─ DwarfPanel (selected dwarf detail)           │
│  ├─ EventLogView (scrollable log)                │
│  ├─ ColonyGoalPanel (goal progress, stockpiles)  │
│  └─ MiniMapView (canvas overlay)                 │
│       ↕ @ObservedObject GameStatePublisher       │
│                                                  │
│  SpriteKit Layer                                 │
│  ├─ GameScene (terrain, sprites, overlays)       │
│  ├─ CameraController (pan, zoom, bounds)         │
│  └─ InputHandler (tap, long-press, pinch, drag)  │
│       ↕ SimulationEngine reference               │
│                                                  │
│  Simulation Layer (pure Swift, no UI imports)     │
│  ├─ SimulationEngine (tick orchestration)        │
│  ├─ AgentSystem (behavior tree, roles)           │
│  ├─ WorldGenerator (GKNoise, cluster placement)  │
│  ├─ WorldEvents (blight, bounty, ore, mushroom)  │
│  └─ CrisisSystem (detection, LLM dispatch)       │
│       ↕ async/await (detached tasks)             │
│                                                  │
│  AI Layer                                        │
│  ├─ OnDeviceAI (Apple Foundation Models)         │
│  └─ CloudAI (URLSession → Anthropic API)         │
│                                                  │
│  Persistence Layer                               │
│  ├─ SaveManager (Codable ↔ FileManager)          │
│  └─ AppLifecycle (auto-save on resign/terminate) │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Key architectural rules (carry forward from web version)

1. **Never block the game loop.** LLM calls are detached async tasks — never awaited
   in the simulation tick.
2. **Never crash on bad LLM output.** Every JSON parse is wrapped in do/catch; every
   field has a fallback.
3. **Keep prompts under 500 tokens.** Memory capped at 5 entries; compress aggressively.
4. **One decision per crisis, not one per tick.** Cooldown: 280 ticks (~40 s) per dwarf.
5. **Always playable without LLM.** If AI is unavailable, agents fall back silently to
   the deterministic behavior tree.

---

## 3. Project Structure

```
KoboldIOS/
├── KoboldApp.swift                  # @main entry point
├── Game/
│   ├── GameScene.swift              # SpriteKit scene (tilemap, sprites, overlays)
│   ├── BootScene.swift              # Asset preload → transition to GameScene
│   ├── CameraController.swift       # Pan/zoom/bounds logic
│   ├── InputHandler.swift           # Gesture recognizers, tap/drag/pinch
│   ├── SpriteManager.swift          # Dwarf/goblin/ghost sprite lifecycle
│   └── OverlayRenderer.swift        # Selection rings, flags, stockpile borders
├── Simulation/
│   ├── SimulationEngine.swift       # Core tick orchestration (gameTick)
│   ├── AgentSystem.swift            # tickAgent() behavior tree (port of agents.ts)
│   ├── Pathfinding.swift            # GKGridGraph A* wrapper
│   ├── WorldGenerator.swift         # GKNoise-based procedural world gen
│   ├── Growback.swift               # Per-tick food/wood regrowth
│   ├── WorldEvents.swift            # Blight, bounty, ore discovery, mushroom
│   ├── GoblinSystem.swift           # Goblin spawning, patrol, combat
│   ├── StockpileSystem.swift        # Depot deposit/withdraw, room expansion
│   ├── ColonyGoalSystem.swift       # Goal cycling, progress, morale bonus
│   └── SuccessionSystem.swift       # Death → queued respawn with memory inheritance
├── AI/
│   ├── CrisisDetector.swift         # Rule-based crisis detection (runs every tick)
│   ├── LLMSystem.swift              # Decision dispatch, cooldown, verify step
│   ├── PromptBuilder.swift          # buildPrompt() — crisis → structured prompt
│   ├── OnDeviceAI.swift             # Apple Foundation Models integration
│   └── CloudAI.swift                # URLSession → Anthropic API (opt-in)
├── UI/
│   ├── ContentView.swift            # Root: SpriteView + SwiftUI overlays
│   ├── HUDView.swift                # Top bar (stats, pause/speed, LLM toggle)
│   ├── DwarfPanel.swift             # Selected dwarf detail (bars, memory, relations)
│   ├── EventLogView.swift           # Scrollable colored log (max 50 entries)
│   ├── ColonyGoalPanel.swift        # Goal progress bar + stockpile levels
│   ├── MiniMapView.swift            # Canvas overlay minimap
│   └── TileTooltip.swift            # Tap-to-inspect tile info
├── Data/
│   ├── Types.swift                  # All enums, structs (Dwarf, Tile, Goblin, etc.)
│   ├── Constants.swift              # GRID_SIZE, TILE_SIZE, TICK_RATE, etc.
│   ├── GameState.swift              # Published game state container
│   └── GameStatePublisher.swift     # ObservableObject bridge (Simulation → SwiftUI)
├── Persistence/
│   ├── SaveManager.swift            # Codable serialization ↔ FileManager
│   └── AppLifecycle.swift           # Auto-save on applicationWillResignActive
├── Assets.xcassets/                 # Kenney 1-bit spritesheet + app icons
└── Tests/
    ├── SimulationTests.swift        # Behavior tree determinism tests
    ├── WorldGenTests.swift          # World generation invariant tests
    ├── SerializationTests.swift     # Codable round-trip tests
    └── CrisisTests.swift            # Crisis detection rule tests
```

---

## 4. Implementation Phases

### Phase 1: Data types + world generation (days 1–3)

**Goal:** Generate and render a 64×64 tilemap in SpriteKit.

1. Define all `Codable` types in `Types.swift` (see §5)
2. Define all constants in `Constants.swift` (see §17)
3. Port `generateWorld()` using `GKNoise` for elevation + moisture (see §7)
4. Create `BootScene.swift` to load Kenney spritesheet
5. Create `GameScene.swift` to render tilemap from `grid[y][x]`
6. Verify: 64×64 grid renders with correct tile frames and food tinting

### Phase 2: Simulation engine + agents (days 4–8)

**Goal:** Dwarves spawn, forage, starve, and die — fully deterministic, no LLM.

1. Port `SimulationEngine.swift` tick orchestration
2. Port `Pathfinding.swift` using `GKGridGraph` (4-directional, topology matches rot.js)
3. Port `AgentSystem.swift` — exact behavior tree priority cascade (see §8)
4. Port `Growback.swift` — per-tick food/wood regrowth
5. Port `spawnDwarves()` with round-robin role assignment
6. Wire simulation tick into `GameScene.update(_:)` with delta gating
7. Render dwarf sprites with hunger-based color tinting
8. Verify: 5 dwarves forage, eat, wander, starve, and die correctly

### Phase 3: SwiftUI HUD + event bus (days 9–12)

**Goal:** Full UI overlay showing game state, controls, and event log.

1. Create `GameStatePublisher` as `ObservableObject`
2. Wire simulation tick to publish state snapshot each tick
3. Build `HUDView` (dwarf count, food, materials, tick, pause/speed)
4. Build `DwarfPanel` (health/hunger/morale bars, inventory, role badge)
5. Build `EventLogView` (scrollable, colored by severity, max 50 entries)
6. Build `ColonyGoalPanel` (goal progress bar, stockpile levels)
7. Compose in `ContentView` using `ZStack` (SpriteView underneath, SwiftUI on top)

### Phase 4: Camera, input, selection (days 13–16)

**Goal:** Pan, zoom, select dwarves, issue commands.

1. Implement `CameraController` with `SKCameraNode`
2. Drag-to-pan via `UIPanGestureRecognizer`
3. Pinch-to-zoom via `UIPinchGestureRecognizer` (0.5×–5×)
4. Tap-to-select (snap to nearest dwarf within 32px radius)
5. Long-press-to-command (set commandTarget on selected dwarf)
6. Selected dwarf highlight ring (cyan `SKShapeNode`)
7. Command flag marker (yellow square on target tile)
8. Cycle selected dwarf with swipe gesture or UI buttons

### Phase 5: World events, goblins, stockpiles, goals (days 17–21)

**Goal:** Full gameplay loop with all systems.

1. Port `WorldEvents.swift` (blight, bounty, ore discovery, mushroom spread)
2. Port `GoblinSystem.swift` (spawning, patrol AI, combat resolution)
3. Port `StockpileSystem.swift` (food/ore/wood depots, deposit/withdraw, room expansion)
4. Port `ColonyGoalSystem.swift` (goal cycling, progress tracking, morale bonus)
5. Port `SuccessionSystem.swift` (death → queued respawn, memory inheritance)
6. Fort-building system (miners place walls from ore stockpile)

### Phase 6: AI integration (days 22–26)

**Goal:** On-device AI for crisis decisions, with Claude API as opt-in.

1. Port `CrisisDetector.swift` (rule-based, runs every tick)
2. Port `LLMSystem.swift` (cooldown, pending requests, VERIFY step)
3. Port `PromptBuilder.swift` (structured prompt, <500 tokens)
4. Implement `OnDeviceAI.swift` using Apple Foundation Models framework
5. Implement `CloudAI.swift` using URLSession → Anthropic API
6. Simplified JSON output schema for on-device model (just `intent` + `action`)
7. Full JSON schema for Claude API (action, intent, reasoning, emotional_state, expectedOutcome)
8. Settings UI: toggle AI on/off, choose on-device vs. cloud

### Phase 7: Persistence, polish, ship (days 27–30)

**Goal:** App Store ready.

1. Implement `SaveManager` with Codable serialization
2. Auto-save on `applicationWillResignActive` / `scenePhase` changes
3. Codable round-trip tests for all game state
4. Ghost sprites for dead dwarves (red tint, Y-flipped)
5. Off-screen dwarf indicators (arrows at screen edges)
6. Resource overlay toggle (food/material/wood density heatmap)
7. Performance profiling (target 60fps, 30fps minimum on A15)
8. App icon, launch screen, TestFlight

---

## 5. Data Model (Swift Codable)

Port these types from `src/shared/types.ts`. All must be `Codable` for save/load.

```swift
// MARK: - Enums

enum TileType: String, Codable, CaseIterable {
    case dirt, grass, stone, water, forest, farmland, ore, mushroom, wall
}

enum DwarfRole: String, Codable, CaseIterable {
    case forager, miner, scout, fighter, lumberjack
}

enum DwarfTrait: String, Codable, CaseIterable {
    case lazy, forgetful, helpful, mean, paranoid, brave, greedy, cheerful
}

enum LLMIntent: String, Codable {
    case eat, forage, rest, avoid, none
}

enum ColonyGoalType: String, Codable {
    case stockpileFood, surviveTicks, defeatGoblins, encloseFort
}

enum OverlayMode: String, Codable {
    case off, food, material, wood
}

// MARK: - Core Structs

struct Tile: Codable {
    var type: TileType
    var foodValue: Double
    var materialValue: Double
    var maxFood: Double
    var maxMaterial: Double
    var growbackRate: Double     // food units/tick; 0 = no regrowth
}

struct Inventory: Codable {
    var food: Int
    var materials: Int
}

struct ResourceSite: Codable {
    var x: Int
    var y: Int
    var value: Double           // foodValue or materialValue when last seen
    var tick: Int               // currentTick when last updated
}

struct MemoryEntry: Codable {
    var tick: Int
    var crisis: String          // CrisisSituation.type or "inheritance"
    var action: String
    var reasoning: String?
    var outcome: String?        // backfilled by VERIFY step
}

struct Dwarf: Codable, Identifiable {
    var id: String              // "dwarf-{i}" or "dwarf-{timestamp}"
    var name: String
    var baseName: String
    var generation: Int         // 1 for originals; increments on succession
    var x: Int
    var y: Int
    var health: Double
    var maxHealth: Double
    var hunger: Double          // 0–100; starvation at 100
    var metabolism: Double      // hunger added per tick (0.15–0.35)
    var vision: Int             // tile scan radius
    var inventory: Inventory
    var morale: Double          // 0–100
    var alive: Bool
    var task: String            // display label in HUD
    var role: DwarfRole
    var commandTarget: GridPoint?
    var llmReasoning: String?
    var llmIntent: LLMIntent?
    var llmIntentExpiry: Int
    var memory: [MemoryEntry]   // uncapped; last 5 used in prompts
    var wanderTarget: GridPoint?
    var wanderExpiry: Int
    var knownFoodSites: [ResourceSite]  // cap 5
    var knownOreSites: [ResourceSite]   // cap 5
    var knownWoodSites: [ResourceSite]  // cap 5
    var homeTile: GridPoint
    var relations: [String: Double]     // dwarfId → 0–100 (50 = neutral)
    var trait: DwarfTrait
    var bio: String
    var goal: String
    var goblinKills: Int
    var causeOfDeath: String?
}

struct GridPoint: Codable, Hashable {
    var x: Int
    var y: Int
}

struct Goblin: Codable, Identifiable {
    var id: String
    var x: Int
    var y: Int
    var health: Double
    var maxHealth: Double
    var targetId: String?       // dwarf.id being chased
    var staggeredUntil: Int?    // post-hit cooldown tick
}

struct ColonyGoal: Codable {
    var type: ColonyGoalType
    var description: String
    var progress: Double
    var target: Double
    var generation: Int         // scales difficulty: 1 + generation × 0.5
}

struct FoodStockpile: Codable {
    var x: Int
    var y: Int
    var food: Double
    var maxFood: Double
}

struct OreStockpile: Codable {
    var x: Int
    var y: Int
    var ore: Double
    var maxOre: Double
}

struct WoodStockpile: Codable {
    var x: Int
    var y: Int
    var wood: Double
    var maxWood: Double
}
```

---

## 6. Simulation Engine

The simulation engine is a pure-logic tick orchestrator. It owns all mutable game
state and exposes a `tick()` method called from `GameScene.update(_:)`.

### Tick gating (in GameScene)

```swift
// GameScene.swift
var lastTickTime: TimeInterval = 0

override func update(_ currentTime: TimeInterval) {
    let interval = Constants.tickRateSeconds / Double(speed)
    if currentTime - lastTickTime >= interval {
        lastTickTime = currentTime
        simulationEngine.tick()
        gameStatePublisher.update(from: simulationEngine)
    }
}
```

### Tick orchestration (SimulationEngine.tick)

Port from `WorldScene.gameTick()`. Execution order matters:

```
1.  VERIFY step: check pending LLM outcome verifications (40 ticks after decision)
2.  For each alive dwarf: tickAgent(dwarf, ...) — mutates dwarf in place
3.  For each alive dwarf (if AI enabled): requestDecision (async, detached)
4.  tickGoblins: patrol, chase, combat resolution
5.  growback(grid): per-tile food/wood regrowth
6.  tickWorldEvents(grid, tick): blight/bounty/ore/mushroom (every 300–600 ticks)
7.  tickMushroomSprout(grid, tick): steady small patches (every 60 ticks)
8.  Process succession queue: spawn replacements ~300 ticks after death
9.  Stockpile room expansion: grow when full
10. Colony goal progress update
11. Increment tick counter
```

### Critical rule: LLM calls are detached

```swift
// CORRECT — never blocks tick
Task.detached { [weak self] in
    await self?.llmSystem.requestDecision(for: dwarf, ...)
}

// WRONG — blocks the game loop
let decision = await llmSystem.requestDecision(for: dwarf, ...)
```

---

## 7. World Generation

### Current approach (web version)

Uses hand-rolled `sin()`-based noise hash for tile variation and sinusoidal river.
Works but produces limited terrain diversity.

### Recommended iOS approach: GKNoise dual-map biome classification

```swift
import GameplayKit

func generateWorld(seed: Int32) -> (grid: [[Tile]], spawnZone: CGRect) {
    // 1. Elevation map (Perlin noise)
    let elevSrc = GKPerlinNoiseSource(frequency: 0.05, octaveCount: 4,
                                       persistence: 0.5, lacunarity: 2.0,
                                       seed: seed)
    let elevNoise = GKNoise(elevSrc)
    let elevMap = GKNoiseMap(elevNoise,
                             size: vector_double2(Double(GRID_SIZE), Double(GRID_SIZE)),
                             origin: vector_double2(0, 0),
                             sampleCount: vector_int2(Int32(GRID_SIZE), Int32(GRID_SIZE)),
                             seamless: false)

    // 2. Moisture map (Simplex noise, different seed)
    let moistSrc = GKPerlinNoiseSource(frequency: 0.08, octaveCount: 3,
                                        persistence: 0.6, lacunarity: 2.0,
                                        seed: seed &+ 12345)
    let moistNoise = GKNoise(moistSrc)
    let moistMap = GKNoiseMap(moistNoise, /* same size/sample params */)

    // 3. Classify biome per tile
    for y in 0..<GRID_SIZE {
        for x in 0..<GRID_SIZE {
            let elev = elevMap.value(at: vector_int2(Int32(x), Int32(y)))  // -1..1
            let moist = moistMap.value(at: vector_int2(Int32(x), Int32(y)))
            grid[y][x] = classifyBiome(elevation: elev, moisture: moist)
        }
    }

    // 4. Carve river (sinusoidal, same algorithm as web version)
    // 5. Place ore clusters (Voronoi noise or random placement)
    // 6. Place mushroom patches
    // 7. Place farmland strips
    // 8. Clear spawn zone LAST (always overwrites to walkable dirt)
}
```

### Biome classification (elevation × moisture)

| | Low moisture | High moisture |
|---|---|---|
| **Low elevation** | Dirt | Farmland |
| **Mid elevation** | Grass (meadow) | Forest |
| **High elevation** | Stone | Ore |
| **Very low elevation** | Water | Water |

### Must preserve from web version

- **River:** sinusoidal with two overlapping sine waves, 2 guaranteed crossings
- **Spawn zone cleared LAST:** 12×6 rectangle, all Dirt, guarantees walkable start
- **Resource values:** Forest food 8–12, Mushroom 3–5, Farmland 2–3, Ore 8–12
- **Initial values:** foodValue = maxFood × (0.7 + random 0.3) — tiles spawn 70–100% full

---

## 8. Agent Behavior Tree

This is the heart of the simulation. Port **exactly** from `agents.ts:tickAgent()`.
The priority ordering drives emergent scarcity behavior — do not simplify or reorder.

### Priority cascade (execute first match, then return)

```
1.   STARVATION: hunger ≥ 100 AND food == 0
       → health -= 2, morale -= 2
       → if health ≤ 0: die (causeOfDeath = "starvation")

2.   EAT: hunger > 70 AND food > 0
       → eat min(3, food) units; hunger -= bite × 20
       → RETURN

2.5  LLM INTENT (if active and not expired):
       eat    → force-eat if hunger > 30 (below normal 70 threshold)
       rest   → skip this tick (stay put)
       forage → handled in step 4 (expanded scan radius)
       avoid  → handled in step 5

2.7  FOOD SHARING: food ≥ 8
       → find hungriest neighbor within 2 tiles (hunger > 60 AND food < 3)
       → gift 3 food; donor keeps ≥ 5
       → relations: giver +10, recipient +15

2.8  FOOD STOCKPILE: standing on stockpile
       deposit: food ≥ 10 → deposit (food − 6), keep ≥ 4
       withdraw: hunger > 60 AND food < 2 → withdraw min(4, stock.food)

2.9  ORE STOCKPILE DEPOSIT (miners): standing on stockpile AND materials > 0
2.9b WOOD STOCKPILE DEPOSIT (lumberjacks): standing on stockpile AND materials > 0

3.   PLAYER COMMAND: commandTarget set
       → pathNextStep toward target; clear on arrival

3.5  FIGHTER HUNT (fighters only): nearest goblin within vision × 2
       → pathNextStep toward goblin; take TWO steps per tick (sprint)
       → skip if hunger ≥ 80 or llmIntent == rest

4.   FORAGE + HARVEST (Sugarscape rule):
       scan radius: llmIntent==forage ? 15 : hunger>65 ? min(vision×2,15) : vision
       → find richest FORAGEABLE tile (Mushroom only by default)
       → record site in spatial memory if value ≥ 3
       → contest yield: if hungrier dwarf on same tile, step away (relation −5)
       → harvest: depletion 5–6 per visit, yield 1–2 to dwarf
       → foragers special: depletion 6, yield 2 (others: 5, 1)
       → fully depleted tiles revert to Dirt

4.2  DEPOT RETURN: food ≥ 10 AND hunger < 55
       → pathfind to nearest food stockpile with capacity

4.3  STOCKPILE RUN: hunger > 65 AND food == 0 AND stockpile has food
       → pathfind to nearest food stockpile

4.3c REMEMBERED FOOD SITE: knownFoodSites not empty
       → pathfind to richest remembered site
       → on arrival: verify tile still harvestable; evict from memory if depleted
       → scan PATCH_MERGE_RADIUS (4 tiles) for surviving tiles in same patch

4.3b MINER FORT-BUILDING: hunger < 65, ore stockpile has ore ≥ 3
       → fortWallSlots() then fortEnclosureSlots()
       → pathfind to nearest unbuilt slot; place Wall tile, deduct 3 ore

4.4  MINER ORE RUN: materials ≥ 8 AND ore stockpile has capacity
4.4b LUMBERJACK LUMBER RUN: materials ≥ 8 AND wood stockpile has capacity

4.45  REMEMBERED ORE SITE (miners): knownOreSites not empty
4.45b REMEMBERED FOREST SITE (lumberjacks): knownWoodSites not empty

4.5  MINER ORE TARGETING: no visible food → scan for richest ore tile
       → mine 2 units/tick; exhausted veins revert to Stone

4.5b LUMBERJACK WOOD TARGETING: scan for richest Forest tile
       → chop 2 units/tick; Forest stays Forest even when depleted (regrows)

5.   WANDER / AVOID:
     5a. avoid (llmIntent == avoid): maximize distance from nearest rival within 5 tiles
     5b. persistent wander: hold waypoint 25 ticks, ~25% drift toward homeTile,
         otherwise random point 10–20 tiles away
```

### Role stats

| Role | Vision | HP | Special behavior |
|------|--------|-----|-----------------|
| forager | 5–8 | 100 | Harvest 2 food/visit (others: 1); depletion 6 (others: 5) |
| miner | 4–6 | 100 | Targets ore when no food nearby; builds fort walls |
| scout | 7–12 | 100 | Wide contest radius (4 tiles); early threat detection |
| fighter | 4–7 | 130 | Hunts goblins within vision×2; deals 18 hp/hit (others: 8); sprints 2 steps/tick |
| lumberjack | 5–8 | 100 | Targets Forest tiles for wood; wood regrows at 0.02/tick |

### Role assignment

Round-robin at spawn: `forager, miner, scout, lumberjack, fighter, forager, ...`

### Pathfinding

Replace rot.js A\* with `GKGridGraph`:

```swift
let graph = GKGridGraph(
    fromGridStartingAt: vector_int2(0, 0),
    width: Int32(GRID_SIZE),
    height: Int32(GRID_SIZE),
    diagonalsAllowed: false  // topology=4, matches rot.js
)

// Remove unwalkable nodes (Water, Wall)
let unwalkable = grid.enumerated().flatMap { y, row in
    row.enumerated().compactMap { x, tile in
        !isWalkable(tile) ? graph.node(atGridPosition: vector_int2(Int32(x), Int32(y))) : nil
    }
}
graph.remove(unwalkable)

// Single step toward target
func pathNextStep(from: GridPoint, to: GridPoint) -> GridPoint {
    guard let startNode = graph.node(atGridPosition: vector_int2(...)),
          let endNode = graph.node(atGridPosition: vector_int2(...)),
          let path = startNode.findPath(to: endNode) as? [GKGridGraphNode],
          path.count >= 2 else {
        return from  // unreachable → stay put
    }
    let next = path[1].gridPosition
    return GridPoint(x: Int(next.x), y: Int(next.y))
}
```

**Important:** Rebuild the graph (or update removed nodes) whenever a Wall tile is
placed or destroyed. The web version marks the goal tile as always-passable in the
callback — replicate this by temporarily adding the goal node before pathfinding.

---

## 9. Crisis Detection & LLM Integration

### Crisis detection (runs every tick, cheap rule check)

| Type | Condition |
|------|-----------|
| `goblin_raid` | Any goblin within 8 tiles (checked FIRST, most urgent) |
| `low_supplies` | food ≤ 2 AND hunger ≥ 40 |
| `hunger` | hunger ≥ 65 |
| `morale` | morale ≤ 40 |
| `resource_contest` | Rival within 2 tiles (scouts: 4) with food < 3 |
| `resource_sharing` | Own food ≥ 8 AND nearby dwarf (≤2 tiles) hunger > 60 AND food < 3 |

### LLM call flow

```
detectCrisis(dwarf) → CrisisSituation?
  → if nil: no crisis, skip
  → if pending request for this dwarf: skip (max 1 in-flight per agent)
  → if cooldown active: skip (280 ticks between calls)
  → buildPrompt(dwarf, situation, memory[-5:], relations, goal)
  → fire detached async task:
      let decision = await aiProvider.complete(prompt)
      dwarf.llmIntent = decision.intent
      dwarf.llmIntentExpiry = currentTick + 50
      dwarf.llmReasoning = decision.reasoning
      dwarf.task = decision.action
      schedule VERIFY at currentTick + 40
  → set cooldown: currentTick + 280
```

### VERIFY step (PIANO §6)

40 ticks after each LLM decision, snapshot dwarf state and evaluate:

| Intent | Failure condition | Outcome message |
|--------|-------------------|-----------------|
| `eat` | hunger rose since decision | "Still hungry — eating didn't help" |
| `forage` | food didn't increase | "Foraging failed — no food found" |
| `rest` | hunger > 80 | "Rested but now dangerously hungry" |
| `avoid` | (no verification) | — |

Backfill `outcome` into the memory entry. Next LLM prompt sees what actually happened.

### Prompt format

```
You are {name}, a dwarf {roleLabel}
Personality: {trait}. "{bio}". Personal goal: {goal}.
Status — Health: {health}/{maxHealth}, Hunger: {hunger}/100, Morale: {morale}/100
Food carried: {food} units. Current task: {task}. {homeDist} tiles from fort.

CRISIS: {description}
Colony context: {colonyContext}
Colony goal: {goalDescription} ({progress}/{target})

Relationships: {allies (>60) and rivals (<40)}

RECENT DECISIONS: [last 5 memory entries with outcomes]

Respond ONLY as valid JSON:
{"action": "...", "intent": "eat|forage|rest|avoid|none", "reasoning": "...",
 "emotional_state": "...", "expectedOutcome": "..."}
```

**Token budget:** max_tokens = 256, timeout = 5 seconds.

---

## 10. World Events

### Periodic events (every 300–600 ticks)

| Event | Probability | Effect |
|-------|-------------|--------|
| Blight | 25% | Halve maxFood in 6-tile radius around random food tile |
| Bounty | 25% | Boost food ×1.5 (cap 20) in 5-tile radius |
| Ore discovery | 25% | Spawn up to 5 new Ore tiles in 3-tile cluster |
| Mushroom spread | 25% | Large patch radius 3–5, up to 14 tiles, ~60% fill |

### Steady mushroom sprouting (every 60 ticks)

Smaller patches: radius 2, up to 8 tiles, ~70% fill. Keeps map viable after
dwarves strip early mushroom patches.

### Growback rates

| Tile type | Food growback | Wood growback |
|-----------|--------------|---------------|
| Forest | 0.04/tick | 0.02/tick |
| Farmland | 0.02/tick | — |
| Mushroom | 0.08/tick | — |
| Grass meadow | 0.02/tick | — |
| Ore | 0 (finite) | — |

---

## 11. Rendering (SpriteKit)

### Tilemap

Use `SKTileMapNode` or manual `SKSpriteNode` grid:

```swift
// Kenney 1-bit Pack: 49 cols × 22 rows, 16×16 px per tile
// Frame index = row * 49 + col (0-based)
let tileConfig: [TileType: [Int]] = [
    .dirt:     [0, 1, 2],
    .grass:    [5, 6, 7],
    .forest:   [49, 50, 51, 52, 53, 54, 101, 102],
    .water:    [253],
    .stone:    [103],
    .farmland: [310],
    .ore:      [522],
    .mushroom: [554],
    .wall:     [103],
]
let spriteConfig = (dwarf: 318, goblin: 124, tombstone: 686)
```

### Tile variation (deterministic, position-based)

```swift
func tileNoise(x: Int, y: Int) -> Double {
    let n = sin(Double(x) * 127.1 + Double(y) * 311.7 + Double(worldSeed)) * 43758.5453
    return n - floor(n)
}
let frame = frames[Int(tileNoise(x: x, y: y) * Double(frames.count))]
```

### Food density tinting

Darken tiles as food depletes: interpolate tile color from full brightness to
dark brown based on `foodValue / maxFood`.

### Dwarf sprites

- Color-shifted green → red based on hunger (0 → 100)
- Dead dwarves: red tint, Y-flipped (`yScale = -1`), persist as ghosts
- Selection ring: cyan `SKShapeNode` circle around selected dwarf
- Command flag: yellow square on target tile

### Z-ordering (critical)

```swift
// SpriteKit uses zPosition (higher = on top)
enum ZOrder: CGFloat {
    case terrain   = 0
    case overlay   = 10
    case stockpile = 20
    case ghost     = 30
    case goblin    = 40
    case dwarf     = 50
    case selection = 60
    case indicator = 70   // off-screen arrows
}
```

---

## 12. UI (SwiftUI)

### Composition

```swift
struct ContentView: View {
    @StateObject var gameState = GameStatePublisher()

    var body: some View {
        ZStack {
            SpriteView(scene: gameScene)
                .ignoresSafeArea()

            VStack {
                HUDView(state: gameState)
                Spacer()
            }

            // Right panel (selected dwarf / goal / log)
            HStack {
                Spacer()
                SidebarView(state: gameState)
                    .frame(width: 300)
            }
        }
    }
}
```

### Phone vs. tablet layout

- **iPad:** Full sidebar (300px) with DwarfPanel + EventLog + GoalPanel
- **iPhone:** Bottom sheet that slides up on dwarf selection; collapsed top bar; event
  log accessible via swipe-up drawer

### Key components

| Component | Web equivalent | Notes |
|-----------|---------------|-------|
| `HUDView` | `HUD.tsx` top bar | Dwarf count, food, materials, tick, pause/speed, AI toggle |
| `DwarfPanel` | `SelectedDwarfPanel` | Health/hunger/morale bars, memory timeline, relations |
| `EventLogView` | `EventLog.tsx` | ScrollViewReader + auto-scroll; color by severity |
| `ColonyGoalPanel` | `ColonyGoalPanel` | Progress bar + stockpile levels |
| `TileTooltip` | `tileHover` event | Tap tile to see food/ore density |

---

## 13. Camera & Input

### Camera (SpriteKit)

```swift
let cameraNode = SKCameraNode()
scene.camera = cameraNode
scene.addChild(cameraNode)

// Pan: adjust camera position
cameraNode.position.x += delta.x / cameraNode.xScale
cameraNode.position.y += delta.y / cameraNode.yScale

// Zoom: adjust camera scale (inverse of Phaser zoom)
// SpriteKit: scale 0.5 = 2× magnification; scale 2.0 = 0.5× magnification
cameraNode.setScale(newScale)
```

**No viewport-center quirk** in SpriteKit (unlike Phaser). Positions are direct
world coordinates.

### Cursor-anchored zoom (pinch)

```swift
// World point under pinch center before zoom
let worldPt = scene.convertPoint(fromView: pinchCenter)
cameraNode.setScale(newScale)
let newWorldPt = scene.convertPoint(fromView: pinchCenter)
cameraNode.position.x -= (newWorldPt.x - worldPt.x)
cameraNode.position.y -= (newWorldPt.y - worldPt.y)
```

### Touch input mapping

| Web input | iOS equivalent | Action |
|-----------|---------------|--------|
| Left-click | Tap | Select dwarf / stockpile / goblin |
| Right-click | Long-press | Issue command to selected dwarf |
| Click + drag | One-finger drag | Pan camera |
| Scroll wheel | Pinch gesture | Zoom |
| WASD | (not applicable) | — |
| `[` / `]` | Swipe left/right on DwarfPanel | Cycle selected dwarf |
| `O` | UI button | Toggle overlay mode |
| Space | UI button | Pause/unpause |

### Selection snap radius

On touch devices, tapping a 16px tile is hard. Snap selection to the nearest
dwarf within 32px (2 tiles) of the tap point.

---

## 14. On-Device AI (Apple Foundation Models)

### Requirements

- iOS 18.1+ with Apple Intelligence enabled
- A17 Pro or M1+ chip (iPhone 15 Pro, iPad Air M1, etc.)
- Falls back gracefully to pure BT on unsupported devices

### Integration

```swift
import FoundationModels

class OnDeviceAI {
    func complete(prompt: String) async -> LLMDecision? {
        // Use Apple's on-device model
        // Simplified output: just intent + action (skip emotional_state)
        // Parse response, validate, return with defaults
    }
}
```

### Considerations

- On-device models (~3B params) are weaker than Claude Haiku
- Simplify expected output: require only `intent` and `action`
- Add aggressive JSON repair (strip markdown fences, fix common malformations)
- Test with adversarial inputs (empty response, garbage, partial JSON)
- If model unavailable at runtime, fall back to pure BT silently

### Claude API (opt-in premium)

```swift
class CloudAI {
    let apiEndpoint = "https://api.anthropic.com/v1/messages"

    func complete(prompt: String, apiKey: String) async -> LLMDecision? {
        var request = URLRequest(url: URL(string: apiEndpoint)!)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        // ... standard Anthropic API call
    }
}
```

API key stored in Keychain. Player provides their own key in Settings, or you run
a backend proxy with rate limiting.

---

## 15. Emergent Systems Upgrades

These are new systems to add during or after the port, designed to create RimWorld-style
cascading emergence. Each is an independent system that writes to shared dwarf/grid state.

### Utility AI (replace hardcoded BT priorities)

Instead of fixed `if/else` priority cascade, score every possible action each tick:

```swift
struct ActionScore {
    let action: AgentAction
    let score: Double
}

func scoreActions(dwarf: Dwarf, context: SimContext) -> [ActionScore] {
    return [
        ActionScore(.eat,     score: hungerCurve(dwarf.hunger) * foodAvail(dwarf)),
        ActionScore(.forage,  score: scarcityCurve(nearbyFood) * traitMod(dwarf, .forage)),
        ActionScore(.flee,    score: threatCurve(nearestGoblin) * healthCurve(dwarf.health)),
        ActionScore(.share,   score: empathyCurve(neighborHunger) * surplusCurve(dwarf)),
        ActionScore(.mine,    score: roleBias(dwarf, .miner) * oreProximity),
        ActionScore(.fight,   score: roleBias(dwarf, .fighter) * goblinProximity),
        // ... more actions
    ].sorted { $0.score > $1.score }
}
```

Dwarf traits become curve modifiers: `brave` boosts fight score, `greedy` reduces
share score, `lazy` reduces forage score. Same BT execution logic, but dynamic
priority ordering.

### Weather system (new)

```swift
enum Weather: Codable { case clear, rain, drought, cold }

// Affects growback rates, dwarf metabolism, morale
// Drought → growback ×0.3 → food scarcity → hunger crisis → morale crash
// Rain → growback ×1.5 → abundance → surplus → sharing behavior
// Cold → metabolism ×1.5 → faster starvation → desperation
```

### Relationship system (upgrade existing)

Currently `relations: [String: Double]` with +10/−5 per interaction. Expand to:

```swift
struct Relationship: Codable {
    var trust: Double      // 0–100, grows from sharing/helping
    var grudge: Double     // 0–100, grows from contest/theft
    var interactions: Int  // total count
}

// Cascading effects:
// Low trust → won't share food → neighbor starves → morale spiral
// High grudge → avoids dwarf → less efficient foraging routes
// Trust > 80 → will rescue (pathfind to injured dwarf, share food even when hungry)
```

### Needs system (new, beyond hunger)

```swift
struct Needs: Codable {
    var hunger: Double    // existing
    var rest: Double      // 0–100; exhaustion reduces harvest speed
    var warmth: Double    // 0–100; affected by weather + proximity to fire
    var social: Double    // 0–100; decays when isolated, recovers near allies
}
```

Each need affects dwarf capability, creating cascading failures:
exhausted dwarf harvests slower → falls behind on food → starves → morale drops.

### AI Storyteller (meta-system)

Monitor colony health and time events for maximum drama:

```swift
class Storyteller {
    func evaluateColonyTension() -> Double {
        // High tension: many hungry, goblins nearby, low morale
        // Low tension: surplus food, no threats, high morale
    }

    func chooseNextEvent(tension: Double) -> WorldEvent {
        // High tension → bounty/respite (give players a break)
        // Low tension → blight/raid (create crisis)
        // Medium tension → random (unpredictable)
    }
}
```

---

## 16. Save/Load & App Lifecycle

### Serialization

All game state is `Codable`. Single JSON file:

```swift
struct SaveData: Codable {
    let version: Int = 1
    let tick: Int
    let grid: [[Tile]]
    let dwarves: [Dwarf]
    let goblins: [Goblin]
    let colonyGoal: ColonyGoal
    let foodStockpiles: [FoodStockpile]
    let oreStockpiles: [OreStockpile]
    let woodStockpiles: [WoodStockpile]
    let logHistory: [LogEntry]
    let nextEventTick: Int
    let pendingSuccessions: [PendingSuccession]
}
```

### Auto-save

```swift
// In AppDelegate or SceneDelegate
func sceneWillResignActive(_ scene: UIScene) {
    simulationEngine.pause()
    saveManager.save(simulationEngine.buildSaveData())
}
```

Auto-save every 100 ticks to document storage. On app kill, the last auto-save
restores state.

### Critical: round-trip test

Write a test that generates a world, runs 500 ticks, serializes to JSON, deserializes,
and verifies all state matches. This catches Codable conformance issues early.

---

## 17. Constants Reference

```swift
enum Constants {
    static let gridSize = 64
    static let tileSize: CGFloat = 16
    static let tickRateMs = 150                    // ~7 ticks/sec
    static let tickRateSeconds = 0.15
    static let initialDwarves = 5
    static let maxInventoryFood = 20

    // LLM
    static let cooldownTicks = 280                 // ~40 sec between LLM calls per dwarf
    static let verifyDelayTicks = 40               // ticks after decision to check outcome
    static let intentDurationTicks = 50            // how long LLM intent overrides BT
    static let maxMemoryInPrompt = 5
    static let llmTimeoutSeconds: TimeInterval = 5

    // World events
    static let eventMinInterval = 300              // ticks
    static let eventMaxInterval = 600
    static let mushroomSproutInterval = 60

    // Succession
    static let successionDelay = 300               // ticks before replacement spawns

    // Spatial memory
    static let siteRecordThreshold: Double = 3
    static let maxKnownSites = 5
    static let patchMergeRadius = 4

    // Wander
    static let wanderHoldTicks = 25
    static let wanderMinDist = 10
    static let wanderMaxDist = 20

    // Morale
    static let moraleDecayRate = 0.4               // per tick when hunger > 60
    static let moraleRecoveryRate = 0.2            // per tick when hunger < 30

    // Spawn zone
    static let spawnWidth = 12
    static let spawnHeight = 6

    // Combat
    static let fighterDamage: Double = 18
    static let defaultDamage: Double = 8
    static let goblinHealth: Double = 30

    // Dwarf names
    static let dwarfNames = [
        "Urist", "Bomrek", "Iden", "Sibrek", "Reg",
        "Meng", "Nish", "Kulet", "Doren", "Kol"
    ]
}
```

---

## 18. Non-Obvious Gotchas

### Simulation

1. **Depletion/yield split is critical.** Tiles lose 5–6 per harvest but dwarves gain
   1–2. This asymmetry forces exploration and creates scarcity pressure. Don't
   "fix" this — it's the core Sugarscape mechanic.

2. **Contest yield ordering.** When two dwarves are on the same tile, the hungrier one
   harvests first. Don't simplify to "first in array wins."

3. **Fully depleted mushroom tiles revert to Dirt** (maxFood = 0). Fully depleted
   Forest tiles stay as Forest (wood regrows). Different behavior per tile type.

4. **Fighters sprint 2 steps per tick** when chasing goblins. Other roles take 1 step.

5. **Memory is uncapped** in the array but only the last 5 entries are used in LLM
   prompts. Don't trim the array — save/load needs full history.

6. **Spatial memory patch merging.** Sites within PATCH_MERGE_RADIUS (4 tiles) are
   treated as the same patch to prevent a cluster of 10 mushroom tiles from burning
   all 5 memory slots.

### Rendering

7. **Z-ordering matters.** Terrain must render underneath overlays. In SpriteKit, use
   `zPosition`. In the web version, objects created before the tilemap layer were
   invisible — this was a recurring bug.

8. **Ghost sprites persist.** Dead dwarves render as red, Y-flipped sprites. Don't
   remove them on death.

### LLM

9. **LLM is off by default.** The game must be fully playable without any AI calls.

10. **Never await LLM in the game tick.** Use detached tasks. The callback mutates the
    dwarf object and the next tick picks up the changes.

11. **JSON parsing must never crash.** Wrap in do/catch. Default every field. Accept
    partial responses gracefully.

12. **Cooldown is global per dwarf** (280 ticks), not per crisis type. A dwarf who
    just resolved a hunger crisis can't immediately fire a morale crisis call.

### iOS-specific

13. **App can be killed at any time.** Auto-save on `sceneWillResignActive`. Don't
    rely on `applicationWillTerminate` — it's not guaranteed.

14. **Background execution.** Pause the simulation when the app backgrounds. Don't
    tick in the background — it wastes battery and the player can't see what's
    happening.

15. **Touch target size.** 16px tiles are too small for finger input. Snap selection
    to nearest entity within 32px. Consider auto-zooming when a dwarf is selected.

16. **Apple Foundation Models require A17 Pro+.** Check device capability at runtime
    and hide the AI toggle on unsupported hardware. The game works fine without it.

---

## Appendix A: Pre-Port Prototyping (Web)

Before porting to Swift, the following emergent behavior systems were prototyped in
the existing TypeScript/Phaser codebase. These validate the game design cheaply and
serve as a living spec for the iOS reimplementation.

### What was prototyped and why

The web prototype had four systems (traits, relations, morale, personal goals) that
were fully wired into the data model, rendered in the UI, and sent to the LLM — but
gated **zero behavior tree decisions**. Every dwarf acted identically regardless of
personality. Wiring these existing systems into gameplay was the lowest-lift path to
emergent behavior.

### Changes made (all in `src/simulation/agents.ts` unless noted)

#### 1. Trait modifiers → BT thresholds

Added `TRAIT_MODS` map and `traitMod()` helper. Traits now modify 6 hardcoded BT
thresholds:

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

#### 2. Relations gate sharing and contests

- **Sharing filter:** Dwarves now refuse to share food with neighbors whose relation
  score is below `shareRelationGate` (default 30; mean dwarves require 55).
  A mean dwarf who lost contests with a neighbor builds a grudge → refuses to share →
  neighbor starves → morale crisis → potentially dies.
- **Contest yield:** Allies (relation ≥ 60) on the same tile yield peacefully with a
  small cooperation bonus (+2) instead of stepping away with a penalty. Non-allies
  still contest normally.

#### 3. Morale affects the BT

- **Stress metabolism:** Dwarves with morale < 25 burn 30% extra hunger per tick.
  Creates a death spiral: hungry → low morale → burns calories faster → hungrier.
- **Harvest yield scales with morale:** 0.5× at morale 0, 1.0× at morale 100.
  Demoralized dwarves gather less food, staying hungry longer.

#### 4. Weather system (`src/simulation/weather.ts`, new file)

Global state that modifies growback rates and dwarf metabolism:

| Weather | Growback | Metabolism | When |
|---------|----------|------------|------|
| Clear | 1.0× | 1.0× | Default |
| Rain | 1.8× | 1.0× | Common in spring |
| Drought | 0.25× | 1.0× | Common in summer |
| Cold | 0.5× | 1.4× | Dominates winter |

Seasons cycle every 600 ticks (~85 s). Weather shifts at season boundaries and
randomly mid-season (0.2% per tick). Displayed in HUD top bar.

The weather system touches zero agent code — it modifies `growback()` multiplier
and `tickAgent()` metabolism multiplier, and the existing hunger/morale/sharing
mechanics cascade from there.

#### 5. Tension-aware storyteller (`src/simulation/events.ts`)

Replaced flat 25/25/25/25 event distribution with colony-health-aware selection:

| Colony tension | Event bias |
|----------------|------------|
| High (>70) | 45% bounty, 40% mushroom, 15% ore (help them) |
| Low (<30) | 50% blight, 25% ore, 25% mushroom (challenge them) |
| Medium | Uniform random (unpredictable) |

Tension = f(avg hunger, avg morale, goblin count, recent deaths). Creates dramatic
pacing: a struggling colony gets relief, a thriving colony gets challenged.

### How these cascade

The beauty is in the interaction, not any single system:

```
Winter arrives (weather)
  → Cold: growback ×0.5, metabolism ×1.4
  → Mushroom patches deplete faster, regrow slower
  → Dwarves burn calories faster → hunger rises
  → Morale drops (hunger > 60) → harvest yield drops (morale scale)
  → Stress metabolism kicks in (morale < 25) → even hungrier
  → Greedy dwarves hoard food (trait) → mean dwarves won't share (relation gate)
  → Starving neighbors build grudges (contest penalty) → future sharing blocked
  → Tension rises → storyteller sends bounty event (relief)
  → Spring arrives → rain → growback ×1.8 → recovery
```

No single system "knows" about the others. Each writes to shared state (dwarf stats,
grid food values) and reads from it next tick. This is the RimWorld pattern.

### What to carry forward to iOS

When porting to Swift, these prototyped systems should be rebuilt as proper Utility AI
scoring curves (§15 of this doc) rather than threshold modifications. The trait
modifiers become curve weights, the weather becomes a system that publishes modifiers
via Combine, and the storyteller becomes a proper event scheduler class. But the
*game design* validated here — which traits matter, how relations gate behavior,
what weather multipliers feel right — transfers directly.

---

## 19. Reference Links

### Existing codebase
- Web prototype: this repository (`src/` directory)
- Architecture docs: `CLAUDE.md` (comprehensive, keep as reference during port)
- Research notes: `docs/RESEARCH.md`

### Apple frameworks
- [SpriteKit documentation](https://developer.apple.com/documentation/spritekit/)
- [GameplayKit documentation](https://developer.apple.com/documentation/gameplaykit)
- [GKNoise (procedural noise)](https://developer.apple.com/documentation/gameplaykit/gknoise)
- [GKGridGraph (A\* pathfinding)](https://developer.apple.com/documentation/gameplaykit/gkgridgraph)
- [GKAgent / Goals / Behaviors](https://developer.apple.com/library/archive/documentation/General/Conceptual/GameplayKit_Guide/Agent.html)
- [Apple Foundation Models](https://developer.apple.com/documentation/foundationmodels/)

### Game design references
- [How RimWorld fleshes out the Dwarf Fortress formula](https://www.gamedeveloper.com/design/how-i-rimworld-i-fleshes-out-the-i-dwarf-fortress-i-formula)
- [Deep Emergent Play: RimWorld case study](https://steemit.com/gaming/@loreshapergames/deep-emergent-play-a-case-study)
- [PIANO cognitive architecture (Project Sid)](https://arxiv.org/abs/2411.00114)
- [Sugarscape model](https://jasss.soc.surrey.ac.uk/12/1/6/appendixB/EpsteinAxtell1996.html)
- [Red Blob Games — Terrain from Noise](https://www.redblobgames.com/maps/terrain-from-noise/)

### Libraries & tools
- [Kenney 1-bit Pack (CC0 art)](https://kenney.nl/assets/1-bit-pack)
- [FastNoiseLite (C bridging option)](https://github.com/Auburn/FastNoiseLite)
- [OctopusKit (SpriteKit ECS)](https://github.com/InvadingOctopus/octopuskit)
- [GPGOAP (C GOAP library)](https://github.com/stolk/GPGOAP)
