import {
  BOT_NAMES,
  DIRS,
  DIR_TO_IDX,
  DIR_VEC,
  NET_CFG,
  TILE,
} from './constants.js';
import { generateProceduralMap, reflectMirror } from './map.js';
import {
  ensureAudio,
  isSoundEnabled,
  setSoundEnabled,
  sfxBoom,
  sfxCountdownGo,
  sfxCountdownTick,
  sfxHealSpawn,
  sfxHit,
  sfxLaser,
  sfxMirror,
  sfxPickup,
  sfxPush,
  sfxTurret,
} from './audio.js';
import { createRenderer, readTheme } from './render.js';
import {
  buildInviteUrl,
  createNetClient,
  getRoomFromUrl,
  getSavedIceJson,
  sanitizeRoomCode,
  saveIceJson,
} from './net.js';

(() => {
  // --- DOM Elements ---
  const app = document.getElementById('app');
  const stageWrap = document.getElementById('stage-wrap');
  const canvas = document.getElementById('stage');
  const focusHint = document.getElementById('focus-hint');
  const sizeSel = document.getElementById('size-sel');
  const botsSel = document.getElementById('bots-sel');
  const styleSel = document.getElementById('style-sel');
  const densityRange = document.getElementById('density-range');
  const densityVal = document.getElementById('density-val');
  const p2Btn = document.getElementById('p2-btn');
  const newMapBtn = document.getElementById('new-map-btn');
  const replayBtn = document.getElementById('replay-btn');
  const soundBtn = document.getElementById('sound-btn');
  const seedLabel = document.getElementById('seed-label');
  const roundLabel = document.getElementById('round-label');
  const kpsEl = document.getElementById('kps-val');
  const rosterEl = document.getElementById('roster');
  const p2HintEl = document.getElementById('p2-hint');

  // Multiplayer DOM
  const nameInput = document.getElementById('name-input');
  const hostBtn = document.getElementById('host-btn');
  const roomInput = document.getElementById('room-input');
  const joinBtn = document.getElementById('join-btn');
  const relaySel = document.getElementById('relay-sel');
  const lobbyControlsEl = document.getElementById('lobby-controls');
  const roomActiveEl = document.getElementById('room-active');
  const roomBadgeEl = document.getElementById('room-badge');
  const copyLinkBtn = document.getElementById('copy-link-btn');
  const backfillBtn = document.getElementById('backfill-btn');
  const leaveBtn = document.getElementById('leave-btn');
  const netPillEl = document.getElementById('net-pill');
  const netBannerEl = document.getElementById('net-banner');
  const netBannerMsgEl = document.getElementById('net-banner-msg');
  const netBannerSoloBtn = document.getElementById('net-banner-solo');
  const netBannerHostBtn = document.getElementById('net-banner-host');
  const iceBtn = document.getElementById('ice-btn');
  const iceDrawer = document.getElementById('ice-drawer');
  const iceTextarea = document.getElementById('ice-textarea');
  const iceSaveBtn = document.getElementById('ice-save-btn');
  const iceMsgEl = document.getElementById('ice-msg');
  const statsRateEl = document.getElementById('stats-rate');
  const pingListEl = document.getElementById('ping-list');
  const tutorialBtn = document.getElementById('tutorial-btn');
  const tutorialBody = document.getElementById('tutorial-body');
  const tutorialToggleLbl = document.getElementById('tutorial-toggle-lbl');

  // --- Theme & Renderer ---
  let theme = readTheme();
  window.addEventListener('themechange', () => {
    theme = readTheme();
  });
  const renderer = createRenderer({ canvas, stageWrap });

  // --- Local Preferences ---
  const NAME_STORAGE_KEY = 'sokowar_callsign';
  try {
    const savedName = localStorage.getItem(NAME_STORAGE_KEY);
    if (savedName) nameInput.value = savedName;
  } catch {
    // Ignore storage errors
  }
  if (!nameInput.value.trim()) {
    nameInput.value = `PILOT-${Math.floor(10 + Math.random() * 89)}`;
  }
  nameInput.addEventListener('input', () => {
    try {
      localStorage.setItem(NAME_STORAGE_KEY, getCallsign());
    } catch {
      // Ignore
    }
  });

  function getCallsign() {
    return (nameInput.value || 'YOU').trim().toUpperCase().slice(0, 10) || 'YOU';
  }

  iceTextarea.value = getSavedIceJson();

  // --- Focus, Held-Key Tracking & Movement-Only KPS ---
  const HOLD_REPEAT_MS = 90;
  const p1HeldDirs = [];
  const p2HeldDirs = [];
  const moveKeyTimestamps = [];

  function recordMoveKey() {
    moveKeyTimestamps.push(performance.now());
  }

  function updateKps(now) {
    while (moveKeyTimestamps.length && now - moveKeyTimestamps[0] > 1500) moveKeyTimestamps.shift();
    if (kpsEl) kpsEl.textContent = (moveKeyTimestamps.length / 1.5).toFixed(1);
  }

  function clearHeldDirs() {
    p1HeldDirs.length = 0;
    p2HeldDirs.length = 0;
  }

  function setFocusUI(focused) {
    focusHint.style.opacity = focused ? '0' : '1';
  }
  window.addEventListener('focus', () => setFocusUI(true));
  window.addEventListener('blur', () => {
    setFocusUI(false);
    clearHeldDirs();
  });
  stageWrap.addEventListener('pointerdown', () => {
    app.focus({ preventScroll: true });
    setFocusUI(true);
    ensureAudio();
  });
  setFocusUI(document.hasFocus());

  // --- Authoritative & Client State ---
  const state = {
    cols: 21,
    rows: 13,
    botCount: 4,
    style: 'ruins',
    density: 1.0,
    mode2P: false,
    backfillBots: true,
    seed: Math.floor(1000 + Math.random() * 9000),
    round: 1,
    grid: [],
    pickups: [],        // { x, y, type: 'heal' | 'overdrive' }
    pendingPickups: [], // { x, y, type: 'heal', duration, remaining }
    healthSpawnCd: 2.5,
    bots: [],
    turrets: [],
    beams: [],          // { pts: [[gx, gy], ...], color, life, maxLife, width }
    particles: [],      // { gx, gy, vx, vy, life, maxLife, rTiles, color }
    wins: {},
    roundOver: false,
    roundWinner: null,
    roundTimer: 0,
    countdown: 0,
    shakeTime: 0,
    shakeAmp: 0,
    lastP1Move: 0,
    lastP2Move: 0,
    netRole: 'solo',    // 'solo' | 'host' | 'guest'
    mySlot: 0,
    spectating: false,
  };

  // --- Multiplayer Sync State ---
  const guestRoster = new Map(); // peerId -> { peerId, slot, name, lastSeq, spectating, pingMs, natType }
  const dirtyCells = new Map();  // "x,y" -> [x, y, val]
  let deltaDirty = false;
  let lastDeltaSentAt = 0;
  let lastPeriodicSyncAt = 0;
  let lastSimStepAt = performance.now();
  let lastCountdownBeepSec = 0;
  let peerMetaList = []; // [[slot, name, pingMs, natType, spectating], ...]
  let netTraffic = { txRate: 0, rxRate: 0, natType: '' };

  // Guest CSP State
  let authGrid = [];
  let authLocalPos = null; // { x, y, dir }
  let inputSeq = 0;
  let pendingInputs = []; // { seq, dir }

  function cloneGrid(g) {
    return g.map((row) => row.slice());
  }

  function markCellDirty(x, y) {
    if (state.netRole !== 'host') return;
    dirtyCells.set(`${x},${y}`, [x, y, state.grid[y][x]]);
    deltaDirty = true;
  }

  function markStateDirty() {
    if (state.netRole === 'host') deltaDirty = true;
  }

  function pingColorStyle(ms) {
    if (typeof ms !== 'number') return theme.muted;
    if (ms < 50) return theme.success;
    if (ms < 120) return theme.warning;
    return theme.error;
  }

  function buildPeersMeta() {
    const rows = [[0, getCallsign(), 0, 'Host', 0]];
    const sorted = [...guestRoster.values()].sort((a, b) => a.slot - b.slot);
    for (const g of sorted) {
      rows.push([g.slot, g.name, typeof g.pingMs === 'number' ? g.pingMs : null, g.natType || 'P2P', g.spectating ? 1 : 0]);
    }
    return rows;
  }

  function renderStatsPanel() {
    if (!pingListEl || !statsRateEl) return;

    if (state.netRole === 'solo') {
      statsRateEl.textContent = 'Local';
    } else {
      const natLabel = netTraffic.natType ? ` · ${netTraffic.natType}` : '';
      statsRateEl.textContent = `Tx ${netTraffic.txRate} / Rx ${netTraffic.rxRate} pkt/s${natLabel}`;
    }

    pingListEl.innerHTML = '';
    if (state.netRole === 'solo') {
      const empty = document.createElement('div');
      empty.className = 'text-[var(--muted-foreground)]';
      empty.textContent = 'Solo mode — Host or Join a room for live player pings.';
      pingListEl.appendChild(empty);
      return;
    }

    const list = state.netRole === 'host' ? buildPeersMeta() : peerMetaList;
    for (const [slot, name, pingMs, natType, spectating] of list) {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-2';

      const left = document.createElement('div');
      left.className = 'flex items-center gap-1.5 min-w-0';
      const dot = document.createElement('span');
      dot.className = 'w-2 h-2 rounded-full shrink-0';
      dot.style.backgroundColor = theme.palette[slot % theme.palette.length];
      const lbl = document.createElement('span');
      lbl.className = 'truncate text-[var(--foreground)]';
      const flags = [];
      if (slot === state.mySlot) flags.push('YOU');
      if (slot === 0) flags.push('HOST');
      if (spectating) flags.push('SPEC');
      lbl.textContent = flags.length ? `${name} (${flags.join('/')})` : name;
      left.append(dot, lbl);

      const right = document.createElement('div');
      right.className = 'flex items-center gap-1.5 shrink-0 tabular-nums';
      if (natType && slot !== 0) {
        const natEl = document.createElement('span');
        natEl.className = 'text-[10px] text-[var(--muted-foreground)]';
        natEl.textContent = natType;
        right.appendChild(natEl);
      }
      const pingEl = document.createElement('span');
      pingEl.style.color = slot === 0 ? theme.primary : pingColorStyle(pingMs);
      pingEl.textContent = slot === 0 ? '0ms' : typeof pingMs === 'number' ? `${pingMs}ms` : '...';
      right.appendChild(pingEl);

      row.append(left, right);
      pingListEl.appendChild(row);
    }
  }

  function renderRoster() {
    rosterEl.innerHTML = '';
    const pingBySlot = new Map();
    const meta = state.netRole === 'host' ? buildPeersMeta() : peerMetaList;
    for (const [slot, , pingMs] of meta) {
      pingBySlot.set(slot, pingMs);
    }

    for (const b of state.bots) {
      const row = document.createElement('div');
      const dead = b.hp <= 0;
      row.className = `flex items-center justify-between px-2 py-1 rounded-md border text-xs ${
        dead ? 'border-[var(--border)] opacity-45' : 'border-[var(--border)] bg-[var(--background)]'
      }`;
      const left = document.createElement('div');
      left.className = 'flex items-center gap-1.5 min-w-0';
      const dot = document.createElement('span');
      dot.className = 'w-2.5 h-2.5 rounded-full shrink-0';
      dot.style.backgroundColor = b.color;
      const label = document.createElement('span');
      label.className = 'font-mono font-medium truncate';
      const tag = b.isLocal ? ' (YOU)' : b.isHuman ? '' : ' [AI]';
      label.textContent = b.name + (state.netRole !== 'solo' ? tag : '') + (b.overdrive > 0 && !dead ? ' ⚡' : '');
      left.append(dot, label);

      const right = document.createElement('div');
      right.className = 'flex items-center gap-2 font-mono shrink-0';
      if (state.netRole !== 'solo' && b.isHuman) {
        const ms = pingBySlot.get(b.slot);
        const pingTag = document.createElement('span');
        pingTag.className = 'text-[10px] tabular-nums';
        pingTag.style.color = b.slot === 0 ? theme.primary : pingColorStyle(ms);
        pingTag.textContent = b.slot === 0 ? 'HOST' : typeof ms === 'number' ? `${ms}ms` : '--';
        right.appendChild(pingTag);
      }
      const hearts = document.createElement('span');
      hearts.style.color = b.color;
      hearts.textContent = dead ? 'KO' : ('♥'.repeat(b.hp) + '♡'.repeat(b.maxHp - b.hp));
      const wins = document.createElement('span');
      wins.className = 'text-[var(--muted-foreground)]';
      wins.textContent = `${state.wins[b.id] || 0}W`;
      right.append(hearts, wins);

      row.append(left, right);
      rosterEl.appendChild(row);
    }
    renderStatsPanel();
  }

  function triggerShake(amp = 5, dur = 0.14) {
    state.shakeAmp = Math.max(state.shakeAmp, amp * 0.4);
    state.shakeTime = Math.max(state.shakeTime, dur);
  }

  function spawnParticlesGrid(gx, gy, color, count = 10, speedTiles = 5.0) {
    for (let i = 0; i < count; i++) {
      const ang = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const spd = speedTiles * (0.35 + Math.random() * 0.85);
      state.particles.push({
        gx,
        gy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: 0.32 + Math.random() * 0.25,
        maxLife: 0.52,
        rTiles: 0.06 + Math.random() * 0.07,
        color,
      });
    }
  }

  function playSfxKind(kind) {
    if (kind === 'push') sfxPush();
    else if (kind === 'mirror') sfxMirror();
    else if (kind === 'pickup') sfxPickup();
    else if (kind === 'turret') sfxTurret();
    else if (kind === 'healSpawn') sfxHealSpawn();
    else if (kind === 'laser') sfxLaser();
  }

  function emitSfx(kind) {
    playSfxKind(kind);
    if (state.netRole === 'host') {
      net.sendEvent({ t: 'sfx', kind });
    }
  }

  // --- Slot & Combatant Construction ---
  function computeOnlineCombatantList() {
    // Slot 0 is Host; Slots 1..N are sorted connected Guests; remaining up to botCount filled with AI if backfillBots
    const sortedGuests = [...guestRoster.values()].sort((a, b) => a.slot - b.slot);
    const maxSlot = sortedGuests.reduce((m, g) => Math.max(m, g.slot), 0);
    const totalCount = state.backfillBots
      ? Math.min(NET_CFG.MAX_PLAYERS, Math.max(state.botCount, maxSlot + 1))
      : Math.min(NET_CFG.MAX_PLAYERS, Math.max(2, maxSlot + 1));
    return { totalCount, sortedGuests };
  }

  function startRound(newSeed = false, withCountdown = true) {
    if (state.netRole === 'guest') return; // Host-authoritative

    if (newSeed) {
      state.seed = Math.floor(1000 + Math.random() * 9000);
      state.round = 1;
    }
    seedLabel.textContent = `Seed #${state.seed}`;
    roundLabel.textContent = `Round ${state.round}`;

    let combatantCount = state.botCount;
    let guestBySlot = new Map();
    if (state.netRole === 'host') {
      const { totalCount, sortedGuests } = computeOnlineCombatantList();
      combatantCount = totalCount;
      for (const g of sortedGuests) {
        g.spectating = false;
        guestBySlot.set(g.slot, g);
      }
    }

    const { grid, spawns } = generateProceduralMap(
      state.cols,
      state.rows,
      combatantCount,
      state.style,
      state.seed + (state.round - 1) * 7,
      state.density
    );

    state.grid = grid;
    state.pickups = [];
    state.pendingPickups = [];
    state.healthSpawnCd = 2.5;
    state.turrets = [];
    state.beams = [];
    state.roundOver = false;
    state.roundWinner = null;
    state.roundTimer = 0;
    state.countdown = withCountdown ? 3.0 : 0;
    lastCountdownBeepSec = withCountdown ? 3 : 0;
    dirtyCells.clear();

    let aiCounter = 0;
    state.bots = spawns.map(([x, y, dir], i) => {
      if (state.netRole === 'host') {
        const isHost = i === 0;
        const guest = guestBySlot.get(i);
        if (!state.backfillBots && !isHost && !guest) return null;
        const isHuman = isHost || Boolean(guest);
        const name = isHost ? getCallsign() : guest ? guest.name : BOT_NAMES[aiCounter++ % BOT_NAMES.length];
        return {
          id: `b${i}`,
          slot: i,
          peerId: guest?.peerId || null,
          isHuman,
          isLocal: isHost,
          isP1: isHost,
          isP2: false,
          connected: true,
          name,
          colorIdx: i % theme.palette.length,
          color: theme.palette[i % theme.palette.length],
          x, y,
          rx: x, ry: y,
          dir,
          hp: 3,
          maxHp: 3,
          invuln: 0,
          fireCd: 0,
          turretCd: 0,
          overdrive: 0,
          aiTimer: 0.1 + i * 0.05,
          telegraph: 0,
        };
      }

      // Solo / 2P Local
      const isP1 = i === 0;
      const isP2 = i === 1 && state.mode2P;
      const aiIdx = state.mode2P ? i - 2 : i - 1;
      const name = isP1 ? 'YOU' : isP2 ? 'P2' : BOT_NAMES[aiIdx % BOT_NAMES.length];
      return {
        id: `b${i}`,
        slot: i,
        peerId: null,
        isHuman: isP1 || isP2,
        isLocal: isP1,
        isP1,
        isP2,
        connected: true,
        name,
        colorIdx: i % theme.palette.length,
        color: theme.palette[i % theme.palette.length],
        x, y,
        rx: x, ry: y,
        dir,
        hp: 3,
        maxHp: 3,
        invuln: 0,
        fireCd: 0,
        turretCd: 0,
        overdrive: 0,
        aiTimer: 0.1 + i * 0.05,
        telegraph: 0,
      };
    }).filter(Boolean);

    renderRoster();

    if (state.netRole === 'host') {
      net.sendSnapshot(buildSnapshotPayload(true));
    }
  }

  // --- Simulation Helpers ---
  function botAt(x, y, ignore) {
    return state.bots.find((b) => b !== ignore && b.hp > 0 && b.x === x && b.y === y);
  }

  function tryMoveStep(grid, bots, bot, dir, { isPrediction = false } = {}) {
    if (state.roundOver || state.countdown > 0 || bot.hp <= 0) return false;
    bot.dir = dir;
    const [dx, dy] = DIR_VEC[dir];
    const nx = bot.x + dx;
    const ny = bot.y + dy;
    if (nx < 0 || nx >= state.cols || ny < 0 || ny >= state.rows) return false;
    const cell = grid[ny][nx];
    if (cell === TILE.WALL) return false;
    if (bots.some((b) => b !== bot && b.hp > 0 && b.x === nx && b.y === ny)) return false;

    if (cell >= 2) {
      const bx = nx + dx;
      const by = ny + dy;
      if (bx < 0 || bx >= state.cols || by < 0 || by >= state.rows) return false;
      if (grid[by][bx] !== TILE.EMPTY) return false;
      if (bots.some((b) => b !== bot && b.hp > 0 && b.x === bx && b.y === by)) return false;
      grid[by][bx] = cell;
      grid[ny][nx] = TILE.EMPTY;
      if (!isPrediction) {
        markCellDirty(nx, ny);
        markCellDirty(bx, by);
        state.turrets = state.turrets.filter((t) => !(t.x === bx && t.y === by));
        emitSfx('push');
      } else {
        sfxPush();
      }
    }

    bot.x = nx;
    bot.y = ny;
    return true;
  }

  function moveBot(bot, dir) {
    const moved = tryMoveStep(state.grid, state.bots, bot, dir, { isPrediction: false });
    if (!moved) {
      markStateDirty();
      return false;
    }

    // Authoritative pickup collection
    for (let i = state.pickups.length - 1; i >= 0; i--) {
      const pk = state.pickups[i];
      if (pk.x === bot.x && pk.y === bot.y) {
        state.pickups.splice(i, 1);
        applyPickup(bot, pk.type);
      }
    }
    markStateDirty();
    return true;
  }

  function applyPickup(bot, type) {
    if (type === 'heal') {
      bot.hp = Math.min(bot.maxHp, bot.hp + 1);
    } else {
      bot.overdrive = 7.0;
    }
    emitSfx('pickup');
    markStateDirty();
    renderRoster();
  }

  function scheduleRandomHealthPickup() {
    const candidates = [];
    for (let y = 0; y < state.rows; y++) {
      for (let x = 0; x < state.cols; x++) {
        if (state.grid[y][x] !== TILE.EMPTY) continue;
        if (botAt(x, y, null)) continue;
        if (state.pickups.some((p) => p.x === x && p.y === y)) continue;
        if (state.pendingPickups.some((p) => p.x === x && p.y === y)) continue;
        if (state.turrets.some((t) => t.x === x && t.y === y)) continue;
        candidates.push([x, y]);
      }
    }
    if (!candidates.length) return;
    const [x, y] = candidates[Math.floor(Math.random() * candidates.length)];
    state.pendingPickups.push({ x, y, type: 'heal', duration: 3.0, remaining: 3.0 });
    markStateDirty();
  }

  function damageBot(target, dmg, attacker, tag) {
    if (target.hp <= 0 || target.invuln > 0) return;
    target.hp = Math.max(0, target.hp - dmg);
    target.invuln = 0.7;

    const gx = target.x + 0.5;
    const gy = target.y + 0.5;
    spawnParticlesGrid(gx, gy, target.color, 16, 6.2);
    triggerShake(6, 0.15);
    sfxHit();

    const ko = target.hp === 0;
    if (state.netRole === 'host') {
      net.sendEvent({
        t: 'hit',
        targetSlot: target.slot,
        attackerSlot: attacker ? attacker.slot : -1,
        gx,
        gy,
        color: target.color,
        ko,
      });
    }

    if (ko) {
      state.turrets = state.turrets.filter((t) => t.ownerId !== target.id);
      checkRoundEnd();
    }
    markStateDirty();
    renderRoster();
  }

  function checkRoundEnd() {
    if (state.bots.length < 2) return;
    const alive = state.bots.filter((b) => b.hp > 0);
    if (alive.length <= 1 && !state.roundOver) {
      state.roundOver = true;
      state.roundTimer = 2.0;
      if (alive.length === 1) {
        state.roundWinner = alive[0];
        state.wins[alive[0].id] = (state.wins[alive[0].id] || 0) + 1;
      } else {
        state.roundWinner = null;
      }
      markStateDirty();
      renderRoster();
    }
  }

  function detonateBoomCrate(bx, by, attacker) {
    const queue = [[bx, by]];
    const seen = new Set([`${bx},${by}`]);
    const boomCells = [];

    while (queue.length) {
      const [cx, cy] = queue.shift();
      state.grid[cy][cx] = TILE.EMPTY;
      markCellDirty(cx, cy);
      state.turrets = state.turrets.filter((t) => !(t.x === cx && t.y === cy));
      boomCells.push([cx, cy]);
      spawnParticlesGrid(cx + 0.5, cy + 0.5, theme.warning, 20, 7.2);

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= state.cols || ny < 0 || ny >= state.rows) continue;
          const cell = state.grid[ny][nx];
          if (cell === TILE.BOOM && !seen.has(`${nx},${ny}`)) {
            seen.add(`${nx},${ny}`);
            queue.push([nx, ny]);
          } else if (cell === TILE.CRATE_2 || cell === TILE.CRATE_1) {
            state.grid[ny][nx] = TILE.EMPTY;
            markCellDirty(nx, ny);
            spawnParticlesGrid(nx + 0.5, ny + 0.5, theme.palette[2], 8, 4.5);
          }
          for (const b of state.bots) {
            if (b.hp > 0 && b.x === nx && b.y === ny) {
              damageBot(b, 1, attacker, '(Boom)');
            }
          }
        }
      }
    }

    sfxBoom();
    triggerShake(8, 0.22);
    if (state.netRole === 'host') {
      net.sendEvent({ t: 'boom', cells: boomCells });
    }
    markStateDirty();
  }

  function fireLaserFrom(sx, sy, dir, attacker) {
    const baseColor = attacker ? attacker.color : theme.primary;
    const pts = [[sx + 0.5, sy + 0.5]];
    let x = sx;
    let y = sy;
    let d = dir;
    let bounces = 0;
    let supercharged = false;

    for (let step = 0; step < 80; step++) {
      const [dx, dy] = DIR_VEC[d];
      x += dx;
      y += dy;
      if (x < 0 || x >= state.cols || y < 0 || y >= state.rows) {
        pts.push([x + 0.5 - dx * 0.5, y + 0.5 - dy * 0.5]);
        break;
      }

      // Bot collision
      const hitBot = state.bots.find((b) => b.hp > 0 && b.x === x && b.y === y);
      if (hitBot && !(step === 0 && attacker && hitBot.id === attacker.id)) {
        pts.push([x + 0.5, y + 0.5]);
        damageBot(hitBot, supercharged ? 2 : 1, attacker, supercharged ? '(Mirror!)' : '');
        break;
      }

      const cell = state.grid[y][x];
      if (cell === TILE.WALL) {
        const ix = x + 0.5 - dx * 0.45;
        const iy = y + 0.5 - dy * 0.45;
        pts.push([ix, iy]);
        spawnParticlesGrid(ix, iy, baseColor, 5, 3.0);
        break;
      } else if (cell === TILE.CRATE_2 || cell === TILE.CRATE_1) {
        pts.push([x + 0.5 - dx * 0.4, y + 0.5 - dy * 0.4]);
        state.grid[y][x] = cell === TILE.CRATE_2 ? TILE.CRATE_1 : TILE.EMPTY;
        markCellDirty(x, y);
        spawnParticlesGrid(x + 0.5, y + 0.5, theme.palette[2], cell === TILE.CRATE_1 ? 12 : 6, 4.2);
        if (cell === TILE.CRATE_1 && Math.random() < 0.25) {
          state.pickups.push({ x, y, type: Math.random() < 0.55 ? 'heal' : 'overdrive' });
        }
        markStateDirty();
        break;
      } else if (cell === TILE.BOOM) {
        pts.push([x + 0.5, y + 0.5]);
        detonateBoomCrate(x, y, attacker);
        break;
      } else if (cell === TILE.MIRROR_FWD || cell === TILE.MIRROR_BWD) {
        pts.push([x + 0.5, y + 0.5]);
        spawnParticlesGrid(x + 0.5, y + 0.5, theme.mirror, 6, 3.8);
        emitSfx('mirror');
        d = reflectMirror(cell, d);
        supercharged = true;
        bounces++;
        if (bounces > 18) break;
      }
    }

    const beamColor = supercharged ? theme.mirror : baseColor;
    state.beams.push({
      pts,
      color: beamColor,
      life: 0.23,
      maxLife: 0.23,
      width: supercharged ? 4.5 : 3,
    });

    if (state.netRole === 'host') {
      net.sendEvent({
        t: 'beam',
        pts,
        colorIdx: attacker ? attacker.colorIdx : 0,
        supercharged,
      });
    }
  }

  function botFire(bot) {
    if (state.roundOver || state.countdown > 0 || bot.hp <= 0 || bot.fireCd > 0) return;
    bot.fireCd = bot.overdrive > 0 ? 0.16 : 0.36;
    emitSfx('laser');
    fireLaserFrom(bot.x, bot.y, bot.dir, bot);
    markStateDirty();
  }

  function botPlaceTurret(bot) {
    if (state.roundOver || state.countdown > 0 || bot.hp <= 0 || bot.turretCd > 0) return;
    bot.turretCd = 0.9;
    state.turrets = state.turrets.filter((t) => t.ownerId !== bot.id);
    state.turrets.push({
      x: bot.x,
      y: bot.y,
      dir: bot.dir,
      ownerId: bot.id,
      ownerSlot: bot.slot,
      ownerColorIdx: bot.colorIdx,
      owner: bot,
      timer: bot.overdrive > 0 ? 1.0 : 1.5,
    });
    emitSfx('turret');
    markStateDirty();
  }

  // --- AI Logic ---
  function scanShotDir(bot) {
    for (const startDir of DIRS) {
      let x = bot.x;
      let y = bot.y;
      let d = startDir;
      let bounces = 0;
      for (let step = 0; step < 30; step++) {
        const [dx, dy] = DIR_VEC[d];
        x += dx;
        y += dy;
        if (x < 0 || x >= state.cols || y < 0 || y >= state.rows) break;
        const target = state.bots.find((b) => b !== bot && b.hp > 0 && b.x === x && b.y === y);
        if (target) return startDir;
        const cell = state.grid[y][x];
        if (cell === TILE.WALL || cell === TILE.CRATE_2 || cell === TILE.CRATE_1 || cell === TILE.BOOM) break;
        if (cell === TILE.MIRROR_FWD || cell === TILE.MIRROR_BWD) {
          d = reflectMirror(cell, d);
          if (++bounces > 2) break;
        }
      }
    }
    return null;
  }

  function stepAI(bot, dt) {
    if (bot.isHuman || bot.hp <= 0 || state.roundOver || state.countdown > 0) return;
    if (bot.telegraph > 0) {
      bot.telegraph -= dt;
      if (bot.telegraph <= 0) botFire(bot);
      markStateDirty();
      return;
    }
    bot.aiTimer -= dt;
    if (bot.aiTimer > 0) return;
    bot.aiTimer = 0.2 + Math.random() * 0.14;

    const shotDir = bot.fireCd <= 0 ? scanShotDir(bot) : null;
    if (shotDir && Math.random() < 0.78) {
      bot.dir = shotDir;
      bot.telegraph = 0.2;
      markStateDirty();
      return;
    }

    let goal = null;
    let bestDist = 999;
    if (bot.hp <= 2) {
      for (const pk of state.pickups) {
        const dist = Math.abs(pk.x - bot.x) + Math.abs(pk.y - bot.y);
        if (dist < bestDist) { bestDist = dist; goal = pk; }
      }
      if (!goal) {
        for (const pp of state.pendingPickups) {
          if (pp.remaining > 2.0) continue;
          const dist = Math.abs(pp.x - bot.x) + Math.abs(pp.y - bot.y);
          if (dist < bestDist) { bestDist = dist; goal = pp; }
        }
      }
    }
    if (!goal) {
      for (const other of state.bots) {
        if (other === bot || other.hp <= 0) continue;
        const dist = Math.abs(other.x - bot.x) + Math.abs(other.y - bot.y);
        if (dist < bestDist) { bestDist = dist; goal = other; }
      }
    }
    if (!goal) return;

    const dx = goal.x - bot.x;
    const dy = goal.y - bot.y;
    const prefs = [];
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx !== 0) prefs.push(dx > 0 ? 'right' : 'left');
      if (dy !== 0) prefs.push(dy > 0 ? 'down' : 'up');
    } else {
      if (dy !== 0) prefs.push(dy > 0 ? 'down' : 'up');
      if (dx !== 0) prefs.push(dx > 0 ? 'right' : 'left');
    }
    for (const d of DIRS) if (!prefs.includes(d)) prefs.push(d);
    if (Math.random() < 0.22) {
      prefs.unshift(DIRS[Math.floor(Math.random() * 4)]);
    }

    for (const d of prefs) {
      if (moveBot(bot, d)) break;
    }

    if (Math.random() < 0.06 && !state.turrets.some((t) => t.ownerId === bot.id)) {
      botPlaceTurret(bot);
    }
  }

  // --- Host Serialization ---
  function serializeBots() {
    return state.bots.map((b) => [
      b.slot,
      b.x,
      b.y,
      DIR_TO_IDX[b.dir] ?? 0,
      b.hp,
      Number(b.invuln.toFixed(2)),
      Number(b.overdrive.toFixed(2)),
      Number(b.telegraph.toFixed(2)),
      b.name,
      b.colorIdx,
      b.isHuman ? 1 : 0,
      b.connected ? 1 : 0,
    ]);
  }

  function serializeTurrets() {
    return state.turrets.map((t) => [
      t.x,
      t.y,
      DIR_TO_IDX[t.dir] ?? 0,
      t.ownerSlot ?? 0,
      Number(t.timer.toFixed(2)),
    ]);
  }

  function serializePickups() {
    return state.pickups.map((p) => [p.x, p.y, p.type === 'heal' ? 0 : 1]);
  }

  function serializePending() {
    return state.pendingPickups.map((pp) => [
      pp.x,
      pp.y,
      Number(pp.remaining.toFixed(2)),
      Number(pp.duration.toFixed(2)),
    ]);
  }

  function buildAckMap() {
    const ack = {};
    for (const g of guestRoster.values()) {
      ack[g.slot] = g.lastSeq || 0;
    }
    return ack;
  }

  function buildSnapshotPayload(isRoundStart = false) {
    return {
      isRoundStart,
      cols: state.cols,
      rows: state.rows,
      botCount: state.botCount,
      style: state.style,
      density: state.density,
      seed: state.seed,
      round: state.round,
      grid: state.grid,
      bots: serializeBots(),
      tu: serializeTurrets(),
      pk: serializePickups(),
      pp: serializePending(),
      ro: [state.roundOver ? 1 : 0, state.roundWinner ? state.roundWinner.slot : -1, state.wins],
      cd: Number(state.countdown.toFixed(2)),
      ack: buildAckMap(),
      peers: buildPeersMeta(),
    };
  }

  function flushHostDelta(force = false) {
    if (state.netRole !== 'host') return;
    const now = performance.now();
    if (!force) {
      const dueDirty = deltaDirty && now - lastDeltaSentAt >= NET_CFG.TICK_MS;
      const duePeriodic = now - lastPeriodicSyncAt >= 200;
      if (!dueDirty && !duePeriodic) return;
    }
    lastDeltaSentAt = now;
    if (now - lastPeriodicSyncAt >= 200) lastPeriodicSyncAt = now;
    deltaDirty = false;

    const gDiff = [...dirtyCells.values()];
    dirtyCells.clear();

    net.sendDelta({
      ack: buildAckMap(),
      g: gDiff,
      b: serializeBots(),
      tu: serializeTurrets(),
      pk: serializePickups(),
      pp: serializePending(),
      ro: [state.roundOver ? 1 : 0, state.roundWinner ? state.roundWinner.slot : -1, state.round, state.wins],
      cd: Number(state.countdown.toFixed(2)),
      peers: buildPeersMeta(),
    });
    renderStatsPanel();
  }

  // --- Guest State Application + CSP Reconciliation ---
  function applyBotsFromNet(botRows, snapVisual) {
    const prevBySlot = new Map(state.bots.map((b) => [b.slot, b]));
    state.bots = botRows.map(([slot, x, y, dIdx, hp, invuln, overdrive, telegraph, name, colorIdx, isHuman, connected]) => {
      const prev = prevBySlot.get(slot);
      const isLocal = !state.spectating && slot === state.mySlot && Boolean(isHuman);
      const color = theme.palette[colorIdx % theme.palette.length];
      return {
        id: `b${slot}`,
        slot,
        peerId: null,
        isHuman: Boolean(isHuman),
        isLocal,
        isP1: isLocal,
        isP2: false,
        connected: Boolean(connected),
        name,
        colorIdx,
        color,
        x,
        y,
        rx: snapVisual || !prev ? x : prev.rx,
        ry: snapVisual || !prev ? y : prev.ry,
        dir: DIRS[dIdx] || 'right',
        hp,
        maxHp: 3,
        invuln,
        fireCd: 0,
        turretCd: 0,
        overdrive,
        aiTimer: 0,
        telegraph,
      };
    });

    const local = state.bots.find((b) => b.isLocal);
    if (local) {
      authLocalPos = { x: local.x, y: local.y, dir: local.dir };
      state.spectating = false;
    } else {
      authLocalPos = null;
      state.spectating = true;
    }
  }

  function applyTurretsAndPickups(tu, pk, pp) {
    state.turrets = (tu || []).map(([x, y, dIdx, ownerSlot, timer]) => {
      const owner = state.bots.find((b) => b.slot === ownerSlot) || null;
      return {
        x,
        y,
        dir: DIRS[dIdx] || 'right',
        ownerId: `b${ownerSlot}`,
        ownerSlot,
        ownerColorIdx: owner ? owner.colorIdx : ownerSlot % theme.palette.length,
        owner,
        timer,
      };
    });
    state.pickups = (pk || []).map(([x, y, typeCode]) => ({
      x,
      y,
      type: typeCode === 0 ? 'heal' : 'overdrive',
    }));
    state.pendingPickups = (pp || []).map(([x, y, remaining, duration]) => ({
      x,
      y,
      type: 'heal',
      remaining,
      duration,
    }));
  }

  function reconcileLocalPrediction(ackSeq) {
    if (ackSeq !== undefined) {
      pendingInputs = pendingInputs.filter((p) => p.seq > ackSeq);
    }
    // Reset grid to authoritative baseline then replay unacked local movement predictions
    state.grid = cloneGrid(authGrid);
    const local = state.bots.find((b) => b.slot === state.mySlot);
    if (local && authLocalPos) {
      local.x = authLocalPos.x;
      local.y = authLocalPos.y;
      local.dir = authLocalPos.dir;
      for (const p of pendingInputs) {
        tryMoveStep(state.grid, state.bots, local, p.dir, { isPrediction: true });
      }
    }
  }

  function applySnapshot(snap) {
    state.cols = snap.cols;
    state.rows = snap.rows;
    state.botCount = snap.botCount;
    state.style = snap.style;
    state.density = snap.density ?? 1.0;
    state.seed = snap.seed;
    state.round = snap.round;

    sizeSel.value = `${snap.cols}x${snap.rows}`;
    styleSel.value = snap.style;
    if (densityRange && densityVal) {
      const pct = Math.round(state.density * 100);
      densityRange.value = String(pct);
      densityVal.textContent = `${pct}%`;
    }
    seedLabel.textContent = `Seed #${snap.seed}`;
    roundLabel.textContent = `Round ${snap.round}`;

    authGrid = cloneGrid(snap.grid);
    state.grid = cloneGrid(authGrid);
    if (snap.isRoundStart) {
      state.spectating = false;
      pendingInputs = [];
      state.beams = [];
      state.particles = [];
      lastCountdownBeepSec = Math.ceil(snap.cd || 0);
    }

    applyBotsFromNet(snap.bots, Boolean(snap.isRoundStart));
    applyTurretsAndPickups(snap.tu, snap.pk, snap.pp);

    const [ro, winnerSlot, winsMap] = snap.ro || [0, -1, {}];
    state.roundOver = Boolean(ro);
    state.roundWinner = winnerSlot >= 0 ? state.bots.find((b) => b.slot === winnerSlot) || null : null;
    state.wins = winsMap || {};
    state.countdown = typeof snap.cd === 'number' ? snap.cd : 0;

    if (snap.peers) peerMetaList = snap.peers;

    if (!snap.isRoundStart) {
      reconcileLocalPrediction(snap.ack?.[state.mySlot]);
    }
    renderRoster();
  }

  function applyDelta(delta) {
    if (!authGrid.length) return;
    if (delta.peers) peerMetaList = delta.peers;
    if (delta.g && delta.g.length) {
      for (const [x, y, val] of delta.g) {
        if (authGrid[y] && authGrid[y][x] !== undefined) {
          authGrid[y][x] = val;
        }
      }
    }
    if (delta.b) {
      applyBotsFromNet(delta.b, false);
    }
    applyTurretsAndPickups(delta.tu, delta.pk, delta.pp);

    if (delta.ro) {
      const [ro, winnerSlot, round, winsMap] = delta.ro;
      state.roundOver = Boolean(ro);
      state.roundWinner = winnerSlot >= 0 ? state.bots.find((b) => b.slot === winnerSlot) || null : null;
      state.round = round;
      state.wins = winsMap || {};
      roundLabel.textContent = `Round ${state.round}`;
    }
    if (typeof delta.cd === 'number') {
      state.countdown = delta.cd;
    }

    reconcileLocalPrediction(delta.ack?.[state.mySlot]);
    renderRoster();
  }

  function applyNetEvent(ev) {
    if (!ev) return;
    if (ev.t === 'beam') {
      const baseColor = theme.palette[ev.colorIdx % theme.palette.length] || theme.primary;
      state.beams.push({
        pts: ev.pts,
        color: ev.supercharged ? theme.mirror : baseColor,
        life: 0.23,
        maxLife: 0.23,
        width: ev.supercharged ? 4.5 : 3,
      });
    } else if (ev.t === 'boom') {
      sfxBoom();
      triggerShake(8, 0.22);
      for (const [cx, cy] of ev.cells || []) {
        spawnParticlesGrid(cx + 0.5, cy + 0.5, theme.warning, 18, 7.0);
      }
    } else if (ev.t === 'hit') {
      sfxHit();
      triggerShake(6, 0.15);
      spawnParticlesGrid(ev.gx, ev.gy, ev.color || theme.error, 16, 6.2);
    } else if (ev.t === 'sfx') {
      playSfxKind(ev.kind);
    }
  }

  // --- Update Loop (Visual + Authoritative Sim) ---
  function updateVisuals(dt) {
    for (const b of state.bots) {
      const speed = b.isLocal && state.netRole === 'guest' ? 30 : 24;
      const k = Math.min(1, dt * speed);
      b.rx += (b.x - b.rx) * k;
      b.ry += (b.y - b.ry) * k;
    }

    for (let i = state.beams.length - 1; i >= 0; i--) {
      state.beams[i].life -= dt;
      if (state.beams[i].life <= 0) state.beams.splice(i, 1);
    }

    if (state.shakeTime > 0) {
      state.shakeTime = Math.max(0, state.shakeTime - dt);
      if (state.shakeTime === 0) state.shakeAmp = 0;
    }

    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.gx += p.vx * dt;
      p.gy += p.vy * dt;
      p.vx *= 0.91;
      p.vy *= 0.91;
      p.life -= dt;
      if (p.life <= 0) state.particles.splice(i, 1);
    }
  }

  function updateAuthoritative(dt) {
    if (state.roundOver) {
      state.roundTimer -= dt;
      if (state.roundTimer <= 0) {
        state.round++;
        startRound(false, true);
        return;
      }
    }

    if (state.countdown > 0) {
      state.countdown = Math.max(0, state.countdown - dt);
      const nextSec = Math.ceil(state.countdown);
      if (state.countdown === 0) {
        if (lastCountdownBeepSec > 0) {
          lastCountdownBeepSec = 0;
          sfxCountdownGo();
        }
        markStateDirty();
        if (state.netRole === 'host') flushHostDelta(true);
      } else if (nextSec < lastCountdownBeepSec) {
        lastCountdownBeepSec = nextSec;
        sfxCountdownTick();
        markStateDirty();
      }
      return;
    }

    for (const b of state.bots) {
      if (b.invuln > 0) b.invuln = Math.max(0, b.invuln - dt);
      if (b.fireCd > 0) b.fireCd = Math.max(0, b.fireCd - dt);
      if (b.turretCd > 0) b.turretCd = Math.max(0, b.turretCd - dt);
      if (b.overdrive > 0) {
        b.overdrive = Math.max(0, b.overdrive - dt);
        if (b.overdrive === 0) {
          markStateDirty();
          renderRoster();
        }
      }
      stepAI(b, dt);
    }

    for (const t of state.turrets) {
      t.timer -= dt;
      if (t.timer <= 0) {
        t.timer = t.owner?.overdrive > 0 ? 1.25 : 2.1;
        if (!state.roundOver) {
          emitSfx('laser');
          fireLaserFrom(t.x, t.y, t.dir, t.owner);
        }
        markStateDirty();
      }
    }

    if (!state.roundOver) {
      state.healthSpawnCd -= dt;
      const totalHealth = state.pickups.filter((p) => p.type === 'heal').length + state.pendingPickups.length;
      const maxHealth = state.cols >= 27 ? 4 : 3;
      if (state.healthSpawnCd <= 0) {
        state.healthSpawnCd = 4.5 + Math.random() * 3.5;
        if (totalHealth < maxHealth) scheduleRandomHealthPickup();
      }
      for (let i = state.pendingPickups.length - 1; i >= 0; i--) {
        const pp = state.pendingPickups[i];
        pp.remaining -= dt;
        if (pp.remaining <= 0) {
          state.pendingPickups.splice(i, 1);
          if (state.grid[pp.y][pp.x] === TILE.EMPTY) {
            spawnParticlesGrid(pp.x + 0.5, pp.y + 0.5, theme.success, 10, 4.0);
            const occupant = botAt(pp.x, pp.y, null);
            if (occupant) {
              applyPickup(occupant, 'heal');
            } else {
              state.pickups.push({ x: pp.x, y: pp.y, type: 'heal' });
              emitSfx('healSpawn');
            }
          }
          markStateDirty();
        }
      }
    }
  }

  function update(dt) {
    lastSimStepAt = performance.now();
    updateVisuals(dt);
    stepHeldMovement(lastSimStepAt);

    if (state.netRole !== 'guest') {
      updateAuthoritative(dt);
      if (state.netRole === 'host') {
        flushHostDelta(false);
      }
    } else {
      // Guest smoothly interpolates countdown & local pending countdown visuals
      if (state.countdown > 0) {
        state.countdown = Math.max(0, state.countdown - dt);
        const nextSec = Math.ceil(state.countdown);
        if (state.countdown === 0 && lastCountdownBeepSec > 0) {
          lastCountdownBeepSec = 0;
          sfxCountdownGo();
        } else if (nextSec > 0 && nextSec < lastCountdownBeepSec) {
          lastCountdownBeepSec = nextSec;
          sfxCountdownTick();
        }
      }
      for (const pp of state.pendingPickups) {
        pp.remaining = Math.max(0, pp.remaining - dt);
      }
      for (const t of state.turrets) {
        t.timer = Math.max(0, t.timer - dt);
      }
    }
  }

  // Host background-tab watchdog so rAF throttling never stalls Guests
  setInterval(() => {
    if (state.netRole !== 'host') return;
    const now = performance.now();
    const gap = now - lastSimStepAt;
    if (gap > 65) {
      const dt = Math.min(0.05, gap / 1000);
      update(dt);
    }
  }, 45);

  // --- WebRTC Networking Setup ---
  function findFreeGuestSlot() {
    const used = new Set([0]);
    for (const g of guestRoster.values()) used.add(g.slot);
    for (let s = 1; s < NET_CFG.MAX_PLAYERS; s++) {
      if (!used.has(s)) return s;
    }
    return -1;
  }

  function updateNetUI({ role, roomCode, text, tone, rttMs, natType }) {
    const toneClass =
      tone === 'success'
        ? 'border-[var(--success)]/50 text-[var(--success)] bg-[var(--success)]/10'
        : tone === 'warning'
        ? 'border-[var(--warning)]/50 text-[var(--warning)] bg-[var(--warning)]/10'
        : tone === 'error'
        ? 'border-[var(--error)]/50 text-[var(--error)] bg-[var(--error)]/10'
        : 'border-[var(--border)] text-[var(--muted-foreground)] bg-[var(--background)]';

    const rttPart = role === 'guest' && typeof rttMs === 'number' && rttMs >= 0 ? ` · ${rttMs}ms` : '';
    const natPart = natType ? ` · ${natType}` : '';
    netPillEl.className = `px-2.5 py-1 rounded-md text-xs font-mono border ${toneClass}`;
    netPillEl.textContent = `${text}${rttPart}${natPart}`;

    const isOnline = role === 'host' || role === 'guest';
    lobbyControlsEl.classList.toggle('hidden', isOnline);
    roomActiveEl.classList.toggle('hidden', !isOnline);

    if (isOnline && roomCode) {
      roomBadgeEl.textContent = `${role === 'host' ? 'HOST' : 'ROOM'} · ${roomCode}`;
    }

    backfillBtn.classList.toggle('hidden', role !== 'host');
    p2Btn.classList.toggle('hidden', isOnline);

    // Only Host (or Solo) edits arena rules
    const disableConfig = role === 'guest';
    sizeSel.disabled = disableConfig;
    botsSel.disabled = disableConfig;
    styleSel.disabled = disableConfig;
    densityRange.disabled = disableConfig;
    newMapBtn.disabled = disableConfig;
    replayBtn.disabled = disableConfig;
    for (const el of [sizeSel, botsSel, styleSel, densityRange, newMapBtn, replayBtn]) {
      el.classList.toggle('opacity-50', disableConfig);
      el.classList.toggle('cursor-not-allowed', disableConfig);
    }
  }

  function showNetBanner(msg, showHostBtn = false) {
    netBannerMsgEl.textContent = msg;
    netBannerHostBtn.classList.toggle('hidden', !showHostBtn);
    netBannerEl.classList.remove('hidden');
  }

  function hideNetBanner() {
    netBannerEl.classList.add('hidden');
  }

  const net = createNetClient({
    onStatus: (status) => {
      if (status.natType) netTraffic.natType = status.natType;
      if (typeof status.txRate === 'number') netTraffic.txRate = status.txRate;
      if (typeof status.rxRate === 'number') netTraffic.rxRate = status.rxRate;
      if (state.netRole === 'guest' && typeof status.rttMs === 'number') {
        const me = peerMetaList.find((p) => p[0] === state.mySlot);
        if (me) me[2] = status.rttMs;
      }
      updateNetUI(status);
      renderStatsPanel();
      if (status.phase === 'blocked') {
        showNetBanner(status.text, false);
      } else if (status.phase === 'connected' || status.phase === 'hosting') {
        hideNetBanner();
      }
    },

    onTrafficRate: ({ txRate, rxRate }) => {
      netTraffic.txRate = txRate;
      netTraffic.rxRate = rxRate;
      renderStatsPanel();
    },

    onPeerStats: (peerStats) => {
      for (const [peerId, info] of Object.entries(peerStats || {})) {
        const entry = guestRoster.get(peerId);
        if (entry) {
          entry.pingMs = info.rttMs;
          entry.natType = info.natType;
        }
      }
      markStateDirty();
      renderRoster();
    },

    onGuestHello: (peerId, data) => {
      let entry = guestRoster.get(peerId);
      if (!entry) {
        const slot = findFreeGuestSlot();
        if (slot === -1) {
          return { error: `Room full (max ${NET_CFG.MAX_PLAYERS} players)` };
        }
        const safeName = String(data?.name || `P${slot + 1}`).trim().toUpperCase().slice(0, 10) || `P${slot + 1}`;
        entry = { peerId, slot, name: safeName, lastSeq: 0, spectating: true, pingMs: null, natType: 'P2P' };
        guestRoster.set(peerId, entry);
      }

      const humanCountBefore = guestRoster.size; // includes this new guest

      // If Host was warming up solo with bots (only 1 human before this guest), start fresh immediately
      if (humanCountBefore === 1) {
        state.wins = {};
        startRound(false);
        entry.spectating = false;
      }

      return {
        welcomePayload: {
          mySlot: entry.slot,
          spectating: entry.spectating,
          snapshot: buildSnapshotPayload(false),
        },
      };
    },

    onGuestInput: (peerId, pkt) => {
      const entry = guestRoster.get(peerId);
      if (!entry) return;
      if (typeof pkt.s === 'number' && pkt.s > entry.lastSeq) {
        entry.lastSeq = pkt.s;
      }
      if (entry.spectating) return;
      const bot = state.bots.find((b) => b.slot === entry.slot);
      if (!bot || bot.hp <= 0 || state.roundOver || state.countdown > 0) {
        markStateDirty();
        return;
      }
      if (pkt.a === 'm') {
        const dir = DIRS[pkt.d];
        if (dir) moveBot(bot, dir);
      } else if (pkt.a === 'f') {
        botFire(bot);
      } else if (pkt.a === 't') {
        botPlaceTurret(bot);
      }
      flushHostDelta(true);
    },

    onGuestLeave: (peerId) => {
      const entry = guestRoster.get(peerId);
      if (!entry) return;
      guestRoster.delete(peerId);
      const bot = state.bots.find((b) => b.slot === entry.slot);
      if (bot) {
        bot.connected = false;
        if (bot.hp > 0) {
          bot.hp = 0;
          state.turrets = state.turrets.filter((t) => t.ownerId !== bot.id);
          checkRoundEnd();
        }
      }
      markStateDirty();
      renderRoster();
      flushHostDelta(true);
    },

    onWelcome: (data) => {
      state.mySlot = data.mySlot;
      state.spectating = Boolean(data.spectating);
      pendingInputs = [];
      applySnapshot(data.snapshot);
    },

    onSnapshot: (snap) => {
      applySnapshot(snap);
    },

    onDelta: (delta) => {
      applyDelta(delta);
    },

    onEvent: (ev) => {
      applyNetEvent(ev);
    },

    onHostDisconnected: (reason) => {
      showNetBanner(`${reason}. You can return to Solo or host a new room.`, true);
    },
  });

  async function returnToSolo() {
    hideNetBanner();
    guestRoster.clear();
    peerMetaList = [];
    netTraffic = { txRate: 0, rxRate: 0, natType: '' };
    pendingInputs = [];
    authGrid = [];
    authLocalPos = null;
    await net.leave();
    state.netRole = 'solo';
    state.mySlot = 0;
    state.spectating = false;
    state.wins = {};
    startRound(true);
    refocus();
  }

  async function startHosting() {
    hideNetBanner();
    guestRoster.clear();
    peerMetaList = [];
    netTraffic = { txRate: 0, rxRate: 0, natType: 'Host' };
    pendingInputs = [];
    state.netRole = 'host';
    state.mySlot = 0;
    state.spectating = false;
    state.mode2P = false;
    p2Btn.textContent = '1P + Bots';
    p2HintEl.classList.add('hidden');
    state.wins = {};
    startRound(true);

    const res = await net.hostRoom({
      name: getCallsign(),
      chosenStrategy: relaySel.value,
    });
    if (!res.ok) {
      state.netRole = 'solo';
      showNetBanner(res.error || 'Could not start room', false);
      return;
    }
    refocus();
  }

  async function startJoining(code) {
    const clean = sanitizeRoomCode(code);
    if (clean.length < 3) {
      roomInput.focus();
      return;
    }
    hideNetBanner();
    guestRoster.clear();
    peerMetaList = [];
    netTraffic = { txRate: 0, rxRate: 0, natType: '' };
    pendingInputs = [];
    authGrid = [];
    authLocalPos = null;
    state.netRole = 'guest';
    state.mySlot = -1;
    state.spectating = true;
    state.mode2P = false;
    renderStatsPanel();
    p2HintEl.classList.add('hidden');

    const res = await net.joinRoom({
      code: clean,
      name: getCallsign(),
      chosenStrategy: relaySel.value,
    });
    if (!res.ok) {
      showNetBanner(res.error || 'Failed to join room', false);
    }
    refocus();
  }

  // --- Controls & UI Wiring ---
  const KEY_TO_DIR = { ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down' };
  const WASD_TO_DIR = { KeyA: 'left', KeyW: 'up', KeyD: 'right', KeyS: 'down' };

  function getControlledBot(slotKind) {
    if (slotKind === 'p2') {
      return state.netRole === 'solo' && state.mode2P ? state.bots[1] : null;
    }
    if (state.netRole === 'guest') {
      return state.bots.find((b) => b.slot === state.mySlot) || null;
    }
    const p1 = state.bots[0];
    return p1 && p1.isHuman ? p1 : null;
  }

  function executeHumanAction(slotKind, act, now) {
    const bot = getControlledBot(slotKind);
    if (!bot || bot.hp <= 0 || state.roundOver || state.countdown > 0) return;

    if (slotKind === 'p1' && state.netRole === 'guest') {
      const seq = ++inputSeq;
      if (act.a === 'm') {
        state.lastP1Move = now;
        net.sendInput({ s: seq, a: 'm', d: DIR_TO_IDX[act.dir] });
        if (pendingInputs.length < 30) pendingInputs.push({ seq, dir: act.dir });
        tryMoveStep(state.grid, state.bots, bot, act.dir, { isPrediction: true });
      } else {
        net.sendInput({ s: seq, a: act.a });
      }
      return;
    }

    if (act.a === 'm') {
      if (slotKind === 'p1') state.lastP1Move = now;
      else state.lastP2Move = now;
      moveBot(bot, act.dir);
    } else if (act.a === 'f') {
      botFire(bot);
    } else if (act.a === 't') {
      botPlaceTurret(bot);
    }
    if (state.netRole === 'host') flushHostDelta(true);
  }

  function stepHeldMovement(now) {
    if (state.roundOver || state.countdown > 0) return;
    for (const [slotKind, held] of [
      ['p1', p1HeldDirs],
      ['p2', p2HeldDirs],
    ]) {
      if (held.length === 0) continue;
      const lastMove = slotKind === 'p1' ? state.lastP1Move : state.lastP2Move;
      if (now - lastMove >= HOLD_REPEAT_MS) {
        executeHumanAction(slotKind, { a: 'm', dir: held[held.length - 1] }, now);
      }
    }
  }

  function pushHeldDir(list, dir) {
    const idx = list.indexOf(dir);
    if (idx !== -1) list.splice(idx, 1);
    list.push(dir);
  }

  function removeHeldDir(list, dir) {
    const idx = list.indexOf(dir);
    if (idx !== -1) list.splice(idx, 1);
  }

  window.addEventListener('keyup', (e) => {
    const dir = KEY_TO_DIR[e.key];
    if (dir) removeHeldDir(p1HeldDirs, dir);
    const d2 = WASD_TO_DIR[e.code];
    if (d2) removeHeldDir(p2HeldDirs, d2);
  });

  window.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', ' ', 'Spacebar'].includes(e.key)) {
      e.preventDefault();
    }
    ensureAudio();
    setFocusUI(true);
    const now = performance.now();

    if (e.code === 'KeyN' && !e.repeat && state.netRole !== 'guest') {
      startRound(true);
      return;
    }
    if (e.code === 'KeyR' && !e.repeat && state.netRole !== 'guest') {
      startRound(false);
      return;
    }

    const dir = KEY_TO_DIR[e.key];
    if (dir && !e.repeat) {
      recordMoveKey();
      pushHeldDir(p1HeldDirs, dir);
      executeHumanAction('p1', { a: 'm', dir }, now);
    }
    if ((e.code === 'Space' || e.key === ' ') && !e.repeat) {
      executeHumanAction('p1', { a: 'f' }, now);
    }
    if ((e.key === 'Shift' || e.code === 'KeyX' || e.code === 'Enter') && !e.repeat) {
      executeHumanAction('p1', { a: 't' }, now);
    }

    if (state.netRole === 'solo' && state.mode2P) {
      const d2 = WASD_TO_DIR[e.code];
      if (d2 && !e.repeat) {
        recordMoveKey();
        pushHeldDir(p2HeldDirs, d2);
        executeHumanAction('p2', { a: 'm', dir: d2 }, now);
      }
      if (e.code === 'KeyF' && !e.repeat) {
        executeHumanAction('p2', { a: 'f' }, now);
      }
      if (e.code === 'KeyG' && !e.repeat) {
        executeHumanAction('p2', { a: 't' }, now);
      }
    }
  });

  function refocus() {
    app.focus({ preventScroll: true });
    setFocusUI(true);
  }

  sizeSel.addEventListener('change', () => {
    if (state.netRole === 'guest') return;
    const [c, r] = sizeSel.value.split('x').map(Number);
    state.cols = c;
    state.rows = r;
    state.wins = {};
    startRound(true);
    sizeSel.blur();
    refocus();
  });

  botsSel.addEventListener('change', () => {
    if (state.netRole === 'guest') return;
    state.botCount = Number(botsSel.value);
    state.wins = {};
    startRound(true);
    botsSel.blur();
    refocus();
  });

  styleSel.addEventListener('change', () => {
    if (state.netRole === 'guest') return;
    state.style = styleSel.value;
    state.wins = {};
    startRound(true);
    styleSel.blur();
    refocus();
  });

  densityRange.addEventListener('input', () => {
    densityVal.textContent = `${densityRange.value}%`;
  });

  densityRange.addEventListener('change', () => {
    if (state.netRole === 'guest') return;
    state.density = Number(densityRange.value) / 100;
    startRound(false);
    densityRange.blur();
    refocus();
  });

  p2Btn.addEventListener('click', () => {
    if (state.netRole !== 'solo') return;
    state.mode2P = !state.mode2P;
    p2Btn.textContent = state.mode2P ? '2P Local + Bots' : '1P + Bots';
    p2HintEl.classList.toggle('hidden', !state.mode2P);
    state.wins = {};
    startRound(false);
    p2Btn.blur();
    refocus();
  });

  newMapBtn.addEventListener('click', () => {
    if (state.netRole === 'guest') return;
    startRound(true);
    newMapBtn.blur();
    refocus();
  });

  replayBtn.addEventListener('click', () => {
    if (state.netRole === 'guest') return;
    startRound(false);
    replayBtn.blur();
    refocus();
  });

  soundBtn.addEventListener('click', () => {
    setSoundEnabled(!isSoundEnabled());
    soundBtn.textContent = isSoundEnabled() ? 'SFX: On' : 'SFX: Off';
    soundBtn.blur();
    refocus();
  });

  // Multiplayer UI events
  hostBtn.addEventListener('click', () => {
    hostBtn.blur();
    startHosting();
  });

  joinBtn.addEventListener('click', () => {
    joinBtn.blur();
    startJoining(roomInput.value);
  });

  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startJoining(roomInput.value);
    }
  });

  roomInput.addEventListener('input', () => {
    roomInput.value = sanitizeRoomCode(roomInput.value);
  });

  copyLinkBtn.addEventListener('click', async () => {
    const url = buildInviteUrl(net.getRoomCode());
    try {
      await navigator.clipboard.writeText(url);
      copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => { copyLinkBtn.textContent = 'Copy URL'; }, 1600);
    } catch {
      window.prompt('Copy invite link:', url);
    }
    copyLinkBtn.blur();
    refocus();
  });

  backfillBtn.addEventListener('click', () => {
    if (state.netRole !== 'host') return;
    state.backfillBots = !state.backfillBots;
    backfillBtn.textContent = state.backfillBots ? 'AI Bots: On' : 'AI Bots: Off';
    state.wins = {};
    startRound(false);
    backfillBtn.blur();
    refocus();
  });

  leaveBtn.addEventListener('click', () => {
    leaveBtn.blur();
    returnToSolo();
  });

  netBannerSoloBtn.addEventListener('click', () => {
    netBannerSoloBtn.blur();
    returnToSolo();
  });

  netBannerHostBtn.addEventListener('click', () => {
    netBannerHostBtn.blur();
    startHosting();
  });

  iceBtn.addEventListener('click', () => {
    iceDrawer.classList.toggle('hidden');
    iceBtn.blur();
  });

  tutorialBtn.addEventListener('click', () => {
    const collapsed = tutorialBody.classList.toggle('hidden');
    tutorialToggleLbl.textContent = collapsed ? 'Show' : 'Hide';
    tutorialBtn.blur();
    refocus();
  });

  iceSaveBtn.addEventListener('click', () => {
    const res = saveIceJson(iceTextarea.value);
    if (res.ok) {
      iceMsgEl.textContent = 'Saved locally. Reconnect room to apply.';
      iceMsgEl.className = 'text-[11px] font-mono text-[var(--success)]';
    } else {
      iceMsgEl.textContent = res.error;
      iceMsgEl.className = 'text-[11px] font-mono text-[var(--error)]';
    }
  });

  // --- Start & Main Loop ---
  startRound(true, true);
  updateNetUI({ role: 'solo', roomCode: '', text: 'Solo', tone: 'neutral', rttMs: null, natType: '' });

  const inviteCode = getRoomFromUrl();
  if (inviteCode) {
    roomInput.value = inviteCode;
    startJoining(inviteCode);
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    updateKps(now);
    update(dt);
    renderer.draw(state, theme);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
