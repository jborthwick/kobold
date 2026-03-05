import type { Goblin } from '../../shared/types';
import { MAX_INVENTORY_CAPACITY } from '../../shared/constants';
import { isWalkable } from '../world';
import { sigmoid, ramp, inverseSigmoid } from '../utilityAI';
import { traitMod } from '../agents';
import { moveTo, shouldLog, traitText, totalLoad } from './helpers';
import type { Action } from './types';

// --- share: gift food to a hungry neighbor ---
export const share: Action = {
  name: 'share',
  eligible: ({ goblin, goblins }) => {
    if (!goblins) return false;
    const shareThresh = traitMod(goblin, 'shareThreshold', 8);
    if (goblin.inventory.food < shareThresh) return false;
    const relGate = traitMod(goblin, 'shareRelationGate', 30);
    return goblins.some(d =>
      d.alive && d.id !== goblin.id &&
      Math.abs(d.x - goblin.x) <= traitMod(goblin, 'generosityRange', 2) && Math.abs(d.y - goblin.y) <= traitMod(goblin, 'generosityRange', 2) &&
      d.hunger > 60 && d.inventory.food < 3 &&
      (goblin.relations[d.id] ?? 50) >= relGate,
    );
  },
  score: ({ goblin, goblins }) => {
    if (!goblins) return 0;
    const relGate = traitMod(goblin, 'shareRelationGate', 30);
    const target = goblins
      .filter(d =>
        d.alive && d.id !== goblin.id &&
        Math.abs(d.x - goblin.x) <= traitMod(goblin, 'generosityRange', 2) && Math.abs(d.y - goblin.y) <= traitMod(goblin, 'generosityRange', 2) &&
        d.hunger > 60 && d.inventory.food < 3 &&
        (goblin.relations[d.id] ?? 50) >= relGate,
      )
      .sort((a, b) => b.hunger - a.hunger)[0];
    if (!target) return 0;
    // Higher score when target is hungrier and we have more surplus; less likely when donor is also getting hungry
    return sigmoid(target.hunger, 70) * ramp(goblin.inventory.food, 6, 15) * inverseSigmoid(goblin.hunger, 50) * 0.8;
  },
  execute: ({ goblin, goblins, currentTick, onLog }) => {
    if (!goblins) return;
    const relGate = traitMod(goblin, 'shareRelationGate', 30);
    const donorKeeps = traitMod(goblin, 'shareDonorKeeps', 5);
    const target = goblins
      .filter(d =>
        d.alive && d.id !== goblin.id &&
        Math.abs(d.x - goblin.x) <= traitMod(goblin, 'generosityRange', 2) && Math.abs(d.y - goblin.y) <= traitMod(goblin, 'generosityRange', 2) &&
        d.hunger > 60 && d.inventory.food < 3 &&
        (goblin.relations[d.id] ?? 50) >= relGate,
      )
      .sort((a, b) => b.hunger - a.hunger)[0];
    if (!target) return;
    const give = Math.min(3, goblin.inventory.food - donorKeeps);
    if (give <= 0) return;
    const headroom = MAX_INVENTORY_CAPACITY - totalLoad(target.inventory);
    const actual   = Math.min(give, headroom);
    if (actual <= 0) return;
    goblin.inventory.food  -= actual;
    target.inventory.food += actual;
    const prevRel = goblin.relations[target.id] ?? 50;
    goblin.relations[target.id]  = Math.min(100, prevRel + 5);
    target.relations[goblin.id]  = Math.min(100, (target.relations[goblin.id] ?? 50) + 3);
    goblin.task = `shared ${actual.toFixed(0)} food → ${target.name}`;
    onLog?.(`🤝 ${traitText(goblin, 'share')} ${actual.toFixed(0)} food with ${target.name}`, 'info');
    // Friendship milestone — relation crossed 70
    if (prevRel < 70 && goblin.relations[target.id] >= 70 && shouldLog(goblin, `friend_${target.id}`, currentTick, 300)) {
      onLog?.(`💛 became friends with ${target.name}`, 'info');
    }
  },
};

// --- socialize: seek out a friendly goblin ---
export const socialize: Action = {
  name: 'socialize',
  intentMatch: 'socialize',
  eligible: ({ goblin }) => goblin.social > 30,
  score: ({ goblin }) => sigmoid(goblin.social, 50) * 0.6,
  execute: ({ goblin, goblins, grid }) => {
    if (!goblins) { goblin.task = 'lonely'; return; }
    const FRIEND_REL    = 40;
    const FRIEND_RADIUS = traitMod(goblin, 'generosityRange', 2) + 1;
    let bestDist = Infinity;
    let bestFriend: Goblin | null = null;
    for (const other of goblins) {
      if (other.id === goblin.id || !other.alive) continue;
      if ((goblin.relations[other.id] ?? 50) < FRIEND_REL) continue;
      const dist = Math.abs(other.x - goblin.x) + Math.abs(other.y - goblin.y);
      if (dist > FRIEND_RADIUS * 4) continue; // don't seek friends too far away
      if (dist < bestDist) { bestDist = dist; bestFriend = other; }
    }
    if (bestFriend && bestDist > 1) {
      moveTo(goblin, { x: bestFriend.x, y: bestFriend.y }, grid);
    }
    goblin.task = 'socializing';
  },
};

// --- avoidRival: flee from nearby threats ---
export const avoidRival: Action = {
  name: 'avoidRival',
  intentMatch: 'avoid',
  eligible: ({ goblin, goblins }) => {
    if (!goblins) return false;
    const avoidRadius = 3 + traitMod(goblin, 'wariness', 2);
    return goblins.some(r =>
      r.alive && r.id !== goblin.id &&
      Math.abs(r.x - goblin.x) + Math.abs(r.y - goblin.y) <= avoidRadius &&
      (goblin.relations[r.id] ?? 50) < 30,
    );
  },
  score: () => 0.3,
  execute: ({ goblin, goblins, grid }) => {
    if (!goblins) return;
    const avoidRadius = 3 + traitMod(goblin, 'wariness', 2);
    const rival = goblins
      .filter(r => r.alive && r.id !== goblin.id)
      .map(r => ({ r, dist: Math.abs(r.x - goblin.x) + Math.abs(r.y - goblin.y) }))
      .filter(e => e.dist <= avoidRadius && (goblin.relations[e.r.id] ?? 50) < 30)
      .sort((a, b) => a.dist - b.dist)[0]?.r ?? null;
    if (!rival) return;
    const avoidDirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    const avoidOpen = avoidDirs
      .map(d => ({ x: goblin.x + d.x, y: goblin.y + d.y }))
      .filter(p => isWalkable(grid, p.x, p.y));
    if (avoidOpen.length > 0) {
      const next = avoidOpen.reduce((best, p) =>
        (Math.abs(p.x - rival.x) + Math.abs(p.y - rival.y)) >
        (Math.abs(best.x - rival.x) + Math.abs(best.y - rival.y)) ? p : best,
      );
      goblin.x = next.x; goblin.y = next.y;
      goblin.task = `avoiding ${rival.name}`;
    }
  },
};
