import { useEffect, useState } from 'react';
import { PhaserGame } from './game/PhaserGame';
import { HUD, SelectedDwarfPanel, ColonyGoalPanel, ChroniclePanel, StockpilePanel, GoblinPanel, TokenDebugPanel } from './ui/HUD';
import { EventLog } from './ui/EventLog';
import { MiniMap } from './ui/MiniMap';
import { TilePicker } from './ui/TilePicker';
import { StartMenu } from './ui/StartMenu';
import { MobileControls } from './ui/MobileControls';
import { MobileBottomSheet } from './ui/MobileBottomSheet';
import { useLayoutMode } from './shared/useViewport';
import { bus } from './shared/events';
import { deleteSave } from './shared/save';

export default function App() {
  const [gameMode,  setGameMode]  = useState<'menu' | 'playing'>('menu');
  const [startMode, setStartMode] = useState<'new' | 'load'>('new');
  const layout = useLayoutMode();

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

  const isPhone  = layout === 'phone';
  const isDesktop = layout === 'desktop';
  const sidebarWidth = isPhone ? 0 : layout === 'tablet' ? 280 : 360;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <PhaserGame startMode={startMode} />
      <HUD layout={layout} />
      {/* <TileTooltip /> — disabled; re-add import from './ui/HUD' to re-enable */}

      {/* MiniMap: hide on phone (too small to be useful) */}
      {!isPhone && <MiniMap />}

      {/* Desktop/tablet: right sidebar */}
      {!isPhone && (
        <div style={{
          position:      'absolute',
          top:           8,
          right:         0,
          bottom:        0,
          width:         sidebarWidth,
          display:       'flex',
          flexDirection: 'column',
          pointerEvents: 'none',
        }}>
          <ColonyGoalPanel />
          <ChroniclePanel />
          <EventLog layout={layout} />
          <SelectedDwarfPanel />
          <StockpilePanel />
          <GoblinPanel />
        </div>
      )}

      {/* Phone: bottom sheet + controls */}
      {isPhone && <MobileBottomSheet layout={layout} />}
      {isPhone && <MobileControls />}

      {/* Dev tools: desktop only */}
      {isDesktop && <TokenDebugPanel />}
      {isDesktop && <TilePicker />}
    </div>
  );
}
