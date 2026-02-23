import mitt from 'mitt';
import type { GameState } from './types';

type Events = {
  gameState: GameState;
};

export const bus = mitt<Events>();
