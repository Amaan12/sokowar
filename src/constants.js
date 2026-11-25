export const DIRS = ['left', 'up', 'right', 'down'];

export const DIR_VEC = {
  left: [-1, 0],
  up: [0, -1],
  right: [1, 0],
  down: [0, 1],
};

export const DIR_TO_IDX = {
  left: 0,
  up: 1,
  right: 2,
  down: 3,
};

// Tile codes: 0 empty, 1 wall, 2 crate (2hp), 3 crate (1hp), 4 mirror '/', 5 mirror '\', 6 boom crate
export const TILE = {
  EMPTY: 0,
  WALL: 1,
  CRATE_2: 2,
  CRATE_1: 3,
  MIRROR_FWD: 4,
  MIRROR_BWD: 5,
  BOOM: 6,
};

export const BOT_NAMES = ['EMBER', 'SOLAR', 'MINT', 'VIPER', 'COBALT', 'NEON', 'APEX'];

export const NET_CFG = {
  APP_ID: 'amaan12-sokowar-v1',
  PROTOCOL: 1,
  MAX_PLAYERS: 8,
  TICK_MS: 40,          // 25 Hz authoritative state delta cap
  HEARTBEAT_MS: 1500,
  HOST_TIMEOUT_MS: 6000,
  ICE_TIMEOUT_MS: 10000,
  ROOM_CHARS: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  ROOM_LEN: 5,
};

export const DEFAULT_ICE_SERVERS = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:global.stun.twilio.com:3478',
    ],
  },
];
