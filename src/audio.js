let audioCtx = null;
let soundEnabled = true;

export function isSoundEnabled() {
  return soundEnabled;
}

export function setSoundEnabled(enabled) {
  soundEnabled = Boolean(enabled);
}

export function ensureAudio() {
  if (!soundEnabled) return null;
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function playTone(freq, dur = 0.06, type = 'triangle', vol = 0.07, slideTo = null) {
  const ac = ensureAudio();
  if (!ac) return;
  const now = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), now + dur);
  gain.gain.setValueAtTime(vol, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(now);
  osc.stop(now + dur + 0.01);
}

export const sfxLaser = () => playTone(880, 0.12, 'sawtooth', 0.06, 180);
export const sfxMirror = () => playTone(1340, 0.07, 'sine', 0.05, 1780);
export const sfxPush = () => playTone(165, 0.04, 'square', 0.03, 110);
export const sfxHit = () => playTone(125, 0.16, 'sawtooth', 0.1, 48);
export const sfxBoom = () => playTone(95, 0.25, 'sawtooth', 0.12, 32);
export const sfxPickup = () => playTone(587, 0.1, 'triangle', 0.07, 880);
export const sfxTurret = () => playTone(440, 0.08, 'sine', 0.05, 660);
export const sfxHealSpawn = () => playTone(660, 0.07, 'sine', 0.04, 880);
export const sfxCountdownTick = () => playTone(520, 0.05, 'sine', 0.04);
export const sfxCountdownGo = () => playTone(880, 0.11, 'triangle', 0.06, 1040);
