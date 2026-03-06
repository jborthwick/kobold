import { useEffect, useState } from 'react';
import { bus } from '../../shared/events';
import type { GameState, ColonyGoal, FoodStockpile, OreStockpile, WoodStockpile } from '../../shared/types';

const styles: Record<string, React.CSSProperties> = {
  goalPanel: {
    background: 'rgba(0,0,0,0.75)',
    padding: '8px 12px',
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#ccc',
    userSelect: 'none',
    pointerEvents: 'none',
    flexShrink: 0,
    borderBottom: '1px solid #333',
  } as React.CSSProperties,
  goalTitle: {
    fontSize: 8,
    color: '#888',
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    marginBottom: 4,
  },
  goalDesc: {
    color: '#f0c040',
    fontSize: 11,
    marginBottom: 5,
    fontWeight: 'bold',
  },
  goalProgress: {
    fontSize: 9,
    color: '#999',
    marginTop: 3,
  },
  goalDepot: {
    display: 'flex',
    alignItems: 'center',
    marginTop: 6,
    fontSize: 9,
  },
  barTrack: {
    background: '#333',
    height: 7,
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 4,
    transition: 'width 0.15s ease',
  },
};

export function ColonyGoalPanel() {
  const [goal, setGoal] = useState<ColonyGoal | null>(null);
  const [foodStockpiles, setFoodStockpiles] = useState<FoodStockpile[]>([]);
  const [oreStockpiles, setOreStockpiles] = useState<OreStockpile[]>([]);
  const [woodStockpiles, setWoodStockpiles] = useState<WoodStockpile[]>([]);

  useEffect(() => {
    const onState = (s: GameState) => {
      if (s.colonyGoal) setGoal({ ...s.colonyGoal });
      if (s.foodStockpiles) setFoodStockpiles(s.foodStockpiles.map(d => ({ ...d })));
      if (s.oreStockpiles) setOreStockpiles(s.oreStockpiles.map(sp => ({ ...sp })));
      if (s.woodStockpiles) setWoodStockpiles(s.woodStockpiles.map(sp => ({ ...sp })));
    };
    bus.on('gameState', onState);
    return () => bus.off('gameState', onState);
  }, []);

  if (!goal) return null;

  const pct = Math.min(1, goal.progress / goal.target);
  const totalFood = foodStockpiles.reduce((s, d) => s + d.food, 0);
  const maxFood = foodStockpiles.reduce((s, d) => s + d.maxFood, 0);
  const totalOre = oreStockpiles.reduce((s, sp) => s + sp.ore, 0);
  const maxOre = oreStockpiles.reduce((s, sp) => s + sp.maxOre, 0);
  const totalWood = woodStockpiles.reduce((s, sp) => s + sp.wood, 0);
  const maxWood = woodStockpiles.reduce((s, sp) => s + sp.maxWood, 0);
  const foodStockpilePct = maxFood > 0 ? Math.min(1, totalFood / maxFood) : 0;
  const oreStockpilePct = maxOre > 0 ? Math.min(1, totalOre / maxOre) : 0;
  const woodStockpilePct = maxWood > 0 ? Math.min(1, totalWood / maxWood) : 0;
  const foodLabel = foodStockpiles.length > 1 ? `×${foodStockpiles.length}` : '';
  const oreLabel = oreStockpiles.length > 1 ? `×${oreStockpiles.length}` : '';
  const woodLabel = woodStockpiles.length > 1 ? `×${woodStockpiles.length}` : '';

  return (
    <div style={styles.goalPanel}>
      <div style={styles.goalTitle}>COLONY GOAL · gen {goal.generation + 1}</div>
      <div style={styles.goalDesc}>{goal.description}</div>
      <div style={styles.barTrack}>
        <div style={{
          ...styles.barFill,
          width: `${pct * 100}%`,
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
