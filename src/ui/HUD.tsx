import { useEffect, useState } from 'react';
import { bus } from '../shared/events';
import type { GameState, Dwarf, OverlayMode, DwarfRole, DwarfTrait, TileInfo, ColonyGoal, FoodStockpile, OreStockpile, WoodStockpile, Goblin, Season, WeatherType } from '../shared/types';
import type { LayoutMode } from '../shared/useViewport';

/** Find the dwarf with the highest/lowest relation score relative to `dwarf`. */
function topRelation(
  dwarf:   Dwarf,
  all:     Dwarf[],
  mode:    'ally' | 'rival',
): { name: string; score: number } | null {
  const others = all.filter(d => d.id !== dwarf.id);
  if (others.length === 0) return null;
  const sorted = others
    .map(d => ({ name: d.name, score: dwarf.relations[d.id] ?? 50 }))
    .sort((a, b) => mode === 'ally' ? b.score - a.score : a.score - b.score);
  const top = sorted[0];
  if (mode === 'ally'  && top.score <= 55) return null;
  if (mode === 'rival' && top.score >= 45) return null;
  return top;
}

export function HUD({ layout = 'desktop' as LayoutMode }: { layout?: LayoutMode }) {
  const [state,      setState]      = useState<GameState | null>(null);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);

  useEffect(() => {
    bus.on('gameState', setState);
    return () => bus.off('gameState', setState);
  }, []);

  const toggleLLM = () => {
    const next = !llmEnabled;
    setLlmEnabled(next);
    bus.emit('settingsChange', { llmEnabled: next });
  };

  if (!state) return null;

  const alive = state.dwarves.filter(d => d.alive);
  const isPhone = layout === 'phone';
  const isDesktop = layout === 'desktop';

  const topBarStyle: React.CSSProperties = {
    ...styles.topBar,
    ...(isPhone ? {
      top: 'calc(4px + var(--sat, 0px))',
      left: 4,
      right: 4,
      gap: 8,
      padding: '4px 8px',
      fontSize: 11,
    } : {}),
  };

  return (
    <div style={topBarStyle}>
      <Stat label={isPhone ? 'd' : 'dwarves'} value={`${alive.length}/${state.dwarves.length}`} />
      <Stat label={isPhone ? 'f' : 'food'}    value={state.totalFood.toFixed(isPhone ? 0 : 1)} />
      <Stat label={isPhone ? 'm' : 'mats'}    value={state.totalMaterials.toFixed(isPhone ? 0 : 1)} />
      {!isPhone && <Stat label="tick" value={String(state.tick)} />}
      {state.weatherSeason && state.weatherType && (
        <WeatherIndicator season={state.weatherSeason} weather={state.weatherType} />
      )}
      {/* Desktop: inline pause/speed/overlay controls */}
      {isDesktop && <PauseSpeed paused={state.paused} speed={state.speed} />}
      {isDesktop && <OverlayIndicator mode={state.overlayMode} />}
      {/* LLM toggle: desktop only (LLM disabled on mobile) */}
      {isDesktop && (
        <button
          onClick={toggleLLM}
          style={{ ...styles.llmToggle, ...(llmEnabled ? styles.llmToggleOn : styles.llmToggleOff) }}
        >
          {llmEnabled ? '🤖 LLM' : '💤 LLM'}
        </button>
      )}
      {/* New colony: desktop only */}
      {isDesktop && (confirmNew ? (
        <div style={styles.newColonyConfirm}>
          <span style={{ color: '#f0c040', marginRight: 6 }}>abandon colony?</span>
          <button
            onClick={() => { setConfirmNew(false); bus.emit('controlChange', { action: 'newColony' }); }}
            style={{ ...styles.newColonyBtn, ...styles.newColonyBtnYes }}
          >yes</button>
          <button
            onClick={() => setConfirmNew(false)}
            style={{ ...styles.newColonyBtn, ...styles.newColonyBtnNo }}
          >no</button>
        </div>
      ) : (
        <button
          onClick={() => setConfirmNew(true)}
          style={{ ...styles.llmToggle, ...styles.llmToggleOff, color: '#c0392b' }}
        >
          ⚑ new colony
        </button>
      ))}
    </div>
  );
}

/** Standalone panel that sits at the bottom of the right sidebar. */
export function SelectedDwarfPanel() {
  const [state, setState] = useState<GameState | null>(null);

  useEffect(() => {
    bus.on('gameState', setState);
    return () => bus.off('gameState', setState);
  }, []);

  if (!state?.selectedDwarfId) return null;
  const selected = state.dwarves.find(d => d.id === state.selectedDwarfId);
  if (!selected) return null;

  return <DwarfPanel dwarf={selected} allDwarves={state.dwarves} />;
}

/** Debug panel showing live LLM token usage for the current session. */
export function TokenDebugPanel() {
  const [usage, setUsage] = useState<{
    inputTotal: number; outputTotal: number; callCount: number;
    lastInput: number; lastOutput: number;
  } | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    bus.on('tokenUsage', setUsage);
    return () => bus.off('tokenUsage', setUsage);
  }, []);

  if (!usage) return null;

  // Rough cost estimate: haiku input ~$0.80/M, output ~$4/M
  const costEstimate = (usage.inputTotal * 0.0000008 + usage.outputTotal * 0.000004).toFixed(4);
  const avgIn  = usage.callCount > 0 ? Math.round(usage.inputTotal  / usage.callCount) : 0;
  const avgOut = usage.callCount > 0 ? Math.round(usage.outputTotal / usage.callCount) : 0;

  return (
    <div style={styles.tokenPanel}>
      <div style={styles.tokenHeader}>
        <span>🔢 TOKEN USAGE</span>
        <button onClick={() => setVisible(v => !v)} style={styles.tokenToggle}>
          {visible ? '▲' : '▼'}
        </button>
      </div>
      {visible && (
        <>
          <div style={styles.tokenRow}>
            <span style={styles.tokenLabel}>calls</span>
            <span style={styles.tokenValue}>{usage.callCount}</span>
          </div>
          <div style={styles.tokenRow}>
            <span style={styles.tokenLabel}>input total</span>
            <span style={styles.tokenValue}>{usage.inputTotal.toLocaleString()}</span>
          </div>
          <div style={styles.tokenRow}>
            <span style={styles.tokenLabel}>output total</span>
            <span style={styles.tokenValue}>{usage.outputTotal.toLocaleString()}</span>
          </div>
          <div style={styles.tokenRow}>
            <span style={styles.tokenLabel}>avg in/out</span>
            <span style={styles.tokenValue}>{avgIn} / {avgOut}</span>
          </div>
          <div style={styles.tokenRow}>
            <span style={styles.tokenLabel}>last call</span>
            <span style={styles.tokenValue}>{usage.lastInput}↑ {usage.lastOutput}↓</span>
          </div>
          <div style={{ ...styles.tokenRow, marginTop: 4, borderTop: '1px solid #333', paddingTop: 4 }}>
            <span style={styles.tokenLabel}>~cost (USD)</span>
            <span style={{ ...styles.tokenValue, color: '#f0c040' }}>${costEstimate}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function TileTooltip() {
  const [info, setInfo] = useState<TileInfo | null>(null);

  useEffect(() => {
    bus.on('tileHover', setInfo);
    return () => bus.off('tileHover', setInfo);
  }, []);

  if (!info) return null;

  const foodPct = info.maxFood > 0
    ? ` food ${info.foodValue.toFixed(1)}/${info.maxFood}`
    : '';
  const matPct  = info.maxMaterial > 0
    ? ` ore ${info.materialValue.toFixed(1)}/${info.maxMaterial}`
    : '';

  return (
    <div style={styles.tileTooltip}>
      <span style={{ color: '#f0c040', fontWeight: 'bold' }}>{info.type}</span>
      <span style={{ color: '#888' }}> ({info.x},{info.y})</span>
      {foodPct && <span style={{ color: '#56d973' }}>{foodPct}</span>}
      {matPct  && <span style={{ color: '#ff8800' }}>{matPct}</span>}
    </div>
  );
}

/** Panel shown when the player clicks a food, ore, or wood stockpile. */
export function StockpilePanel() {
  const [sel,   setSel]   = useState<{ kind: 'food' | 'ore' | 'wood'; idx: number } | null>(null);
  const [state, setState] = useState<GameState | null>(null);

  useEffect(() => {
    bus.on('stockpileSelect', setSel);
    bus.on('gameState',       setState);
    return () => {
      bus.off('stockpileSelect', setSel);
      bus.off('gameState',       setState);
    };
  }, []);

  if (!sel || !state) return null;

  const stockpile: FoodStockpile | OreStockpile | WoodStockpile | undefined =
    sel.kind === 'food' ? state.foodStockpiles[sel.idx]
  : sel.kind === 'ore'  ? state.oreStockpiles[sel.idx]
  :                       state.woodStockpiles[sel.idx];

  if (!stockpile) return null;

  const isFoodSp = sel.kind === 'food';
  const isOreSp  = sel.kind === 'ore';
  const amount   = isFoodSp ? (stockpile as FoodStockpile).food
                 : isOreSp  ? (stockpile as OreStockpile).ore
                 :             (stockpile as WoodStockpile).wood;
  const max      = isFoodSp ? (stockpile as FoodStockpile).maxFood
                 : isOreSp  ? (stockpile as OreStockpile).maxOre
                 :             (stockpile as WoodStockpile).maxWood;
  const pct      = max > 0 ? Math.min(1, amount / max) : 0;
  const color    = isFoodSp ? '#f0c040' : isOreSp ? '#ff8800' : '#8bc34a';
  const icon     = isFoodSp ? '🏠' : isOreSp ? '⛏' : '🪵';
  const label    = isFoodSp ? 'Food Stockpile' : isOreSp ? 'Ore Stockpile' : 'Wood Stockpile';
  const resource = isFoodSp ? 'food' : isOreSp ? 'ore' : 'wood';

  // Count dwarves carrying items of this type
  const carriers = isFoodSp
    ? state.dwarves.filter(d => d.alive && d.inventory.food > 0).length
    : state.dwarves.filter(d => d.alive && d.inventory.materials > 0).length;

  return (
    <div style={{ ...styles.panel, borderLeft: `2px solid ${color}` }}>
      <div style={{ ...styles.panelName, color }}>{icon} {label}</div>
      <div style={{ fontSize: 9, color: '#888', marginBottom: 6 }}>({stockpile.x}, {stockpile.y})</div>
      <div style={{ marginBottom: 6 }}>
        <div style={styles.barLabel}>{resource} stored</div>
        <div style={styles.barTrack}>
          <div style={{ ...styles.barFill, width: `${pct * 100}%`, background: color }} />
        </div>
        <div style={{ fontSize: 9, color: '#999', marginTop: 2 }}>{amount.toFixed(0)} / {max}</div>
      </div>
      <div style={{ fontSize: 9, color: '#888' }}>
        dwarves carrying {resource}: <span style={{ color }}>{carriers}</span>
      </div>
    </div>
  );
}

/** Panel shown when the player clicks a goblin. */
export function GoblinPanel() {
  const [goblin, setGoblin] = useState<Goblin | null>(null);

  useEffect(() => {
    bus.on('goblinSelect', setGoblin);
    return () => bus.off('goblinSelect', setGoblin);
  }, []);

  if (!goblin) return null;

  const hpPct = goblin.maxHealth > 0 ? Math.min(1, goblin.health / goblin.maxHealth) : 0;
  return (
    <div style={{ ...styles.panel, borderLeft: '2px solid #e74c3c' }}>
      <div style={{ ...styles.panelName, color: '#e74c3c' }}>⚔ Goblin</div>
      <div style={{ fontSize: 9, color: '#888', marginBottom: 6 }}>
        pos ({goblin.x}, {goblin.y}){goblin.targetId ? ' · pursuing' : ' · wandering'}
      </div>
      <Bar label="health" value={goblin.health} max={goblin.maxHealth} color="#e74c3c" />
      <div style={{ fontSize: 9, color: '#999', marginTop: 3 }}>
        {goblin.health.toFixed(0)} / {goblin.maxHealth} hp
        {hpPct < 0.5 && <span style={{ color: '#e67e22', marginLeft: 6 }}>⚠ wounded</span>}
      </div>
      <div style={{ fontSize: 9, color: '#666', marginTop: 4, fontStyle: 'italic' }}>
        snapshot at time of click
      </div>
    </div>
  );
}

/** Colony-wide goal + food/ore/wood stockpile panel. */
export function ColonyGoalPanel() {
  const [goal,           setGoal]           = useState<ColonyGoal | null>(null);
  const [foodStockpiles, setFoodStockpiles] = useState<FoodStockpile[]>([]);
  const [oreStockpiles,  setOreStockpiles]  = useState<OreStockpile[]>([]);
  const [woodStockpiles, setWoodStockpiles] = useState<WoodStockpile[]>([]);

  useEffect(() => {
    const onState = (s: GameState) => {
      if (s.colonyGoal)      setGoal({ ...s.colonyGoal });
      if (s.foodStockpiles)  setFoodStockpiles(s.foodStockpiles.map(d => ({ ...d })));
      if (s.oreStockpiles)   setOreStockpiles(s.oreStockpiles.map(sp => ({ ...sp })));
      if (s.woodStockpiles)  setWoodStockpiles(s.woodStockpiles.map(sp => ({ ...sp })));
    };
    bus.on('gameState', onState);
    return () => bus.off('gameState', onState);
  }, []);

  if (!goal || foodStockpiles.length === 0 || oreStockpiles.length === 0) return null;

  const pct              = Math.min(1, goal.progress / goal.target);
  const totalFood        = foodStockpiles.reduce((s, d) => s + d.food, 0);
  const maxFood          = foodStockpiles.reduce((s, d) => s + d.maxFood, 0);
  const totalOre         = oreStockpiles.reduce((s, sp) => s + sp.ore, 0);
  const maxOre           = oreStockpiles.reduce((s, sp) => s + sp.maxOre, 0);
  const totalWood        = woodStockpiles.reduce((s, sp) => s + sp.wood, 0);
  const maxWood          = woodStockpiles.reduce((s, sp) => s + sp.maxWood, 0);
  const foodStockpilePct = maxFood > 0 ? Math.min(1, totalFood / maxFood) : 0;
  const oreStockpilePct  = maxOre  > 0 ? Math.min(1, totalOre  / maxOre)  : 0;
  const woodStockpilePct = maxWood > 0 ? Math.min(1, totalWood / maxWood)  : 0;
  const foodLabel        = foodStockpiles.length > 1 ? `×${foodStockpiles.length}` : '';
  const oreLabel         = oreStockpiles.length  > 1 ? `×${oreStockpiles.length}`  : '';
  const woodLabel        = woodStockpiles.length > 1 ? `×${woodStockpiles.length}` : '';

  return (
    <div style={styles.goalPanel}>
      <div style={styles.goalTitle}>COLONY GOAL · gen {goal.generation + 1}</div>
      <div style={styles.goalDesc}>{goal.description}</div>
      <div style={styles.barTrack}>
        <div style={{
          ...styles.barFill,
          width:      `${pct * 100}%`,
          background: pct >= 1 ? '#56d973' : '#f0c040',
        }} />
      </div>
      <div style={styles.goalProgress}>
        {goal.progress.toFixed(0)} / {goal.target}
        {pct >= 1 && <span style={{ color: '#56d973', marginLeft: 6 }}>✓ COMPLETE</span>}
      </div>
      {/* Food stockpile row */}
      <div style={styles.goalDepot}>
        <span style={{ color: '#f0c040' }}>🏠</span>
        <div style={{ ...styles.barTrack, flex: 1, margin: '0 4px' }}>
          <div style={{ ...styles.barFill, width: `${foodStockpilePct * 100}%`, background: '#f0c040' }} />
        </div>
        <span style={{ color: '#f0c040' }}>{totalFood.toFixed(0)}/{maxFood}{foodLabel}</span>
      </div>
      {/* Ore stockpile row */}
      <div style={styles.goalDepot}>
        <span style={{ color: '#ff8800' }}>⛏</span>
        <div style={{ ...styles.barTrack, flex: 1, margin: '0 4px' }}>
          <div style={{ ...styles.barFill, width: `${oreStockpilePct * 100}%`, background: '#ff8800' }} />
        </div>
        <span style={{ color: '#ff8800' }}>{totalOre.toFixed(0)}/{maxOre}{oreLabel}</span>
      </div>
      {/* Wood stockpile row */}
      {woodStockpiles.length > 0 && (
        <div style={styles.goalDepot}>
          <span style={{ color: '#8bc34a' }}>🪵</span>
          <div style={{ ...styles.barTrack, flex: 1, margin: '0 4px' }}>
            <div style={{ ...styles.barFill, width: `${woodStockpilePct * 100}%`, background: '#8bc34a' }} />
          </div>
          <span style={{ color: '#8bc34a' }}>{totalWood.toFixed(0)}/{maxWood}{woodLabel}</span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statValue}>{value}</span>
    </div>
  );
}

function PauseSpeed({ paused, speed }: { paused: boolean; speed: number }) {
  const emit = (action: 'pause' | 'speedUp' | 'speedDown') =>
    bus.emit('controlChange', { action });

  return (
    <div style={styles.pauseSpeedGroup}>
      <button
        onClick={() => emit('pause')}
        style={{ ...styles.ctrlBtn, ...(paused ? styles.ctrlBtnPaused : styles.ctrlBtnPlay) }}
        title="Pause / unpause (SPACE)"
      >{paused ? '⏸' : '▶'}</button>

      <button
        onClick={() => emit('speedDown')}
        style={{ ...styles.ctrlBtn, ...styles.ctrlBtnNeutral }}
        title="Slower (−)"
      >−</button>

      <span style={styles.speedLabel}>{speed}×</span>

      <button
        onClick={() => emit('speedUp')}
        style={{ ...styles.ctrlBtn, ...styles.ctrlBtnNeutral }}
        title="Faster (=)"
      >+</button>
    </div>
  );
}

const OVERLAY_LABEL: Record<OverlayMode, string> = {
  off:      '[O] overlay',
  food:     '[O] food ▓',
  material: '[O] stone ▓',
  wood:     '[O] wood ▓',
};
const OVERLAY_COLOR: Record<OverlayMode, string> = {
  off:      '#555',
  food:     '#00dd44',
  material: '#ff8800',
  wood:     '#56d973',
};

const WEATHER_ICONS: Record<WeatherType, string> = { clear: '☀', rain: '🌧', drought: '🏜', cold: '❄' };
const WEATHER_COLORS: Record<WeatherType, string> = { clear: '#f0c040', rain: '#5b9bd5', drought: '#d4a437', cold: '#9ecae1' };
const SEASON_LABELS: Record<Season, string> = { spring: 'Spr', summer: 'Sum', autumn: 'Aut', winter: 'Win' };

function WeatherIndicator({ season, weather }: { season: Season; weather: WeatherType }) {
  return (
    <div style={{ ...styles.stat, justifyContent: 'center' }}>
      <span style={{ fontSize: 10, color: WEATHER_COLORS[weather] }}>
        {SEASON_LABELS[season]} {WEATHER_ICONS[weather]}
      </span>
    </div>
  );
}

function OverlayIndicator({ mode }: { mode: OverlayMode }) {
  return (
    <div style={{ ...styles.stat, justifyContent: 'center' }}>
      <span style={{ ...styles.statLabel, color: OVERLAY_COLOR[mode], fontSize: 10 }}>
        {OVERLAY_LABEL[mode]}
      </span>
    </div>
  );
}

function roleColor(role: DwarfRole): string {
  return role === 'forager'    ? '#56d973'
       : role === 'miner'      ? '#ff8800'
       : role === 'fighter'    ? '#e74c3c'
       : role === 'lumberjack' ? '#8bc34a'  // olive green — wood
       : '#7ec8e3';  // scout
}

const TRAIT_COLORS: Record<DwarfTrait, string> = {
  lazy:      '#888',
  forgetful: '#9988cc',
  helpful:   '#56d973',
  mean:      '#e74c3c',
  paranoid:  '#e67e22',
  brave:     '#3498db',
  greedy:    '#f0c040',
  cheerful:  '#ff9fd8',
};
function traitColor(trait: DwarfTrait): string {
  return TRAIT_COLORS[trait] ?? '#aaa';
}

function DwarfPanel({ dwarf, allDwarves }: { dwarf: Dwarf; allDwarves: Dwarf[] }) {
  const ally  = topRelation(dwarf, allDwarves, 'ally');
  const rival = topRelation(dwarf, allDwarves, 'rival');

  return (
    <div style={{ ...styles.panel, ...(!dwarf.alive ? styles.panelDead : {}) }}>
      <div style={styles.panelName}>{dwarf.name}</div>
      {dwarf.alive
        ? <div style={{ color: roleColor(dwarf.role), fontSize: 10, marginBottom: 4 }}>[{dwarf.role.toUpperCase()}]</div>
        : <div style={{ color: '#e74c3c', fontSize: 10, marginBottom: 4 }}>
            [DECEASED{dwarf.causeOfDeath ? ` — ${dwarf.causeOfDeath}` : ''}]
          </div>
      }
      <div style={{ fontSize: 9, color: '#a08060', fontStyle: 'italic', marginBottom: 4 }}>
        {dwarf.bio}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <span style={{ color: traitColor(dwarf.trait), fontSize: 9, fontWeight: 'bold', textTransform: 'uppercase' }}>
          {dwarf.trait}
        </span>
        <span style={{ color: '#5a8fa8', fontSize: 9 }}>⚑ {dwarf.goal}</span>
      </div>
      <Bar label="health" value={dwarf.health}  max={dwarf.maxHealth} color="#e74c3c" />
      <Bar label="hunger" value={dwarf.hunger}  max={100}             color="#e67e22" />
      <Bar label="morale" value={dwarf.morale}  max={100}             color="#3498db" />
      <Bar label="fatigue" value={dwarf.fatigue} max={100}            color="#9b59b6" />
      <Bar label="social" value={dwarf.social}  max={100}             color="#f39c12" />
      <div style={{ ...styles.panelRow, display: 'flex', gap: 10 }}>
        <span>🍄 {dwarf.inventory.food.toFixed(1)}</span>
        {dwarf.role === 'lumberjack'
          ? <span style={{ color: '#8bc34a' }}>🪵 {dwarf.inventory.materials.toFixed(1)}</span>
          : <span style={{ color: '#ff8800' }}>⛏ {dwarf.inventory.materials.toFixed(1)}</span>
        }
        {dwarf.goblinKills > 0 && (
          <span style={{ color: '#e74c3c' }}>⚔ {dwarf.goblinKills} kill{dwarf.goblinKills !== 1 ? 's' : ''}</span>
        )}
        {(dwarf.skillLevel ?? 0) > 0 && (
          <span style={{ color: '#ffd700' }}>⭐ Lv.{dwarf.skillLevel} {dwarf.role}</span>
        )}
      </div>
      {dwarf.wound && (
        <div style={{ ...styles.panelRow, color: '#ff6b6b', fontSize: 10 }}>
          🩹 {dwarf.wound.type} wound
        </div>
      )}
      <div style={styles.task}>{dwarf.task}</div>
      {(ally || rival) && (
        <div style={styles.relSection}>
          {ally  && <div style={styles.relAlly}>♥ {ally.name} ({ally.score})</div>}
          {rival && <div style={styles.relRival}>⚔ {rival.name} ({100 - rival.score})</div>}
        </div>
      )}
      {dwarf.memory.length > 0 && (
        <div style={styles.memorySection}>
          <div style={styles.memoryHeader}>HISTORY</div>
          {[...dwarf.memory].reverse().map((m, i) => (
            <div key={i} style={styles.memoryEntry}>
              <div>
                <span style={styles.memoryTick}>[{m.tick}]</span>
                <span style={styles.memoryCrisis}>{m.crisis}</span>
                {m.outcome
                  ? <span style={styles.memoryBad}> ✗ {m.outcome}</span>
                  : <span style={styles.memoryAction}> {m.action}</span>
                }
              </div>
              {m.reasoning && (
                <div style={styles.memoryReasoning}>💭 "{m.reasoning}"</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Bar({
  label, value, max, color,
}: { label: string; value: number; max: number; color: string }) {
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={styles.barLabel}>{label}</div>
      <div style={styles.barTrack}>
        <div style={{ ...styles.barFill, width: `${(value / max) * 100}%`, background: color }} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  topBar: {
    position:   'absolute',
    top:        12,
    left:       12,
    display:    'flex',
    gap:        16,
    background: 'rgba(0,0,0,0.65)',
    padding:    '6px 14px',
    borderRadius: 8,
    fontFamily: 'monospace',
    fontSize:   13,
    color:      '#fff',
    userSelect: 'none',
    pointerEvents: 'none',
  },
  stat: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    gap:           2,
  },
  statLabel: {
    fontSize: 9,
    color:    '#aaa',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  statValue: {
    fontSize:   14,
    fontWeight: 'bold',
  },
  panel: {
    background: 'rgba(0,0,0,0.75)',
    padding:    '10px 14px',
    fontFamily: 'monospace',
    fontSize:   12,
    color:      '#ccc',
    overflowY:  'auto',
    scrollbarWidth: 'thin',
    scrollbarColor: '#444 transparent',
    userSelect: 'none',
    pointerEvents: 'auto',
    flexShrink: 0,
    maxHeight:  '50vh',
  } as React.CSSProperties,
  panelDead: {
    borderLeft:  '2px solid #e74c3c',
  },
  panelName: {
    fontSize:   15,
    fontWeight: 'bold',
    color:      '#f0c040',
    marginBottom: 8,
  },
  panelRow: {
    marginTop: 4,
  },
  task: {
    marginTop:  8,
    color:      '#7ec8e3',
    fontStyle:  'italic',
    fontSize:   11,
  },
  barLabel: {
    fontSize: 10,
    color:    '#999',
    marginBottom: 2,
  },
  barTrack: {
    background:   '#333',
    height:       7,
    borderRadius: 4,
    overflow:     'hidden',
  },
  barFill: {
    height:       '100%',
    borderRadius: 4,
    transition:   'width 0.15s ease',
  },
  llmToggle: {
    pointerEvents: 'auto' as const,
    fontFamily:    'monospace',
    fontSize:      10,
    fontWeight:    'bold',
    border:        'none',
    borderRadius:  4,
    padding:       '3px 8px',
    cursor:        'pointer',
    letterSpacing: '0.03em',
    alignSelf:     'center',
    transition:    'background 0.15s',
  },
  llmToggleOn: {
    background: 'rgba(0,200,80,0.25)',
    color:      '#4efa8a',
  },
  llmToggleOff: {
    background: 'rgba(120,120,120,0.2)',
    color:      '#777',
  },
  relSection: {
    marginTop:  6,
    paddingTop: 6,
    borderTop:  '1px solid #333',
    fontSize:   9,
  },
  relAlly: {
    color:      '#56d973',
    marginBottom: 2,
  },
  relRival: {
    color:      '#e74c3c',
  },
  memorySection: {
    marginTop:  8,
    borderTop:  '1px solid #333',
    paddingTop: 6,
  },
  memoryHeader: {
    fontSize:      8,
    color:         '#555',
    letterSpacing: '0.1em',
    marginBottom:  4,
  },
  memoryEntry: {
    fontSize:    9,
    lineHeight:  '1.5',
    color:       '#777',
    marginBottom: 4,
  },
  memoryReasoning: {
    marginTop:  2,
    paddingLeft: 8,
    color:      '#a08828',
    fontStyle:  'italic',
    fontSize:   9,
    lineHeight: 1.4,
    wordBreak:  'break-word' as const,
  },
  memoryTick: {
    color:       '#444',
    marginRight: 3,
  },
  memoryCrisis: {
    color:       '#88a',
    marginRight: 3,
    fontWeight:  'bold',
  },
  memoryAction: {
    color: '#666',
  },
  memoryBad: {
    color: '#e74c3c',
  },
  tileTooltip: {
    position:   'absolute',
    top:        48,
    left:       12,
    background: 'rgba(0,0,0,0.65)',
    padding:    '4px 10px',
    borderRadius: 6,
    fontFamily: 'monospace',
    fontSize:   11,
    color:      '#ccc',
    userSelect: 'none',
    pointerEvents: 'none',
    display:    'flex',
    gap:        8,
  },
  pauseSpeedGroup: {
    display:    'flex',
    alignItems: 'center',
    gap:        4,
    pointerEvents: 'auto' as const,
  },
  speedLabel: {
    fontFamily: 'monospace',
    fontSize:   12,
    fontWeight: 'bold',
    color:      '#fff',
    minWidth:   24,
    textAlign:  'center' as const,
  },
  ctrlBtn: {
    fontFamily:   'monospace',
    fontSize:     12,
    fontWeight:   'bold',
    border:       'none',
    borderRadius: 4,
    width:        22,
    height:       22,
    cursor:       'pointer',
    display:      'flex',
    alignItems:   'center',
    justifyContent: 'center',
    lineHeight:   1,
  } as React.CSSProperties,
  ctrlBtnNeutral: {
    background: 'rgba(120,120,120,0.25)',
    color:      '#aaa',
  },
  ctrlBtnPlay: {
    background: 'rgba(0,200,80,0.2)',
    color:      '#4efa8a',
  },
  ctrlBtnPaused: {
    background: 'rgba(220,60,60,0.25)',
    color:      '#e74c3c',
  },
  goalPanel: {
    background: 'rgba(0,0,0,0.75)',
    padding:    '8px 12px',
    fontFamily: 'monospace',
    fontSize:   11,
    color:      '#ccc',
    userSelect: 'none',
    pointerEvents: 'none',
    flexShrink: 0,
    borderBottom: '1px solid #333',
  } as React.CSSProperties,
  goalTitle: {
    fontSize:      8,
    color:         '#888',
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    marginBottom:  4,
  },
  goalDesc: {
    color:        '#f0c040',
    fontSize:     11,
    marginBottom: 5,
    fontWeight:   'bold',
  },
  goalProgress: {
    fontSize:  9,
    color:     '#999',
    marginTop: 3,
  },
  goalDepot: {
    display:    'flex',
    alignItems: 'center',
    marginTop:  6,
    fontSize:   9,
  },
  tokenPanel: {
    position:   'absolute',
    bottom:     16,
    left:       152,  // 12px minimap offset + 128px minimap width + 12px gap
    background: 'rgba(0,0,0,0.72)',
    borderRadius: 6,
    padding:    '6px 10px',
    fontFamily: 'monospace',
    fontSize:   10,
    color:      '#aaa',
    userSelect: 'none',
    pointerEvents: 'auto' as const,
    minWidth:   160,
  },
  tokenHeader: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    fontSize:       9,
    color:          '#555',
    letterSpacing:  '0.08em',
    marginBottom:   5,
  },
  tokenToggle: {
    background: 'none',
    border:     'none',
    color:      '#555',
    cursor:     'pointer',
    fontFamily: 'monospace',
    fontSize:   9,
    padding:    0,
    lineHeight: 1,
  },
  tokenRow: {
    display:        'flex',
    justifyContent: 'space-between',
    gap:            12,
    marginBottom:   2,
  },
  tokenLabel: {
    color:   '#555',
    fontSize: 9,
  },
  tokenValue: {
    color:      '#ccc',
    fontSize:   9,
    fontWeight: 'bold' as const,
    textAlign:  'right' as const,
  },
  newColonyConfirm: {
    display:    'flex',
    alignItems: 'center',
    gap:        4,
    pointerEvents: 'auto' as const,
  },
  newColonyBtn: {
    fontFamily:   'monospace',
    fontSize:     10,
    fontWeight:   'bold' as const,
    border:       'none',
    borderRadius: 4,
    padding:      '2px 7px',
    cursor:       'pointer',
  },
  newColonyBtnYes: {
    background: 'rgba(200,50,50,0.3)',
    color:      '#e74c3c',
  },
  newColonyBtnNo: {
    background: 'rgba(120,120,120,0.2)',
    color:      '#aaa',
  },
};
