# Bug Trace: Cooking Deprioritized When Kitchen Built Before Storage Room

**Status:** Trace completed and verified. No fixes implemented.

---

## Summary

When a kitchen is placed via `placeRoom()` in `WorldScene.ts` **without a storage room already existing**, goblins never attempt to cook. This is caused by a combination of empty stockpile arrays and multiple interdependent eligibility gates.

---

## Verified Root Causes

### 1. Kitchen Gets No Auto-Stockpile

**File:** `src/game/scenes/WorldScene.ts:185–192`

```typescript
if (this.buildMode === 'lumber_hut') {
  const wx = x + 1, wy = y + 1;
  this.woodStockpiles.push({ x: wx, y: wy, wood: 0, maxWood: 200 });
  this.addWoodStockpileGraphics(this.woodStockpiles[this.woodStockpiles.length - 1]);
} else if (this.buildMode === 'blacksmith') {
  const ox = x + 1, oy = y + 1;
  this.oreStockpiles.push({ x: ox, y: oy, ore: 0, maxOre: 200 });
  this.addOreStockpileGraphics(this.oreStockpiles[this.oreStockpiles.length - 1]);
}
// kitchen: no else clause — no auto-stockpile created
```

**Contrast:** `lumber_hut` auto-creates a `WoodStockpile`, `blacksmith` auto-creates an `OreStockpile`. **Kitchen has no counterpart.**

**State after kitchen placement:**
- `rooms` = `[{ type: 'kitchen', x, y, w, h }]`
- `foodStockpiles` = `[]` (empty)
- `woodStockpiles` = `[]` (empty)
- `mealStockpiles` = `[]` (empty)

---

### 2. Cooking Action Ineligible

**File:** `src/simulation/actions/cooking.ts:39–73`

```typescript
eligible: ({ rooms, foodStockpiles, woodStockpiles, goblin, grid, mealStockpiles }) => {
    if (!rooms || rooms.length === 0) return false;

    // Must have a kitchen
    const hasKitchen = rooms.some(r => r.type === 'kitchen');
    if (!hasKitchen) return false;

    // Don't cook if meals are full
    const totalMeals = mealStockpiles?.reduce((s, m) => s + m.meals, 0) ?? 0;
    if (totalMeals >= MAX_MEALS_STORED) return false;

    // Must have resources OR be already cooking
    const hasFood = foodStockpiles?.some(s => s.food >= FOOD_COST);  // FAILS: empty array
    const hasWood = woodStockpiles?.some(s => s.wood >= WOOD_COST);  // FAILS: empty array

    // We also require at least one Hearth tile in or adjacent to the kitchen
    let kitchenHasHearth = false;
    for (const r of rooms) {
        if (r.type !== 'kitchen') continue;
        // ... scan for Hearth tile ...
    }

    if (!kitchenHasHearth) return false;  // FAILS: no hearth exists yet

    return (hasFood && hasWood) || (goblin.cookingProgress !== undefined && goblin.cookingProgress > 0);
    // Result: false (both conditions fail)
},
```

**With empty stockpile arrays:**
- Line 51: `hasFood = undefined.some(...) → false`
- Line 52: `hasWood = undefined.some(...) → false`
- Line 71: `kitchenHasHearth = false` (no goblin has built a hearth yet)
- Final return (line 73): `(false && false) || false → false`

**Cooking is ineligible.**

---

### 3. Cooking Score is Zero

**File:** `src/simulation/actions/cooking.ts:76–96`

```typescript
score: ({ goblin, foodStockpiles, mealStockpiles }) => {
    // If already cooking, strong momentum to finish
    if (goblin.cookingProgress !== undefined && goblin.cookingProgress > 0) {
        return 0.95;
    }

    // Score based on raw food surplus and lack of meals
    const totalFood = foodStockpiles?.reduce((s, p) => s + p.food, 0) ?? 0;  // = 0
    const totalMeals = mealStockpiles?.reduce((s, p) => s + p.meals, 0) ?? 0;

    if (totalFood < 10) return 0;  // EARLY EXIT: score is 0

    // ... rest of scoring never executes ...
    return Math.min(1.0, base);
},
```

**With empty `foodStockpiles`:**
- `totalFood = 0`
- Line 86: `if (totalFood < 10) return 0;` → **score exits early with 0**

**Cooking score is 0 — even if eligible, goblins never attempt it.**

---

### 4. DepositFood Ineligible — Food Trapped in Inventory

**File:** `src/simulation/actions/foraging.ts:177–179`

```typescript
eligible: ({ goblin, foodStockpiles }) => {
    if (goblin.inventory.food <= 0) return false;
    return nearestFoodStockpile(goblin, foodStockpiles, s => s.food < s.maxFood) !== null;
    // With empty foodStockpiles array, nearestFoodStockpile returns null → false
},
```

**Consequence:** Goblins forage food and fill their inventory, but cannot deposit it into a stockpile (because none exist). Food accumulates in goblin inventories but never reaches `foodStockpiles`, so:
- `cooking.eligible()` line 51 remains `false` (empty array)
- `cooking.score()` line 86 remains `0` (totalFood = 0)

**Food cannot enter the system; cooking cannot recover on its own.**

---

### 5. BuildHearth Also Blocked

**File:** `src/simulation/actions/building.ts:168–174`

```typescript
eligible: ({ goblin, woodStockpiles, foodStockpiles, grid, currentTick, rooms }) => {
    const totalFood = foodStockpiles?.reduce((s, f) => s + f.food, 0) ?? 0;  // = 0
    if (totalFood < 20) return false;  // BLOCKED: no food in stockpiles

    const stockpileWood = woodStockpiles?.reduce((s, w) => s + w.wood, 0) ?? 0;  // = 0
    const totalWood = stockpileWood + goblin.inventory.wood;
    if (totalWood < 2) return false;  // BLOCKED: no wood in stockpiles

    // ... rest of eligibility ...
    return true;
},
```

**With empty stockpiles:**
- `totalFood = 0 < 20` → ineligible
- `totalWood ≥ 2` check also fails if no goblin has logged wood (wood doesn't auto-spawn)

**Secondary gate:** Kitchen has no hearth → `cooking.eligible()` line 71 blocks cooking anyway.

---

## State Persistence Analysis

**Recovery path (when storage room is built later):**

1. User places a storage room via `placeRoom()`
2. `establishStockpile` action runs (eligibility at stockpiling.ts:78–89)
3. `mostNeededStockpileType()` determines storage needs
4. A new `FoodStockpile` is pushed into `ctx.foodStockpiles` (the same live array passed to all actions)
   - stockpiling.ts:133: `foodStockpiles.push({ x: pos.x, y: pos.y, food: 0, meals: 0, maxFood: 200 } as FoodStockpile);`
5. `depositFood` becomes eligible (foraging.ts:179 — `nearestFoodStockpile` now finds a pile)
6. Goblins deposit foraged food → `totalFood` rises
7. Once `totalFood >= 20`, `buildHearth` becomes eligible
8. Once hearth is built and `totalFood >= 10`, `cooking.eligible()` and `cooking.score()` both pass

**No persistent "poisoned" state.** Arrays are passed by reference; recovery is purely mechanical.

---

## Critical Files

| File | Lines | Issue |
|------|-------|-------|
| `src/game/scenes/WorldScene.ts` | 185–192 | Kitchen has no auto-stockpile creation |
| `src/simulation/actions/cooking.ts` | 51, 73 | Ineligibility gates on empty arrays |
| `src/simulation/actions/cooking.ts` | 86 | Score returns 0 when `totalFood < 10` |
| `src/simulation/actions/foraging.ts` | 179 | DepositFood blocked when no food stockpiles |
| `src/simulation/actions/building.ts` | 169 | BuildHearth blocked when `totalFood < 20` |
| `src/simulation/actions/stockpiling.ts` | 56 | `roomCanAddStockpileOfType` only accepts `room.type === 'storage'` |

---

## Hypothesis Confirmation

✅ **Primary:** Kitchen built without storage room → empty `foodStockpiles` array → `cooking.eligible()` and `cooking.score()` both fail.

✅ **Compounding:** `depositFood` is ineligible, so foraged food never enters stockpiles → food cannot self-resolve.

✅ **Secondary:** `buildHearth` also blocked by `totalFood >= 20` threshold → kitchen never gets a hearth anyway, adding a second blocking gate.

✅ **Recovery:** Placing a storage room later creates a `FoodStockpile`, triggering a recovery cascade. No poisoned state.

---

## Observations

1. **Design asymmetry:** `lumber_hut` and `blacksmith` auto-create stockpiles; `kitchen` does not. This is the root cause.
2. **No explicit linking:** Kitchen is never given a `FoodStockpile` or `WoodStockpile` at creation time. It relies entirely on global arrays being non-empty.
3. **Multi-gate blocking:** Three separate systems block cooking (ineligibility, score, hearth), making the bug resilient even if one gate is patched.
4. **Array-based coupling:** All actions depend on live array contents (`foodStockpiles`, `woodStockpiles`, `mealStockpiles`). Empty arrays = cascading failures.

---

## No Code Changes Made

This is a trace-only investigation. The bug is well-understood and thoroughly documented. Any fix would require architectural decisions about:
- Should kitchen auto-create food/wood stockpiles (matching `lumber_hut` / `blacksmith`)?
- Should `buildHearth` threshold be relaxed for new kitchens (waive the `totalFood >= 20` requirement)?
- Should `depositFood` be reworked to auto-create a `FoodStockpile` if none exist?

Each approach has trade-offs. No changes are recommended without explicit user guidance.
