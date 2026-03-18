import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import type { GameState } from '../../shared/types';
import { WORK_CATEGORIES, getCurrentHeadcounts, type WorkCategoryId } from '../../simulation/workerTargets';

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    flexShrink: 0,
    borderBottom: '1px solid #333',
  },
  collapseHeader: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 14px',
    fontFamily: 'monospace',
    fontSize: 10,
    color: '#888',
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    background: 'rgba(0,0,0,0.85)',
    border: 'none',
    borderBottom: '1px solid #2a2a2a',
    cursor: 'pointer',
    userSelect: 'none',
    pointerEvents: 'auto',
  },
  chevron: {
    fontSize: 9,
    color: '#666',
  },
  panel: {
    background: 'rgba(0,0,0,0.75)',
    padding: '10px 14px',
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#ccc',
    overflowY: 'auto',
    scrollbarWidth: 'thin',
    scrollbarColor: '#444 transparent',
    userSelect: 'none',
    pointerEvents: 'auto',
    flexShrink: 0,
    maxHeight: '40vh',
  } as React.CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
    fontSize: 11,
  },
  label: {
    flex: '1 1 auto',
    minWidth: 0,
  },
  current: {
    color: '#888',
    width: 24,
    textAlign: 'right' as const,
  },
  targetValue: {
    width: 28,
    textAlign: 'center' as const,
    fontFamily: 'monospace',
    fontSize: 11,
  },
  btn: {
    width: 24,
    height: 22,
    padding: 0,
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 1,
    background: '#333',
    border: '1px solid #555',
    borderRadius: 4,
    color: '#ccc',
    cursor: 'pointer',
  },
};

export function WorkTargetsPanel() {
  const [state, setState] = useState<GameState | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    bus.on('gameState', setState);
    return () => bus.off('gameState', setState);
  }, []);

  if (!state) return null;

  const workerTargets = state.workerTargets ?? {};
  const currentHeadcounts = getCurrentHeadcounts(state.goblins, state.tick);

  const setTarget = (category: WorkCategoryId, value: number) => {
    bus.emit('workerTargetChange', { category, value });
  };

  return (
    <div style={styles.wrapper}>
      <button
        type="button"
        style={styles.collapseHeader}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>Labour targets</span>
        <span style={styles.chevron}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={styles.panel}>
          {WORK_CATEGORIES.map(({ id, label }) => {
            const current = currentHeadcounts[id];
            const target = workerTargets[id] ?? 0;
            return (
              <div key={id} style={styles.row}>
                <span style={styles.label}>{label}</span>
                <span style={styles.current}>{current}</span>
                <button
                  type="button"
                  style={styles.btn}
                  onClick={(e) => { e.stopPropagation(); setTarget(id, Math.max(0, target - 1)); }}
                  aria-label={`Decrease ${label} target`}
                >
                  −
                </button>
                <span style={styles.targetValue}>{target}</span>
                <button
                  type="button"
                  style={styles.btn}
                  onClick={(e) => { e.stopPropagation(); setTarget(id, target + 1); }}
                  aria-label={`Increase ${label} target`}
                >
                  +
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
