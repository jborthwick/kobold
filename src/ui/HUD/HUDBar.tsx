import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import { getActiveFaction } from '../../shared/factions';
import { getStorytellerPersona, setStorytellerPersona, STORYTELLER_PERSONAS } from '../../ai/storyteller';

type LLMProvider = 'anthropic' | 'groq';
import type { GameState, OverlayMode, WeatherType, Season, RoomType } from '../../shared/types';
import type { LayoutMode } from '../../shared/useViewport';
import { BuildMenu } from './BuildMenu';

const OVERLAY_LABEL: Record<OverlayMode, string> = {
  off: '[O] overlay',
  food: '[O] food ▓',
  material: '[O] stone ▓',
  wood: '[O] wood ▓',
  warmth: '[O] warmth ▓',
  danger: '[O] danger ▓',
  traffic: '[O] traffic ▓',
};
const OVERLAY_COLOR: Record<OverlayMode, string> = {
  off: '#555',
  food: '#00dd44',
  material: '#ff8800',
  wood: '#56d973',
  warmth: '#ff6600',
  danger: '#ff2222',
  traffic: '#ffee00',
};

const WEATHER_ICONS: Record<WeatherType, string> = { clear: '☀', rain: '🌧', drought: '🏜', cold: '❄', storm: '⛈' };
const WEATHER_COLORS: Record<WeatherType, string> = { clear: '#f0c040', rain: '#5b9bd5', drought: '#d4a437', cold: '#9ecae1', storm: '#7b9fc0' };
const SEASON_LABELS: Record<Season, string> = { spring: 'Spr', summer: 'Sum', autumn: 'Aut', winter: 'Win' };

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

export function HUD({ layout = 'desktop' as LayoutMode }: { layout?: LayoutMode }) {
  const [state, setState] = useState<GameState | null>(null);
  const [llmEnabled, setLlmEnabled] = useState(true);
  const [provider, setProvider] = useState<LLMProvider>('groq');
  const [personaId, setPersonaId] = useState(() => getStorytellerPersona().id);
  const [confirmNew, setConfirmNew] = useState(false);
  const [activeBuildType, setActiveBuildType] = useState<RoomType | null>(null);

  useEffect(() => {
    bus.on('gameState', setState);
    return () => bus.off('gameState', setState);
  }, []);

  useEffect(() => {
    const handleBuildMode = (ev: { roomType: RoomType } | null) => {
      setActiveBuildType(ev?.roomType ?? null);
    };
    bus.on('buildMode', handleBuildMode);
    return () => bus.off('buildMode', handleBuildMode);
  }, []);


  const toggleLLM = () => {
    const next = !llmEnabled;
    setLlmEnabled(next);
    bus.emit('settingsChange', { llmEnabled: next });
  };

  const cycleProvider = () => {
    const next: LLMProvider = provider === 'anthropic' ? 'groq' : 'anthropic';
    setProvider(next);
    bus.emit('settingsChange', { llmProvider: next });
  };

  const cyclePersona = () => {
    const idx = STORYTELLER_PERSONAS.findIndex(p => p.id === personaId);
    const next = STORYTELLER_PERSONAS[(idx + 1) % STORYTELLER_PERSONAS.length];
    setPersonaId(next.id);
    setStorytellerPersona(next.id);
  };


  if (!state) return null;

  const alive = state.goblins.filter(d => d.alive);
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
      <Stat label={isPhone ? 'g' : getActiveFaction().unitNounPlural} value={`${alive.length}/${state.goblins.length}`} />
      <Stat label={isPhone ? 'f' : 'food'} value={state.totalFood.toFixed(isPhone ? 0 : 1)} />
      <Stat label={isPhone ? 'm' : 'meals'} value={(state.totalMeals ?? 0).toFixed(isPhone ? 0 : 1)} />
      <Stat label={isPhone ? 'o' : 'ore'} value={state.totalOre.toFixed(isPhone ? 0 : 1)} />
      <Stat label={isPhone ? 'w' : 'wood'} value={state.totalWood.toFixed(isPhone ? 0 : 1)} />
      {!isPhone && <Stat label="tick" value={String(state.tick)} />}
      {state.weatherSeason && state.weatherType && (
        <WeatherIndicator season={state.weatherSeason} weather={state.weatherType} />
      )}
      {/* Desktop: inline pause/speed/overlay controls */}
      {isDesktop && <PauseSpeed paused={state.paused} speed={state.speed} />}
      {isDesktop && <OverlayIndicator mode={state.overlayMode} />}

      {/* Build Menu (Permanent) */}
      <BuildMenu activeType={activeBuildType} />

      {/* LLM toggle: desktop only (LLM disabled on mobile) */}
      {isDesktop && (
        <button
          onClick={toggleLLM}
          style={{ ...styles.llmToggle, ...(llmEnabled ? styles.llmToggleOn : styles.llmToggleOff) }}
        >
          {llmEnabled ? '🤖 LLM' : '💤 LLM'}
        </button>
      )}
      {/* Provider toggle: only visible when LLM is enabled */}
      {isDesktop && llmEnabled && (
        <button
          onClick={cycleProvider}
          style={{ ...styles.llmToggle, ...styles.providerToggle }}
          title="LLM provider"
        >
          {provider === 'anthropic' ? '⚡ Claude' : '⚡ Groq'}
        </button>
      )}
      {/* Storyteller persona: only visible when LLM is enabled */}
      {isDesktop && llmEnabled && (
        <button
          onClick={cyclePersona}
          style={{ ...styles.llmToggle, ...styles.personaToggle }}
          title="Narrator style: Balanced or Chaotic"
        >
          📜 {STORYTELLER_PERSONAS.find(p => p.id === personaId)?.name ?? 'Storyteller'}
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

const styles: Record<string, React.CSSProperties> = {
  topBar: {
    position: 'absolute',
    top: 12,
    left: 12,
    display: 'flex',
    gap: 16,
    background: 'rgba(0,0,0,0.65)',
    padding: '6px 14px',
    borderRadius: 8,
    fontFamily: 'monospace',
    fontSize: 13,
    color: '#fff',
    userSelect: 'none',
    pointerEvents: 'none',
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
  },
  statLabel: {
    fontSize: 9,
    color: '#aaa',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  statValue: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  llmToggle: {
    pointerEvents: 'auto' as const,
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: 'bold',
    border: 'none',
    borderRadius: 4,
    padding: '3px 8px',
    cursor: 'pointer',
    letterSpacing: '0.03em',
    alignSelf: 'center',
    transition: 'background 0.15s',
  },
  llmToggleOn: {
    background: 'rgba(0,200,80,0.25)',
    color: '#4efa8a',
  },
  llmToggleOff: {
    background: 'rgba(120,120,120,0.2)',
    color: '#777',
  },
  providerToggle: {
    background: 'rgba(100,140,220,0.2)',
    color: '#7ec8e3',
  },
  personaToggle: {
    background: 'rgba(180,140,100,0.2)',
    color: '#d4c4a0',
  },
  pauseSpeedGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    pointerEvents: 'auto' as const,
  },
  speedLabel: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: 'bold',
    color: '#fff',
    minWidth: 24,
    textAlign: 'center' as const,
  },
  ctrlBtn: {
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: 'bold',
    border: 'none',
    borderRadius: 4,
    width: 22,
    height: 22,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  } as React.CSSProperties,
  ctrlBtnNeutral: {
    background: 'rgba(120,120,120,0.25)',
    color: '#aaa',
  },
  ctrlBtnPlay: {
    background: 'rgba(0,200,80,0.2)',
    color: '#4efa8a',
  },
  ctrlBtnPaused: {
    background: 'rgba(220,60,60,0.25)',
    color: '#e74c3c',
  },
  newColonyConfirm: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    pointerEvents: 'auto' as const,
  },
  newColonyBtn: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: 'bold' as const,
    border: 'none',
    borderRadius: 4,
    padding: '2px 7px',
    cursor: 'pointer',
  },
  newColonyBtnYes: {
    background: 'rgba(200,50,50,0.3)',
    color: '#e74c3c',
  },
  newColonyBtnNo: {
    background: 'rgba(120,120,120,0.2)',
    color: '#aaa',
  },
};
