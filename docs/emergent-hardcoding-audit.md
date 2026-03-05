# Hardcoded vs Emergent Systems Audit

Audit of values and behaviors that are explicitly programmed but would be better handled
emergently through the utility AI / trait system. Checked = fixed.

**107 findings across 9 categories.**

### Agent suitability key
- 🟢 **haiku** — single-file mechanical substitution, no new interfaces or cross-file coordination
- 🟡 **sonnet** — requires new `traitMod` keys in `agents.ts`, multi-file changes, or architectural decisions

---

## CRITICAL: Priority Overrides Bypassing Utility Scoring

- [x] **`utilityAI.ts:228–271` — Stockpile instant-action early-returns**
  Goblins standing on a stockpile with enough inventory `return` immediately, completely
  bypassing all action scoring. Give `depositFood`/`withdrawFood`/`depositOre`/`depositWood` a
  high on-stockpile score multiplier (×2.5) and let them win naturally instead.

- [x] 🟡 **`actions.ts:140` — `commandMove` scores 1.0 unconditionally**
  Player commands always win regardless of crisis state. During active raid or extreme
  starvation, score should drop to 0.8 so a flee/eat can override.

- [ ] 🟡 **`actions.ts:149–153` — Adventurer proximity target override**
  Adventurers always switch to goblin on same tile regardless of current target. Should be
  a weighted comparison: only switch if new target priority outweighs current target
  proximity.

---

## HIGH: Role Gates Block Emergent Behavior

Six actions use hard `if (goblin.role !== 'X') return false` gates instead of trait-based
scoring. A brave miner should be able to fight; a desperate scout should be able to mine.
The fix is to assign high default trait values per role and score continuously.

- [x] 🟡 **`actions.ts:280–284` — `fight` only for fighters**
  Replace `if (goblin.role !== 'fighter') return false` with a `ROLE_COMBAT_APT` per-role
  multiplier (fighter=1.0, scout=0.25, others=0.15). Score × aptitude.

- [x] 🟡 **`actions.ts:505–506` — `mine` only for miners**
  Replace role gate with `ROLE_MINING_APT` per-role multiplier (miner=1.0, others=0.10–0.15).

- [x] 🟡 **`actions.ts:574–575` — `chop` only for lumberjacks**
  Replace role gate with `ROLE_CHOP_APT` per-role multiplier (lumberjack=1.0, others=0.10–0.15).
  Chop base yield: `5 + roleBonus(15 for LJ) + traitMod(chopPower, 0) + skill`.

- [x] **`actions.ts:332` — Miner/lumberjack forage gate when hunger < 50**
  `if (role === 'miner' || role === 'lumberjack') && hunger < 50) return false`
  Remove; let sigmoid scoring naturally suppress at low hunger. Miners just have a higher
  `forageHungerThreshold` trait value.

- [x] 🟡 **`actions.ts:643` — Ore deposit role gate**
  `if (goblin.role !== 'miner' || ...)` — removed; any goblin carrying materials can deposit.

- [x] 🟡 **`actions.ts:660` — Wood deposit role gate**
  `if (goblin.role !== 'lumberjack' || ...)` — removed; same.

---

## HIGH: Threshold Gates Should Be Sigmoid Scores

~24 binary `if (x > threshold) do Y` patterns that block rather than modulate.

### `utilityAI.ts`

- [x] 🟢 **Line 83–87** — `if (hunger > 60): morale -= 0.4` → `sigmoid(hunger, 60) * -0.5`
- [x] 🟢 **Line 89–94** — `if (morale < 25): hunger += metabolism × 0.3` → continuous
  `metabolismMod = sigmoid(100 - morale, 60)`
- [x] 🟢 **Line 72** — Warmth penalty: `if (warmth < 25)` → `inverseSigmoid(warmth, 25)`
- [x] 🟢 **Line 102–104** — `if (wound === 'bruised'): fatigue += 0.3` → parameterize
  per wound type in a `woundPenalties` map
- [x] 🟢 **Line 105–107** — `if (fatigue > 90): morale -= 0.2` → sigmoid decay
- [x] 🟢 **Line 129–131** — Loneliness: `if (tick - lastSocialTick > 30)` → time-decay
  `social += (tick - lastSocialTick) / 200`
- [x] 🟢 **Line 133–138** — `if (social > 60): morale -= 0.15` → `sigmoid(social, 60) * -0.3`

### `actions.ts`

- [x] **Line 161** — `eat` eligible gate `hunger > 20` → remove; sigmoid scores ~0 at 20
- [x] **Line 183** — `rest` eligible gate `fatigue > 20` → remove; sigmoid handles it
- [x] 🟢 **Line 337** — Forage radius expansion: `if (hunger > 65): radius *= 2` →
  `radiusMod = 1 + sigmoid(hunger, 60) * 0.8`, continuous expansion
- [x] 🟢 **Line 408** — Harvest fatigue penalty: `if (fatigue > 70): yield *= 0.5` →
  `fatigueScale = inverseSigmoid(fatigue, 70, 0.1)`, smooth
- [x] **Line 472** — `depositFood` eligibility gate `inventory >= 10 && hunger < 55` →
  removed; score handles it; on-stockpile 2.5× multiplier added to score
- [x] **Line 678** — `buildWall` hungry gate `if (hunger >= 65) return false` → removed;
  `inverseSigmoid(hunger, 50)` in score already suppresses it
- [x] **Line 1024** — `buildHearth` hungry gate `if (hunger >= 70) return false` → removed
- [x] **Line 1030** — `buildHearth` warmth gate `if (warmth >= 35) return false` → removed;
  `inverseSigmoid(warmth, 25)` in score handles it

### `crisis.ts`

- [x] 🟡 **Line 55** — `HUNGER_CRISIS_THRESHOLD = 65` → `traitMod(goblin, 'hungerCrisisThreshold', 65)`
  _(lazy: 58, paranoid: 55)_
- [x] 🟡 **Line 56** — `MORALE_CRISIS_THRESHOLD = 40` → `traitMod(goblin, 'moraleCrisisThreshold', 40)`
  _(brave: 30, paranoid: 50)_
- [x] 🟡 **Line 58–59** — `LOW_SUPPLIES_FOOD = 2`, `LOW_SUPPLIES_HUNGER = 40` →
  `lowSuppliesHunger = traitMod(hungerCrisisThreshold, 65) - 25` — paranoid panics at 30, default at 40.
- [x] 🟡 **Line 61** — `EXHAUSTION_THRESHOLD = 80` → `traitMod(goblin, 'exhaustionThreshold', 80)`
  _(lazy: 65)_
- [x] 🟡 **Line 62** — `LONELINESS_THRESHOLD = 70` → `traitMod(goblin, 'lonelinessCrisisThreshold', 70)`
  _(helpful: 55, mean: 85)_
- [x] 🟡 **Line 107** — `if (role === 'fighter' || trait === 'brave')` raid gate →
  `ROLE_COMBAT_APT[role] >= 0.5` — only fighters (+ brave) get LLM raid call

---

## MEDIUM: Hardcoded Spatial Constants

- [x] 🟡 **`utilityAI.ts:117–124`** — `FRIEND_RADIUS = 3`, `FRIEND_REL = 40` hardcoded →
  `FRIEND_RADIUS = traitMod(generosityRange, 2) + 1` — helpful/cheerful: 4 tiles, mean: 2 tiles
- [x] 🟡 **`actions.ts:224`** — Share radius `<= 2` hardcoded →
  `traitMod(goblin, 'generosityRange', 2)` (helpful: 3, mean/greedy: 1)
- [x] 🟡 **`actions.ts:287`** — Hunt radius `vision * 2` multiplier →
  `vision * traitMod(goblin, 'huntRange', 2.0)` (brave: 2.5×)
- [x] 🟡 **`actions.ts:349`** — LLM-intent forage radius `= 15` hardcoded →
  `traitMod(goblin, 'maxSearchRadius', 15)`
- [x] 🟡 **`actions.ts:766`** — Avoid rival radius `<= 5` hardcoded →
  `3 + traitMod(goblin, 'wariness', 2)` (paranoid: 3+4=7, default: 3+2=5)
- [x] 🟡 **`crisis.ts:57`** — `CONTEST_RADIUS = 2` (scouts get 4 via role check) →
  `CONTEST_RADIUS + (role === 'scout' ? 2 : 0) + traitMod(goblin, 'perceptiveness', 0)`
  _(paranoid gets +2 perceptiveness; scouts keep role bonus until role gates are removed)_
- [x] 🟡 **`crisis.ts:60`** — `ADVENTURER_RAID_AWARENESS = 8` hardcoded →
  `raidRadius = 8 + traitMod(wariness, 2) - 2` — paranoid sees raids at 10 tiles
- [x] 🟡 **`actions.ts:800–802`** — `WANDER_HOLD_TICKS = 25`, `WANDER_MIN_DIST = 10`,
  `WANDER_MAX_DIST = 20` → `wariness`-driven: paranoid wanders 10–24, default 10–20
- [x] 🟡 **`actions.ts:953`** — Warmth satisfaction distance `<= 2` →
  `traitMod(goblin, 'coziness', 2)` (default 2)
- [x] 🟢 **`actions.ts:912`** — Seek warmth max score: `cold ? 0.28 : 0.08` hardcoded →
  move into weather system config

---

## MEDIUM: Faction / Role Stat Hardcoding

- [x] 🟡 **`agents.ts:128–134`** — Fighter is the only role with 130 HP →
  `healthBonus` applied at spawn: `maxHealth = ROLE_STATS[role].maxHealth + traitMod(healthBonus, 0)`.
  brave: +20 HP, paranoid: -10 HP. Fighter base stays 130.

- [x] 🟡 **`agents.ts:85–94` (`TRAIT_MODS`)** — Extended with:
  `brave: { healthBonus: 20, huntRange: 2.5 }`,
  `paranoid: { wariness: 4, healthBonus: -10 }`,
  `helpful/cheerful: { generosityRange: 3 }`,
  `greedy/mean: { generosityRange: 1 }`

- [x] 🟡 **`actions.ts:405–406`** — Forager harvest: `depletionRate = role === 'forager' ? 6 : 5`
  and `baseYield = role === 'forager' ? 2 : 1` → role provides base bonus, trait augments:
  `gatherBonus = roleBonus + traitMod(goblin, 'gatheringPower', 0)`

- [x] 🟡 **`actions.ts:605`** — Wood chop base yield `= 20` hardcoded →
  `5 + roleBonus(15 for LJ) + traitMod(chopPower, 0) + skill` — non-LJs get 5 base

---

## MEDIUM: Event Magic Numbers (should be named config)

- [x] 🟢 **`events.ts:16–17`** — `EVENT_MIN_INTERVAL = 300`, `EVENT_MAX_INTERVAL = 600`
- [x] 🟢 **`events.ts:74`** — Blight radius `6`, severity `× 0.5`
- [x] 🟢 **`events.ts:95`** — Bounty radius `5`, multiplier `× 1.5`, cap `20`
- [x] 🟢 **`events.ts:115`** — Mushroom isolation radius `4`
- [x] 🟢 **`events.ts:125–131`** — Mushroom spread: radius 3–5, fill 60%, max 14 tiles
- [x] 🟢 **`events.ts:154`** — Ore discovery: radius `3`, max `5` tiles, value `15`
- [x] 🟢 **`events.ts:178`** — Mushroom sprout interval `60` ticks
- [x] 🟢 **`events.ts:199–203`** — Sprout: radius `2`, fill `0.7`, max `8`
- [x] 🟢 **`events.ts:227–237`** — Tension weights: `threatMod = threats × 15`,
  `recentDead × 20` → named `TENSION_WEIGHTS` config object
- [x] 🟢 **`events.ts:241–250`** — Event probabilities by tension bracket hardcoded inline →
  `TENSION_EVENT_DISTRIBUTION` lookup table

---

## MEDIUM: Special-Case Logic Breaking Symmetry

- [x] 🟡 **`utilityAI.ts:209`** — Starvation: `if (hunger >= 100 && inv === 0): health -= 2`
  → `sigmoid(hunger, 95) * 0.003 * maxHealth/tick`; ramps in from 90 hunger (not binary at 100).

- [ ] 🟡 **`actions.ts:368–398`** — Forage contest: only yields to hungrier goblins
  (`d.hunger > goblin.hunger`). Should be a priority score combining hunger, skill, and
  relationship so status/respect can tip the outcome.

- [x] 🟢 **`actions.ts:242`** — Share yield hardcoded `× 0.7` max score multiplier.

---

## MEDIUM: Adventurer Magic Numbers

- [x] 🟢 **`adventurers.ts:19–20`** — `RAID_INTERVAL_MIN = 500`, `RAID_INTERVAL_MAX = 900`
- [x] 🟢 **`adventurers.ts:21`** — `WANDER_RANGE = 15`
- [x] 🟢 **`adventurers.ts:59`** — Raid group size `2 + rand(3)` → `RAID_MIN/MAX_SIZE`
- [x] 🟢 **`adventurers.ts:104–106`** — Damage values: adventurer `5`, goblin `8`,
  fighter `18` — parameterize, scale by difficulty
- [x] 🟢 **`adventurers.ts:136`** — Stagger ticks `= 12` → `STAGGER_TICKS` constant
- [x] 🟢 **`adventurers.ts:164`** — Movement skip `% 4` (75% speed) → `ADVENTURER_SPEED_RATIO`

---

## LOW: World Generation Constants

- [ ] 🟡 **`world.ts:18–41` (`WORLD_CONFIG`)** — All resource min/max/growback values are
  fixed. No poor vs rich vein variation; no seasonal growback modulation.
  Consider: `growbackMod = 1 + 0.3 * sin(tick / 5000)` for seasonal cycling; events
  can permanently alter a region's `maxFood`, not just current value.

- [x] 🟢 **`world.ts:248–253`** — Noise parameters (`ELEV_FREQ = 0.04`, etc.) are magic
  numbers with no documentation. Consolidate into a named `NOISE_PARAMS` object with
  JSDoc explaining each parameter's effect on biome distribution.

---

## Summary

| Category | Count | Severity |
|----------|-------|----------|
| Priority overrides bypassing scoring | 3 | CRITICAL |
| Role gates blocking emergent behavior | 6 | HIGH |
| Threshold gates that should be sigmoids | 24 | HIGH |
| Hardcoded spatial constants | 10 | MEDIUM |
| Faction/role stat hardcoding | 6 | MEDIUM |
| Event magic numbers | 10 | MEDIUM |
| Special-case symmetry breaks | 3 | MEDIUM |
| Adventurer magic numbers | 6 | MEDIUM |
| World generation constants | 2 | LOW |
| **Total** | **70** | |
