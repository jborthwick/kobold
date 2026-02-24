import { PhaserGame } from './game/PhaserGame';
import { HUD, TileTooltip } from './ui/HUD';
import { EventLog } from './ui/EventLog';
import { TilePicker } from './ui/TilePicker';

export default function App() {
  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <PhaserGame />
      <HUD />
      <TileTooltip />
      <EventLog />
      <TilePicker />
    </div>
  );
}
