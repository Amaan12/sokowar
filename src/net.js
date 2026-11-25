import { DEFAULT_ICE_SERVERS, NET_CFG } from './constants.js';

const STRATEGY_URLS = {
  nostr: 'https://esm.sh/@trystero-p2p/nostr@0.27.0',
  mqtt: 'https://esm.sh/@trystero-p2p/mqtt@0.27.0',
};

const ICE_STORAGE_KEY = 'sokowar_ice_json';

export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < NET_CFG.ROOM_LEN; i++) {
    code += NET_CFG.ROOM_CHARS[Math.floor(Math.random() * NET_CFG.ROOM_CHARS.length)];
  }
  return code;
}

export function sanitizeRoomCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

export function getRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = sanitizeRoomCode(params.get('room'));
  return code.length >= 3 ? code : '';
}

export function buildInviteUrl(code) {
  const url = new URL(window.location.href);
  if (code) {
    url.searchParams.set('room', code);
  } else {
    url.searchParams.delete('room');
  }
  return url.toString();
}

export function setRoomInUrl(code) {
  try {
    const nextUrl = buildInviteUrl(code);
    window.history.replaceState({}, '', nextUrl);
  } catch {
    // Ignore history restrictions in sandboxed environments
  }
}

export function getSavedIceJson() {
  try {
    return localStorage.getItem(ICE_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function saveIceJson(raw) {
  try {
    const trimmed = String(raw || '').trim();
    if (!trimmed) {
      localStorage.removeItem(ICE_STORAGE_KEY);
      return { ok: true, iceServers: DEFAULT_ICE_SERVERS };
    }
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      if (!item || (!item.urls && !item.url)) {
        throw new Error('Each ICE entry must have a "urls" field');
      }
    }
    localStorage.setItem(ICE_STORAGE_KEY, trimmed);
    return { ok: true, iceServers: [...DEFAULT_ICE_SERVERS, ...list] };
  } catch (err) {
    return { ok: false, error: err.message || 'Invalid ICE JSON' };
  }
}

function getActiveIceServers() {
  const raw = getSavedIceJson();
  if (!raw) return DEFAULT_ICE_SERVERS;
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return [...DEFAULT_ICE_SERVERS, ...list];
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

async function inspectPeerNat(peerInfo) {
  const pc = peerInfo?.connection;
  if (!pc || typeof pc.getStats !== 'function') {
    return peerInfo?.direct === false ? 'Relayed (Mesh)' : 'P2P';
  }
  try {
    const stats = await pc.getStats();
    let localType = '';
    let remoteType = '';
    let nominatedPair = null;
    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        nominatedPair = stats.get(report.selectedCandidatePairId);
      }
    });
    if (!nominatedPair) {
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
          nominatedPair = report;
        }
      });
    }
    if (nominatedPair) {
      localType = stats.get(nominatedPair.localCandidateId)?.candidateType || '';
      remoteType = stats.get(nominatedPair.remoteCandidateId)?.candidateType || '';
    }
    if (localType === 'relay' || remoteType === 'relay') return 'TURN Relay';
    if (localType === 'srflx' || remoteType === 'srflx' || localType === 'prflx' || remoteType === 'prflx') {
      return 'STUN NAT';
    }
    if (localType === 'host' && remoteType === 'host') return 'Direct LAN';
    return 'Direct P2P';
  } catch {
    return 'P2P';
  }
}

/**
 * Creates a serverless WebRTC P2P network controller backed by Trystero.
 */
export function createNetClient(handlers) {
  let room = null;
  let role = 'solo'; // 'solo' | 'host' | 'guest'
  let strategy = 'nostr';
  let roomCode = '';
  let selfPeerId = '';
  let hostPeerId = '';
  let playerName = 'YOU';
  let lastHostMsgAt = 0;
  let joinTimer = null;
  let monitorTimer = null;
  let hbTimer = null;
  let act = null;
  let connectedPeers = new Set();
  let iceFailedPeers = new Set();
  let peerLatencyCache = new Map(); // peerId -> { rttMs, natType }
  let txCountWindow = 0;
  let rxCountWindow = 0;
  let txRate = 0;
  let rxRate = 0;
  let rateTimer = null;

  function emitStatus(status) {
    handlers.onStatus?.({
      role,
      strategy,
      roomCode,
      peerCount: connectedPeers.size,
      txRate,
      rxRate,
      ...status,
    });
  }

  function clearTimers() {
    if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
  }

  async function leave() {
    clearTimers();
    const prevRoom = room;
    room = null;
    act = null;
    role = 'solo';
    roomCode = '';
    selfPeerId = '';
    hostPeerId = '';
    txCountWindow = 0;
    rxCountWindow = 0;
    txRate = 0;
    rxRate = 0;
    connectedPeers.clear();
    iceFailedPeers.clear();
    peerLatencyCache.clear();
    if (prevRoom) {
      try {
        await prevRoom.leave();
      } catch {
        // Ignore cleanup errors
      }
    }
    setRoomInUrl('');
    emitStatus({ phase: 'solo', text: 'Solo', tone: 'neutral', rttMs: null, natType: '' });
  }

  async function connect({ targetRole, code, name, chosenStrategy = strategy }) {
    await leave();

    role = targetRole;
    strategy = chosenStrategy === 'mqtt' ? 'mqtt' : 'nostr';
    roomCode = sanitizeRoomCode(code) || generateRoomCode();
    playerName = (name || 'PLAYER').trim().slice(0, 10) || 'PLAYER';

    emitStatus({
      phase: 'signaling',
      text: `Connecting via ${strategy.toUpperCase()}...`,
      tone: 'warning',
      rttMs: null,
      natType: '',
    });

    try {
      const modUrl = STRATEGY_URLS[strategy];
      const { joinRoom } = await import(modUrl);
      const iceServers = getActiveIceServers();

      room = joinRoom(
        {
          appId: NET_CFG.APP_ID,
          rtcConfig: { iceServers },
        },
        `sokowar-v${NET_CFG.PROTOCOL}-${roomCode}`
      );

      const selfInfo = await room.getSelf();
      selfPeerId = selfInfo.peerId;

      act = {
        hello: room.makeAction('hello'),
        welcome: room.makeAction('welcome'),
        reject: room.makeAction('reject'),
        input: room.makeAction('in'),
        snap: room.makeAction('snap'),
        delta: room.makeAction('delta'),
        ev: room.makeAction('ev'),
        hb: room.makeAction('hb'),
      };

      setRoomInUrl(roomCode);

      rateTimer = setInterval(() => {
        txRate = txCountWindow;
        rxRate = rxCountWindow;
        txCountWindow = 0;
        rxCountWindow = 0;
        handlers.onTrafficRate?.({ txRate, rxRate });
      }, 1000);

      room.onError((err) => {
        const msg = err?.message || 'Signaling/WebRTC error';
        emitStatus({ phase: 'error', text: msg, tone: 'error', rttMs: null, natType: '' });
      });

      const wirePeerConnectionDiagnostics = (peerId) => {
        const peerInfo = room?.getPeers?.()?.[peerId];
        const pc = peerInfo?.connection;
        if (!pc) return;
        const onIceChange = () => {
          const st = pc.iceConnectionState || pc.connectionState;
          if (st === 'failed') {
            iceFailedPeers.add(peerId);
            if (role === 'guest' && !hostPeerId) {
              emitStatus({
                phase: 'blocked',
                text: 'NAT/Firewall blocked direct P2P (try MQTT or TURN)',
                tone: 'error',
                rttMs: null,
                natType: 'Blocked',
              });
            }
          }
        };
        pc.addEventListener?.('iceconnectionstatechange', onIceChange);
        pc.addEventListener?.('connectionstatechange', onIceChange);
      };

      if (role === 'host') {
        emitStatus({
          phase: 'hosting',
          text: `Hosting ${roomCode} (0 guests)`,
          tone: 'success',
          rttMs: 0,
          natType: 'Host',
        });

        room.onPeerJoin((info) => {
          const peerId = info?.peerId || info;
          connectedPeers.add(peerId);
          wirePeerConnectionDiagnostics(peerId);
        });

        room.onPeerLeave((info) => {
          const peerId = info?.peerId || info;
          connectedPeers.delete(peerId);
          iceFailedPeers.delete(peerId);
          peerLatencyCache.delete(peerId);
          handlers.onGuestLeave?.(peerId);
          emitStatus({
            phase: 'hosting',
            text: `Hosting ${roomCode} (${connectedPeers.size} peer${connectedPeers.size === 1 ? '' : 's'})`,
            tone: 'success',
            rttMs: 0,
            natType: 'Host',
          });
        });

        const sampleHostPeers = async () => {
          if (!room || role !== 'host') return;
          const peersMap = room.getPeers?.() || {};
          const ids = Object.keys(peersMap);
          await Promise.allSettled(
            ids.map(async (pid) => {
              const prev = peerLatencyCache.get(pid) || { rttMs: null, natType: 'P2P' };
              let rttMs = prev.rttMs;
              try {
                rttMs = await room.ping(pid);
              } catch {
                // keep previous sample on timeout
              }
              const natType = await inspectPeerNat(peersMap[pid]);
              peerLatencyCache.set(pid, { rttMs, natType });
            })
          );
          const statsObj = {};
          for (const pid of ids) {
            statsObj[pid] = peerLatencyCache.get(pid) || { rttMs: null, natType: 'P2P' };
          }
          handlers.onPeerStats?.(statsObj);
          const firstNat = ids.length > 0 ? statsObj[ids[0]]?.natType || 'Host' : 'Host';
          emitStatus({
            phase: 'hosting',
            text: `Hosting ${roomCode} (${ids.length} peer${ids.length === 1 ? '' : 's'})`,
            tone: 'success',
            rttMs: 0,
            natType: firstNat,
          });
        };

        act.hello.onMessage((data, meta) => {
          const peerId = meta?.peerId;
          if (!peerId) return;
          rxCountWindow++;
          connectedPeers.add(peerId);
          const result = handlers.onGuestHello?.(peerId, data);
          if (!result || result.error) {
            act.reject.send({ reason: result?.error || 'Room full' }, { target: peerId }).catch(() => {});
            return;
          }
          act.welcome.send(result.welcomePayload, { target: peerId }).catch(() => {});
          setTimeout(sampleHostPeers, 500);
          emitStatus({
            phase: 'hosting',
            text: `Hosting ${roomCode} (${connectedPeers.size} peer${connectedPeers.size === 1 ? '' : 's'})`,
            tone: 'success',
            rttMs: 0,
            natType: 'Host',
          });
        });

        act.input.onMessage((data, meta) => {
          const peerId = meta?.peerId;
          if (!peerId || !data) return;
          rxCountWindow++;
          handlers.onGuestInput?.(peerId, data);
        });

        hbTimer = setInterval(() => {
          if (room && connectedPeers.size > 0) {
            txCountWindow++;
            act.hb.send({ t: Date.now() }).catch(() => {});
          }
        }, NET_CFG.HEARTBEAT_MS);

        monitorTimer = setInterval(sampleHostPeers, 2000);
      } else {
        // Guest role
        emitStatus({
          phase: 'joining',
          text: `Joining ${roomCode}...`,
          tone: 'warning',
          rttMs: null,
          natType: 'Signaling',
        });

        const sendHelloTo = (peerId) => {
          if (!act || hostPeerId) return;
          act.hello.send({ name: playerName, v: NET_CFG.PROTOCOL }, { target: peerId }).catch(() => {});
        };

        room.onPeerJoin((info) => {
          const peerId = info?.peerId || info;
          connectedPeers.add(peerId);
          wirePeerConnectionDiagnostics(peerId);
          sendHelloTo(peerId);
        });

        room.onPeerLeave((info) => {
          const peerId = info?.peerId || info;
          connectedPeers.delete(peerId);
          if (peerId === hostPeerId) {
            clearTimers();
            handlers.onHostDisconnected?.('Host left the room');
            emitStatus({
              phase: 'disconnected',
              text: 'Host disconnected — Room closed',
              tone: 'error',
              rttMs: null,
              natType: '',
            });
          }
        });

        act.reject.onMessage((data) => {
          clearTimers();
          const reason = data?.reason || 'Unable to join room';
          handlers.onHostDisconnected?.(reason);
          emitStatus({ phase: 'rejected', text: reason, tone: 'error', rttMs: null, natType: '' });
        });

        const sampleGuestHost = async () => {
          if (!room || role !== 'guest' || !hostPeerId) return;
          if (Date.now() - lastHostMsgAt > NET_CFG.HOST_TIMEOUT_MS) {
            clearTimers();
            handlers.onHostDisconnected?.('Connection to Host timed out');
            emitStatus({
              phase: 'disconnected',
              text: 'Host timed out — Room closed',
              tone: 'error',
              rttMs: null,
              natType: '',
            });
            return;
          }
          let rttMs = null;
          try {
            rttMs = await room.ping(hostPeerId);
          } catch {
            rttMs = null;
          }
          const peerInfo = room.getPeers?.()?.[hostPeerId];
          const natType = await inspectPeerNat(peerInfo);
          emitStatus({
            phase: 'connected',
            text: `Room ${roomCode}`,
            tone: 'success',
            rttMs,
            natType,
          });
        };

        act.welcome.onMessage((data, meta) => {
          const peerId = meta?.peerId;
          if (!peerId || !data) return;
          if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
          rxCountWindow++;
          hostPeerId = peerId;
          lastHostMsgAt = Date.now();
          handlers.onWelcome?.(data, peerId);
          setTimeout(sampleGuestHost, 400);
          emitStatus({
            phase: 'connected',
            text: `Connected to ${roomCode}`,
            tone: 'success',
            rttMs: null,
            natType: 'P2P',
          });
        });

        act.snap.onMessage((data, meta) => {
          if (meta?.peerId !== hostPeerId) return;
          rxCountWindow++;
          lastHostMsgAt = Date.now();
          handlers.onSnapshot?.(data);
        });

        act.delta.onMessage((data, meta) => {
          if (meta?.peerId !== hostPeerId) return;
          rxCountWindow++;
          lastHostMsgAt = Date.now();
          handlers.onDelta?.(data);
        });

        act.ev.onMessage((data, meta) => {
          if (meta?.peerId !== hostPeerId) return;
          rxCountWindow++;
          lastHostMsgAt = Date.now();
          handlers.onEvent?.(data);
        });

        act.hb.onMessage((_, meta) => {
          if (meta?.peerId === hostPeerId) {
            rxCountWindow++;
            lastHostMsgAt = Date.now();
          }
        });

        // Timeout if no host responds within ICE_TIMEOUT_MS
        joinTimer = setTimeout(() => {
          if (role !== 'guest' || hostPeerId) return;
          const hadPeers = connectedPeers.size > 0;
          const blocked = iceFailedPeers.size > 0 || !hadPeers;
          emitStatus({
            phase: 'blocked',
            text: blocked
              ? 'No P2P link (Host offline or strict CGNAT/firewall — try MQTT or TURN)'
              : 'Host did not respond in time',
            tone: 'error',
            rttMs: null,
            natType: 'Blocked',
          });
        }, NET_CFG.ICE_TIMEOUT_MS);

        monitorTimer = setInterval(sampleGuestHost, 2000);
      }

      return { ok: true, roomCode, selfPeerId };
    } catch (err) {
      const msg = err?.message || 'Failed to initialize WebRTC room';
      emitStatus({ phase: 'error', text: msg, tone: 'error', rttMs: null, natType: '' });
      return { ok: false, error: msg };
    }
  }

  return {
    getRole: () => role,
    getRoomCode: () => roomCode,
    getSelfPeerId: () => selfPeerId,
    getStrategy: () => strategy,
    isHost: () => role === 'host',
    isGuest: () => role === 'guest',
    isOnline: () => role === 'host' || role === 'guest',
    hostRoom: (opts) => connect({ ...opts, targetRole: 'host' }),
    joinRoom: (opts) => connect({ ...opts, targetRole: 'guest' }),
    leave,
    sendInput: (pkt) => {
      if (!act || role !== 'guest' || !hostPeerId) return;
      txCountWindow++;
      act.input.send(pkt, { target: hostPeerId }).catch(() => {});
    },
    sendSnapshot: (payload, targetPeerId = null) => {
      if (!act || role !== 'host') return;
      if (targetPeerId) {
        txCountWindow++;
        act.snap.send(payload, { target: targetPeerId }).catch(() => {});
      } else if (connectedPeers.size > 0) {
        txCountWindow++;
        act.snap.send(payload).catch(() => {});
      }
    },
    sendDelta: (payload) => {
      if (!act || role !== 'host' || connectedPeers.size === 0) return;
      txCountWindow++;
      act.delta.send(payload).catch(() => {});
    },
    sendEvent: (ev) => {
      if (!act || role !== 'host' || connectedPeers.size === 0) return;
      txCountWindow++;
      act.ev.send(ev).catch(() => {});
    },
  };
}
