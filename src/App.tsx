import { PhaserGame } from './game/PhaserGame';
import { HUD } from './ui/HUD';
import { EventLog } from './ui/EventLog';

export default function App() {
  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <PhaserGame />
      <HUD />
      <EventLog />
    </div>
  );
}
