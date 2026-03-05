import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import { getTraitDisplay, getRoleDisplay } from '../../simulation/agents';
import type { GameState, Goblin, GoblinRole, GoblinTrait } from '../../shared/types';

function topRelation(
  goblin: Goblin,
  all:    Goblin[],
  mode:   'ally' | 'rival',
): { name: string; score: number } | null {
  const others = all.filter(d => d.id !== goblin.id);
  if (others.length === 0) return null;
  const sorted = others
    .map(d => ({ name: d.name, score: goblin.relations[d.id] ?? 50 }))
    .sort((a, b) => mode === 'ally' ? b.score - a.score : a.score - b.score);
  const top = sorted[0];
  if (mode === 'ally'  && top.score <= 55) return null;
  if (mode === 'rival' && top.score >= 45) return null;
  return top;
}

function roleColor(role: GoblinRole): string {
  return role === 'forager'    ? '#56d973'
       : role === 'miner'      ? '#ff8800'
       : role === 'fighter'    ? '#e74c3c'
       : role === 'lumberjack' ? '#8bc34a'
       : '#7ec8e3';
}

const TRAIT_COLORS: Record<GoblinTrait, string> = {
  lazy:      '#888',
  forgetful: '#9988cc',
  helpful:   '#56d973',
  mean:      '#e74c3c',
  paranoid:  '#e67e22',
  brave:     '#3498db',
  greedy:    '#f0c040',
  cheerful:  '#ff9fd8',
};
function traitColor(trait: GoblinTrait): string {
  return TRAIT_COLORS[trait] ?? '#aaa';
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

function GoblinPanelInner({ goblin, allGoblins }: { goblin: Goblin; allGoblins: Goblin[] }) {
  const ally  = topRelation(goblin, allGoblins, 'ally');
  const rival = topRelation(goblin, allGoblins, 'rival');

  return (
    <div style={{ ...styles.panel, ...(!goblin.alive ? styles.panelDead : {}) }}>
      <div style={styles.panelName}>{goblin.name}</div>
      {goblin.alive
        ? <div style={{ color: roleColor(goblin.role), fontSize: 10, marginBottom: 4 }}>[{getRoleDisplay()[goblin.role]}]</div>
        : <div style={{ color: '#e74c3c', fontSize: 10, marginBottom: 4 }}>
            [DECEASED{goblin.causeOfDeath ? ` — ${goblin.causeOfDeath}` : ''}]
          </div>
      }
      <div style={{ fontSize: 9, color: '#a08060', fontStyle: 'italic', marginBottom: 4 }}>
        {goblin.bio}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <span style={{ color: traitColor(goblin.trait), fontSize: 9, fontWeight: 'bold' }}>
          {getTraitDisplay()[goblin.trait]}
        </span>
        <span style={{ color: '#5a8fa8', fontSize: 9 }}>⚑ {goblin.goal}</span>
      </div>
      <Bar label="health" value={goblin.health}  max={goblin.maxHealth} color="#e74c3c" />
      <Bar label="hunger" value={goblin.hunger}  max={100}             color="#e67e22" />
      <Bar label="morale" value={goblin.morale}  max={100}             color="#3498db" />
      <Bar label="fatigue" value={goblin.fatigue} max={100}            color="#9b59b6" />
      <Bar label="social" value={goblin.social}  max={100}             color="#f39c12" />
      <Bar label="warmth" value={goblin.warmth ?? 0} max={100}         color="#ff7733" />
      <div style={{ ...styles.panelRow, display: 'flex', gap: 10 }}>
        <span>🍄 {goblin.inventory.food.toFixed(1)}</span>
        {goblin.inventory.ore > 0 && (
          <span style={{ color: '#ff8800' }}>⛏ {goblin.inventory.ore.toFixed(1)}</span>
        )}
        {goblin.inventory.wood > 0 && (
          <span style={{ color: '#8bc34a' }}>🪵 {goblin.inventory.wood.toFixed(1)}</span>
        )}
        {goblin.adventurerKills > 0 && (
          <span style={{ color: '#e74c3c' }}>⚔ {goblin.adventurerKills} kill{goblin.adventurerKills !== 1 ? 's' : ''}</span>
        )}
        {(goblin.skillLevel ?? 0) > 0 && (
          <span style={{ color: '#ffd700' }}>⭐ Lv.{goblin.skillLevel} {goblin.role}</span>
        )}
      </div>
      {goblin.wound && (
        <div style={{ ...styles.panelRow, color: '#ff6b6b', fontSize: 10 }}>
          🩹 {goblin.wound.type} wound
        </div>
      )}
      <div style={styles.task}>{goblin.task}</div>
      {(ally || rival) && (
        <div style={styles.relSection}>
          {ally  && <div style={styles.relAlly}>♥ {ally.name} ({ally.score})</div>}
          {rival && <div style={styles.relRival}>⚔ {rival.name} ({100 - rival.score})</div>}
        </div>
      )}
      {goblin.memory.length > 0 && (
        <div style={styles.memorySection}>
          <div style={styles.memoryHeader}>HISTORY</div>
          {[...goblin.memory].reverse().map((m, i) => (
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

export function SelectedGoblinPanel() {
  const [state, setState] = useState<GameState | null>(null);

  useEffect(() => {
    bus.on('gameState', setState);
    return () => bus.off('gameState', setState);
  }, []);

  if (!state?.selectedGoblinId) return null;
  const selected = state.goblins.find(d => d.id === state.selectedGoblinId);
  if (!selected) return null;

  return <GoblinPanelInner goblin={selected} allGoblins={state.goblins} />;
}

const styles: Record<string, React.CSSProperties> = {
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
    borderLeft: '2px solid #e74c3c',
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
    color: '#e74c3c',
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
};
