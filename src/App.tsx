import { PhaserGame } from './game/PhaserGame';
import { HUD, SelectedDwarfPanel } from './ui/HUD';
import { EventLog } from './ui/EventLog';
import { MiniMap } from './ui/MiniMap';
import { TilePicker } from './ui/TilePicker';

export default function App() {
  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <PhaserGame />
      <HUD />
      {/* <TileTooltip /> — disabled; re-add import from './ui/HUD' to re-enable */}
      <MiniMap />
      {/* Right sidebar: event log on top, selected-dwarf panel below */}
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
        <EventLog />
        <SelectedDwarfPanel />
      </div>
      <TilePicker />
    </div>
  );
}
