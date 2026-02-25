import { PhaserGame } from './game/PhaserGame';
import { HUD } from './ui/HUD';
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
      <EventLog />
      <TilePicker />
    </div>
  );
}
