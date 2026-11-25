import { DIRS, DIR_VEC, TILE } from './constants.js';

/**
 * Deterministic 32-bit PRNG (Mulberry32).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns up to 8 spawn coordinates [x, y, facingDir] around the arena perimeter.
 */
export function pickSpawns(cols, rows, count) {
  const candidates = [
    [1, 1, 'right'],
    [cols - 2, rows - 2, 'left'],
    [cols - 2, 1, 'left'],
    [1, rows - 2, 'right'],
    [Math.floor(cols / 2), 1, 'down'],
    [Math.floor(cols / 2), rows - 2, 'up'],
    [1, Math.floor(rows / 2), 'right'],
    [cols - 2, Math.floor(rows / 2), 'left'],
  ];
  return candidates.slice(0, count);
}

/**
 * Reflects a laser direction off mirror tile 4 ('/') or 5 ('\').
 */
export function reflectMirror(cell, dir) {
  if (cell === TILE.MIRROR_FWD) {
    return { right: 'up', left: 'down', up: 'right', down: 'left' }[dir];
  }
  return { right: 'down', left: 'up', up: 'left', down: 'right' }[dir];
}

/**
 * Generates a deterministic procedural Sokowar arena grid and spawn list.
 */
export function generateProceduralMap(cols, rows, count, style, seed, density = 1.0) {
  const rand = mulberry32(seed);
  const dScale = Math.max(0.15, Math.min(2.0, Number(density) || 1.0));
  const g = Array.from({ length: rows }, () => Array(cols).fill(TILE.EMPTY));
  const spawns = pickSpawns(cols, rows, count);

  const isSafe = (x, y) => {
    for (const [sx, sy] of spawns) {
      if (Math.abs(x - sx) <= 1 && Math.abs(y - sy) <= 1) return true;
    }
    return false;
  };

  // 1. Place indestructible walls
  const wallChance = Math.min(0.24, (style === 'mirrors' ? 0.08 : 0.12) * dScale);
  if (style === 'symmetric') {
    const halfW = Math.ceil(cols / 2);
    const halfH = Math.ceil(rows / 2);
    for (let y = 1; y < halfH; y++) {
      for (let x = 1; x < halfW; x++) {
        if (rand() < wallChance * 1.15) {
          const pts = [[x, y], [cols - 1 - x, y], [x, rows - 1 - y], [cols - 1 - x, rows - 1 - y]];
          for (const [px, py] of pts) {
            if (!isSafe(px, py)) g[py][px] = TILE.WALL;
          }
        }
      }
    }
  } else {
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        if (isSafe(x, y)) continue;
        if (g[y - 1][x] === TILE.WALL && g[y][x - 1] === TILE.WALL && g[y - 1][x - 1] === TILE.WALL) continue;
        if (rand() < wallChance) g[y][x] = TILE.WALL;
      }
    }
  }

  // 2. Connectivity guarantee from spawns[0] to every other spawn
  const reachable = () => {
    const vis = Array.from({ length: rows }, () => Array(cols).fill(false));
    const q = [[spawns[0][0], spawns[0][1]]];
    vis[spawns[0][1]][spawns[0][0]] = true;
    while (q.length) {
      const [cx, cy] = q.shift();
      for (const d of DIRS) {
        const [dx, dy] = DIR_VEC[d];
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !vis[ny][nx] && g[ny][nx] !== TILE.WALL) {
          vis[ny][nx] = true;
          q.push([nx, ny]);
        }
      }
    }
    return vis;
  };

  let vis = reachable();
  for (const [sx, sy] of spawns) {
    if (!vis[sy][sx]) {
      let cx = sx;
      let cy = sy;
      const tx = spawns[0][0];
      const ty = spawns[0][1];
      while (cx !== tx || cy !== ty) {
        g[cy][cx] = TILE.EMPTY;
        if (cx !== tx) cx += cx < tx ? 1 : -1;
        else if (cy !== ty) cy += cy < ty ? 1 : -1;
      }
      vis = reachable();
    }
  }

  // Clear isolated enclosed pockets so boxes/pickups never get orphaned
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (g[y][x] === TILE.EMPTY && !vis[y][x]) g[y][x] = TILE.WALL;
    }
  }

  // 3. Populate pushable Crates, Mirrors, and Boom Crates
  let crateProb = (style === 'mirrors' ? 0.16 : 0.22) * dScale;
  let mirrorProb = (style === 'mirrors' ? 0.14 : 0.085) * dScale;
  let boomProb = 0.035 * dScale;
  const totalObjProb = crateProb + mirrorProb + boomProb;
  if (totalObjProb > 0.72) {
    const cap = 0.72 / totalObjProb;
    crateProb *= cap;
    mirrorProb *= cap;
    boomProb *= cap;
  }

  const placeObject = () => {
    const r = rand();
    if (r < boomProb) return TILE.BOOM;
    if (r < boomProb + mirrorProb) return rand() < 0.5 ? TILE.MIRROR_FWD : TILE.MIRROR_BWD;
    if (r < boomProb + mirrorProb + crateProb) return TILE.CRATE_2;
    return TILE.EMPTY;
  };

  if (style === 'symmetric') {
    const halfW = Math.ceil(cols / 2);
    const halfH = Math.ceil(rows / 2);
    for (let y = 0; y < halfH; y++) {
      for (let x = 0; x < halfW; x++) {
        const obj = placeObject();
        if (!obj) continue;
        const flippedMirror = obj === TILE.MIRROR_FWD ? TILE.MIRROR_BWD : obj === TILE.MIRROR_BWD ? TILE.MIRROR_FWD : obj;
        const pts = [
          [x, y, obj],
          [cols - 1 - x, y, flippedMirror],
          [x, rows - 1 - y, flippedMirror],
          [cols - 1 - x, rows - 1 - y, obj],
        ];
        for (const [px, py, pObj] of pts) {
          if (!isSafe(px, py) && g[py][px] === TILE.EMPTY) g[py][px] = pObj;
        }
      }
    }
  } else {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!isSafe(x, y) && g[y][x] === TILE.EMPTY) {
          g[y][x] = placeObject();
        }
      }
    }
  }

  return { grid: g, spawns, rand };
}
