import { useEffect, useState } from 'react';
import { PhaserGame } from './game/PhaserGame';
import { HUD, SelectedDwarfPanel, ColonyGoalPanel, StockpilePanel, GoblinPanel, TokenDebugPanel } from './ui/HUD';
import { EventLog } from './ui/EventLog';
import { MiniMap } from './ui/MiniMap';
import { TilePicker } from './ui/TilePicker';
import { StartMenu } from './ui/StartMenu';
import { bus } from './shared/events';
import { deleteSave } from './shared/save';

export default function App() {
  const [gameMode,  setGameMode]  = useState<'menu' | 'playing'>('menu');
  const [startMode, setStartMode] = useState<'new' | 'load'>('new');

  useEffect(() => {
    const handler = ({ action }: { action: 'pause' | 'speedUp' | 'speedDown' | 'newColony' }) => {
      if (action === 'newColony') {
        deleteSave();
        setGameMode('menu');
      }
    };
    bus.on('controlChange', handler);
    return () => bus.off('controlChange', handler);
  }, []);

  if (gameMode === 'menu') {
    return (
      <StartMenu
        onStart={(mode) => {
          setStartMode(mode);
          setGameMode('playing');
        }}
      />
    );
  }

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <PhaserGame startMode={startMode} />
      <HUD />
      {/* <TileTooltip /> — disabled; re-add import from './ui/HUD' to re-enable */}
      <MiniMap />
      {/* Right sidebar: colony goal on top, event log in middle, selected-dwarf panel below */}
      <div style={{
        position:      'absolute',
        top:           8,
        right:         0,
        bottom:        0,
        width:         360,
        display:       'flex',
        flexDirection: 'column',
        pointerEvents: 'none',
      }}>
        <ColonyGoalPanel />
        <EventLog />
        <SelectedDwarfPanel />
        <StockpilePanel />
        <GoblinPanel />
      </div>
      <TokenDebugPanel />
      <TilePicker />
    </div>
  );
}
