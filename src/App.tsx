import { PhaserGame } from './game/PhaserGame';
import { HUD } from './ui/HUD';

export default function App() {
  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <PhaserGame />
      <HUD />
    </div>
  );
}
