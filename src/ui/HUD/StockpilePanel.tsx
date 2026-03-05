import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import { getActiveFaction } from '../../shared/factions';
import type { GameState, FoodStockpile, OreStockpile, WoodStockpile } from '../../shared/types';

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
  panelName: {
    fontSize:   15,
    fontWeight: 'bold',
    color:      '#f0c040',
    marginBottom: 8,
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
};

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

  const carriers = isFoodSp
    ? state.goblins.filter(d => d.alive && d.inventory.food > 0).length
    : isOreSp
      ? state.goblins.filter(d => d.alive && d.inventory.ore > 0).length
      : state.goblins.filter(d => d.alive && d.inventory.wood > 0).length;

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
        {getActiveFaction().unitNounPlural} carrying {resource}: <span style={{ color }}>{carriers}</span>
      </div>
    </div>
  );
}
