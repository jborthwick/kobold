
## Features
[x] Change first goal to: build 3 storage rooms and a kitchen
[x] Update colony HUD to also track meals stored (along with food, wood, and ore)
[x] Add meals in inventory to goblin HUD
[x] Add oscillation logging to headless to catch goblins stuck in a loop between 2 or 3 squares for extended periods
[ ] Remove goblin roles, and allow roles to be naturally defined by colony needs at first, and eventually influenced with what skills they're best at via the experience systsem
[ ] Instead of building generic storage rooms and having goblins designate them, turn storage rooms in specialized rooms. 
- [ ] Generalize storage rooms. Any kind of stockpile can go in here at all times.
- [ ] New room: Lumber Hut
- - [ ] Comes with 1 saw tool. Saws convert wood into planks over a brief time.
- - [ ] Comes with 1 wood stockpile in a corner.
- - [ ] Up to 3 wood stockpiles can be built in the lumber hut
- [ ] New room: Blacksmith
- - [ ] Comes with 1 anvil tool. Anvils convert ore into bars over a brief time.
- - [ ] Comes with 1 ore stockpile in a corner.
- - [ ] Up to 3 wood stockpiles can be built in the lumber hut.

- [ ] Update headless to mockup new room placement and remove multiple storage rooms at gen


## Bugs:
[X] bug: Adventurers explore range seems too limited
[X] bug: Constant glow GFX around danger (e.g. adventurer) is hidden by tree tiles. The glow effect should be at the top of all the tile layers.
[X] bug: Saw goblins sit in the kitchen (on top of the meals stockpile) for hundreds of ticks with the label "mining.. looking for vein". But really just waiting for hunger to tick up and then eating a meal from the stockpile.
[X] bug: running headless shows 50% of time is spent "mining ... lookking for vein". way more than any other action


## Oscillation Investigation (Iteration 30+)
Detailed analysis and fixes for goblin action selection loops. See git log for commits:
- 90ecec7: committed movement targets (moveToward) for forage/mine/chop/buildWall
- abc2df4: improved oscillation log with competing task detection
- 939fbd7: centralized momentum system

### What We Fixed
1. **Pathfinding oscillations (3000+ → 150-600 ticks)**
   - Root: Actions re-scan for targets every tick → goblin reverses direction as best tile shifts
   - Fix: `moveToward()` helper commits goblin to destination for 15-20 ticks (pattern from existing `wanderTarget`)
   - Applied to: forage, mine, chop, buildWall, cooking, seekSafety, firefighting
   - Also: Grace window for `cookingProgress` (only reset after 40 ticks idle, not single-tick interruption)

2. **Action momentum (centralized)**
   - Was: Per-action string-matching in score() function (9 files, hard-coded 0.15)
   - Is: Central `MOMENTUM_BONUS` (0.25) in `tickAgentUtility`, keyed by `action.name`
   - Applied to: All eligible actions uniformly (previously 5 had zero momentum)

### What's Still Needed
Remaining oscillations are **400-1000 ticks**, **not pathfinding bugs**. They're legitimate multi-way spatial conflicts:

#### Root causes (priority order):

1. **Multi-goblin spatial contention** — goblins converge on same tiles/rooms
   - Symptom: "traveling to kitchen ↔ cooking" (800+ ticks) — goblins queuing up, blocking each other
   - Fix options:
     - [ ] Work queues: only 1-2 goblins cooking at once; others wait outside or do something else
     - [ ] Congestion heuristics: bias movement away from high-traffic tiles (use `trafficScore` diffusion field)
     - [ ] Kitchen redesign: multiple cooking stations, not just one center tile

2. **Room building starvation** — goblins stuck in "traveling to room ↔ built room wall!" (600-1000 ticks)
   - Symptom: All goblins converge on room perimeter; competing for same wall slots
   - Root: `buildWall` picks nearest slot without coordinating; multiple goblins commit to same unreachable slot
   - Fix options:
     - [ ] Slot reservation: mark committed slots so other goblins don't double-book
     - [ ] Early slot invalidation: detect when committed slot is built by another goblin, re-scan immediately
     - [ ] Role-based assignment: only miners/scouts build walls (not forage/cook)
     - [ ] Room work queue: serialize wall-building (one goblin per room at a time)

3. **Warmth-seeking + work conflicts** — "looking for warmth ↔ foraging ↔ harvesting" (400-600 ticks)
   - Symptom: Goblins toggle between warmth-seeking and work actions near room edges
   - Root: Warmth sigmoid peaks suddenly at `warmth=25` boundary; goblins oscillate crossing it
   - Fix options:
     - [ ] Hysteresis gates on warmth (entry <20, exit >30) like `seekWarmth` already has
     - [ ] Raise `seekWarmth` threshold so it doesn't compete with work as aggressively
     - [ ] Better warmth diffusion: smoother gradient instead of cliff

4. **Hunger/eating conflicts** — "eating ↔ mining" (200-400 ticks)
   - Symptom: Goblins eat briefly, then hunger rises fast, alternating with work
   - Root: Sigmoid(hunger, 50) for eat peaks near 50; work actions score below that
   - Fix: Raise eat sigmoid midpoint (was 50, try 60) so work actions win more consistently during moderate hunger

### Metrics
**Before any fixes:** 3700+ tick oscillations across all goblins
**After moveToward:** 400-650 tick oscillations (pathfinding fixed, action conflicts remain)
**After centralized momentum:** Still 400-1000 ticks (momentum helped slightly, but spatial conflicts dominate)

### Code anchors for future work
- `src/simulation/diffusion.ts`: `trafficScore` field already tracks goblin foot-traffic; can bias movement away
- `src/simulation/actions/building.ts`: `buildWall` score/execute at lines 20-72; needs slot reservation logic
- `src/simulation/actions/exploration.ts`: `seekWarmth` hysteresis gates at lines 50-60; model for other actions
- `src/simulation/utilityAI.ts`: `MOMENTUM_BONUS` tune point at line 349; action scoring loop at 355-374



