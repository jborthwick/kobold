# Smithing Overpreference Analysis

**Note:** Scarcity is now centralized in `computeResourceBalanceModifier()` (tier pressures: consumables > materials > upgrades). Smith/saw use `upgradesPressure`; cook/forage/withdraw use `consumablesPressure`. This doc remains as historical context.

## Problem
Goblins spend **33% of their ticks smithing** while other actions (cooking, sawing) get ~6%. They cluster around the blacksmith and ignore other production.

---

## Root Causes (in order of impact)

### 1. **Cooking has TWO ineligibility gates; Smithing has ONE**

**Cooking eligibility** (cooking.ts:39-73):
- Must have kitchen ✓
- Must have food (5+ units) AND wood (1+ unit)  ← **TWO resources**
- Must have a hearth in/adjacent to kitchen
- Total meals < 50

**Smithing eligibility** (smithing.ts:39-45):
- Must have blacksmith ✓
- Must have ore (3+ units)  ← **ONE resource**
- Total bars < 80

**Impact:** Cooking is ineligible as soon as ANY resource runs low (food=4 or wood=0). Smithing stays eligible as long as ore exists.

---

### 2. **Cooking score threshold is 2x higher than Smithing**

**Scoring thresholds:**

| Action | Threshold | Required |
|--------|-----------|----------|
| Cooking | `totalFood < 10` → score = 0 | 10+ food to score anything |
| Smithing | `totalOre < 5` → score = 0 | 5+ ore to score anything |
| Sawing | `totalWood < 5` → score = 0 | 5+ wood to score anything |

**Impact:** When ore=6 and food=8, smithing scores but cooking scores 0. Cooking can't recover until food reaches 10.

---

### 3. **Smithing stays "hungry" longer (scarcity sigmoid at bar=30 vs meals=20)**

**Scoring formulas (simplified):**

```javascript
// Cooking
const mealScarcity = inverseSigmoid(totalMeals, 20);  // midpoint=20
const base = foodAbundance * mealScarcity * 0.5 * hungerMod;

// Smithing
const barScarcity = inverseSigmoid(totalBars, 30);    // midpoint=30
const base = oreAbundance * barScarcity * 0.45 * hungerMod;

// Sawing
const plankScarcity = inverseSigmoid(totalPlanks, 30); // midpoint=30
const base = woodAbundance * plankScarcity * 0.45 * hungerMod;
```

**Impact:**
- Cooking satisfies at meals=20 (sigmoid drops to ~0.5 at midpoint)
- Smithing keeps demanding until bars≈50-60 (sigmoid falls slower due to 30 midpoint)
- Result: Smithing generates 1.5-2x more demand than cooking for equivalent resource levels

---

### 4. **Resource demands are unbalanced**

| Action | Input | Output | Cost | Ticks |
|--------|-------|--------|------|-------|
| Cooking | 5 food + 1 wood | 5 meals | Low | 50 |
| Smithing | 3 ore | 5 bars | Very low | 50 |
| Sawing | 3 wood | 5 planks | Low | 45 |

**Problem:** Ore is generated passively from mining, easily stockpiles, and smithing barely consumes it (only 3 per batch). Food is foraged and split among goblins for eating + cooking. Wood is both needed for cooking AND sawing.

---

## Why Goblins Cluster When Blacksmith Exists

The momentum bonus (0.25) locks goblins into smithing:

1. First goblin starts smithing (it's the only viable action → score=0.5)
2. Momentum: next tick, smithing = 0.5 + 0.25 = **0.75**
3. All other actions (cooking=0.18, sawing=0.15) lose
4. Goblin finishes batch and repeats; momentum persists
5. Other goblins see traveling to blacksmith is viable → all flock there
6. With multiple goblins smithing, bars stay below 30 → `barScarcity` stays high

**Result:** Smithing becomes a stable equilibrium that's hard to break.

---

## Recommended Fixes (by severity)

### Fix 1: Drop cooking food threshold to match smithing
**cooking.ts:86** — change from:
```javascript
if (totalFood < 10) return 0;
```
to:
```javascript
if (totalFood < 5) return 0;
```
**Impact:** Cooking becomes scorable earlier, reducing the gap.

### Fix 2: Lower smithing bar demand midpoint
**smithing.ts:54** — change from:
```javascript
const barScarcity = inverseSigmoid(totalBars, 30);
```
to:
```javascript
const barScarcity = inverseSigmoid(totalBars, 20);  // match cooking's meal midpoint
```
**Impact:** Smithing satisfies sooner, stops consuming ore aggressively.

### Fix 3: Adjust multipliers to reflect production cost
**cooking.ts:92** vs **smithing.ts:55** — consider raising cooking's multiplier or lowering smithing's:
```javascript
// Option A: raise cooking
const base = foodAbundance * mealScarcity * 0.6 * hungerMod;  // 0.5 → 0.6

// Option B: lower smithing
return Math.min(1.0, oreAbundance * barScarcity * 0.35 * hungerMod);  // 0.45 → 0.35
```
**Impact:** Makes cooking/sawing competitive urgency-wise.

### Fix 4: Reduce smithing's ore harvest or increase per-batch cost
Currently mining generates ore freely; smithing barely taps it. Consider:
- Increase `ORE_COST` from 3 → 5
- Reduce ore spawn frequency
- Lower `BARS_PER_BATCH` from 5 → 3

**Impact:** Smithing becomes resource-constrained, freeing up ore for other uses if needed.

---

## Verification with Headless

To confirm fixes:
```bash
# Run a baseline to see current ratio
npx tsx scripts/headless.ts 3000 42

# Apply fix 1, re-run same seed
npx tsx scripts/headless.ts 3000 42

# Compare action frequencies — cooking should rise, smithing should fall
```

Expected outcome after fixes: **cooking 15-20%, smithing 12-15%, others balanced**.
