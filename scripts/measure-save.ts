import { generateWorld } from '../src/simulation/world';
import { GRID_SIZE } from '../src/shared/constants';
import type { Tile } from '../src/shared/types';

const { grid } = generateWorld(42);

// Measure raw grid JSON
const gridJson = JSON.stringify(grid);
console.log(`Grid (${GRID_SIZE}x${GRID_SIZE}=${GRID_SIZE*GRID_SIZE} tiles):`);
console.log(`  Total:   ${gridJson.length.toLocaleString()} bytes (${(gridJson.length/1024/1024).toFixed(2)} MB)`);
console.log(`  Per tile: ~${Math.round(gridJson.length / (GRID_SIZE*GRID_SIZE))} bytes`);

// Sample a few tiles
const sample = [grid[0][0], grid[64][64], grid[100][100]];
console.log('\nSample tiles:');
for (const t of sample) console.log(' ', JSON.stringify(t));

// How many tiles have trafficScore?
let withTraffic = 0;
for (let y = 0; y < GRID_SIZE; y++) for (let x = 0; x < GRID_SIZE; x++) if (grid[y][x].trafficScore !== undefined) withTraffic++;
console.log(`\nTiles with trafficScore set: ${withTraffic} (of ${GRID_SIZE*GRID_SIZE})`);
