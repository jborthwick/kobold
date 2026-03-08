
## Features
[x] Change first goal to: build 3 storage rooms and a kitchen
[x] Update colony HUD to also track meals stored (along with food, wood, and ore)
[x] Add meals in inventory to goblin HUD

---

## Plan: First three features

### 1. Change first goal to: build 3 storage rooms and a kitchen

**Goal:** New players’ first colony goal is “Build 3 storage rooms and a kitchen” instead of “Cook N meals”.

**Changes:**

| Where | What |
|-------|------|
| **`src/shared/types.ts`** | Add `'build_rooms'` to `ColonyGoalType`. |
| **`src/shared/factions.ts`** | Add `build_rooms: (t: number) => string` to `goalDescriptions` (e.g. `"Build 3 storage rooms and a kitchen"`; `t` can be ignored for this goal). |
| **`src/game/scenes/WorldGoals.ts`** | (a) In `makeGoal()`, handle `'build_rooms'`: e.g. `target: 1`, `description` from faction. (b) In `updateGoalProgress()`, set `progress = 1` when `rooms` has ≥3 storage rooms and ≥1 kitchen, else `0`. (c) In `completeGoal()`, add `'build_rooms'` to `GOAL_TYPES` and make it **first** in the cycle so the next goal after it is `cook_meals`. |
| **`src/game/scenes/WorldInit.ts`** | Set initial goal to `makeGoal('build_rooms', 0)` instead of `'cook_meals'`. |
| **Save/load** | No migration needed; `ColonyGoal` is persisted as-is. Old saves keep their current goal. |
| **Storyteller** | No change required; it uses `goal.description` and `goal.type` generically. |

**Progress logic:**  
Count storage rooms as `rooms.filter(r => r.type === 'storage').length` and kitchens as `rooms.filter(r => r.type === 'kitchen').length`. Complete when `storageCount >= 3 && kitchenCount >= 1`. Optionally show progress in UI as e.g. “2/3 storage, 0/1 kitchen” by extending the goal description or a small helper (not required for completion).

---

### 2. Update colony HUD to also track meals stored (along with food, wood, and ore)

**Goal:** Colony goal panel (and/or top bar) shows **meals stored** in colony stockpiles, in addition to food, wood, and ore.

**Current state:**  
- `ColonyGoalPanel.tsx` shows food, ore, and wood stockpile totals (with bar + total/max).  
- `GameState` and `emitGameState()` already include `mealStockpiles` and `totalMeals` (inventory + stockpiles).  
- Top bar in `HUDBar.tsx` already shows `state.totalMeals` (goblins + stockpiles).

**Changes:**

| Where | What |
|-------|------|
| **`src/ui/HUD/ColonyGoalPanel.tsx`** | Subscribe to `mealStockpiles` from game state (already on `GameState`). Compute `totalMeals` and `maxMeals` from `mealStockpiles` (same pattern as food/ore/wood). Add a **meals** row: icon + bar + `totalMeals/maxMeals` (and optional `×N` when multiple meal stockpiles). Use a distinct color (e.g. `#ffbb88` or similar) to match kitchen/meal theme. |

No backend or `WorldState` changes; data is already emitted.

---

### 3. Add meals in inventory to goblin HUD

**Goal:** When a goblin is selected, the goblin panel shows **meals** in inventory (same style as food, ore, wood).

**Current state:**  
- `GoblinPanel.tsx` shows `goblin.inventory.food` (🍄), and conditionally ore (⛏) and wood (🪵).  
- `Goblin.inventory` already has `meals` (used by eating, foraging withdraw, etc.).

**Changes:**

| Where | What |
|-------|------|
| **`src/ui/HUD/GoblinPanel.tsx`** | In the inventory row (same `<div>` as food/ore/wood), add a conditional: when `goblin.inventory.meals > 0`, render a span for meals, e.g. `🍽` or `🫕` and the number, with a consistent style (e.g. color `#ffbb88` or same as colony meals). Match existing pattern: `{goblin.inventory.meals > 0 && (<span style={{ color: '...' }}>🍽 {goblin.inventory.meals.toFixed(0)}</span>)}`. |

One small, localized UI change.

---

### Implementation order

1. **Feature 3** (goblin HUD meals) — single file, no dependencies.  
2. **Feature 2** (colony HUD meals) — single component, data already in `GameState`.  
3. **Feature 1** (first goal = build rooms) — touches types, faction config, goal lifecycle, and init; do last so any type/build issues are caught in one pass.



## Bugs:
[ ] bug: Adventurers explore range seems too limited
[ ] bug: Constant glow GFX around danger (e.g. adventurer) is hidden by tree tiles. The glow effect should be at the top of all the tile layers.
[ ] bug: Saw goblins sit in the kitchen (on top of the meals stockpile) for hundreds of ticks with the label "mining.. looking for vein". But really just waiting for hunger to tick up and then eating a meal from the stockpile. There isn't ore in view if that matters.



