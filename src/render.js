import { DIR_VEC, TILE } from './constants.js';

/**
 * Reads CSS custom properties into a resolved theme object.
 */
export function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name, fb) => cs.getPropertyValue(name).trim() || fb;
  const isLight = document.documentElement.classList.contains('light');
  return {
    isLight,
    bg: get('--background', isLight ? '#f8fafc' : '#0f172a'),
    card: get('--card', isLight ? '#ffffff' : '#1e293b'),
    border: get('--border', isLight ? '#cbd5e1' : '#334155'),
    fg: get('--foreground', isLight ? '#0f172a' : '#f8fafc'),
    muted: get('--muted-foreground', isLight ? '#64748b' : '#94a3b8'),
    primary: get('--primary', '#38bdf8'),
    mirror: '#7dd3fc',
    accent: get('--accent', '#a855f7'),
    success: get('--success', '#22c55e'),
    warning: get('--warning', '#f59e0b'),
    error: get('--error', '#ef4444'),
    palette: [
      get('--chart-1', '#06b6d4'), // P1 Cyan
      get('--chart-4', '#f43f5e'), // Rose
      get('--chart-2', '#f59e0b'), // Amber
      get('--chart-3', '#22c55e'), // Green
      get('--chart-5', '#a855f7'), // Violet
      get('--chart-6', '#3b82f6'), // Blue
      '#ec4899',                   // Pink
      '#14b8a6',                   // Teal
    ],
  };
}

export function gridMetrics(state, W, H) {
  const pad = 14;
  const tile = Math.floor(Math.min((W - pad * 2) / state.cols, (H - pad * 2) / state.rows));
  const ox = Math.floor((W - tile * state.cols) / 2);
  const oy = Math.floor((H - tile * state.rows) / 2);
  return { tile, ox, oy };
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export function createRenderer({ canvas, stageWrap }) {
  const ctx = canvas.getContext('2d');
  let W = 800;
  let H = 520;
  let DPR = 1;

  function resize() {
    const rect = stageWrap.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(320, Math.floor(rect.width));
    H = Math.max(320, Math.floor(rect.height));
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  new ResizeObserver(resize).observe(stageWrap);
  resize();

  function fillAlpha(color, alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  function strokeAlpha(color, alpha, lw) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.strokeStyle = color;
    if (lw !== undefined) ctx.lineWidth = lw;
    ctx.stroke();
    ctx.restore();
  }

  function draw(state, theme) {
    ctx.clearRect(0, 0, W, H);
    const { tile, ox, oy } = gridMetrics(state, W, H);

    ctx.save();
    if (state.shakeTime > 0) {
      ctx.translate((Math.random() - 0.5) * state.shakeAmp * 2, (Math.random() - 0.5) * state.shakeAmp * 2);
    }

    // Grid cells & blocks
    for (let y = 0; y < state.rows; y++) {
      for (let x = 0; x < state.cols; x++) {
        const px = ox + x * tile;
        const py = oy + y * tile;
        ctx.beginPath();
        ctx.rect(px + 1, py + 1, tile - 2, tile - 2);
        fillAlpha(theme.fg, (x + y) % 2 === 0 ? 0.045 : 0.015);

        const c = state.grid[y]?.[x] ?? 0;
        if (c === TILE.WALL) {
          roundRect(ctx, px + 1.5, py + 1.5, tile - 3, tile - 3, 4);
          ctx.fillStyle = theme.bg;
          ctx.fill();
          fillAlpha('#000000', theme.isLight ? 0.42 : 0.24);
          strokeAlpha(theme.border, theme.isLight ? 0.55 : 0.9, 1.4);
          roundRect(ctx, px + 5, py + 5, tile - 10, tile - 10, 2.5);
          strokeAlpha(theme.fg, theme.isLight ? 0.14 : 0.10, 1);
        } else if (c === TILE.CRATE_2) {
          const col = theme.palette[2];
          roundRect(ctx, px + 3, py + 3, tile - 6, tile - 6, 5);
          fillAlpha(col, 0.24);
          strokeAlpha(col, 1, 1.5);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(px + 7, py + 7);
          ctx.lineTo(px + tile - 7, py + tile - 7);
          ctx.moveTo(px + tile - 7, py + 7);
          ctx.lineTo(px + 7, py + tile - 7);
          ctx.stroke();
        } else if (c === TILE.CRATE_1) {
          const col = theme.error;
          ctx.save();
          ctx.setLineDash([4, 3]);
          roundRect(ctx, px + 3, py + 3, tile - 6, tile - 6, 5);
          fillAlpha(col, 0.14);
          strokeAlpha(col, 0.95, 1.5);
          ctx.setLineDash([]);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.6;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          // Jagged crack across the box (distinct from diagonal mirrors)
          ctx.beginPath();
          ctx.moveTo(px + tile * 0.28, py + 5);
          ctx.lineTo(px + tile * 0.48, py + tile * 0.42);
          ctx.lineTo(px + tile * 0.36, py + tile * 0.62);
          ctx.lineTo(px + tile * 0.68, py + tile - 5);
          ctx.moveTo(px + tile * 0.48, py + tile * 0.42);
          ctx.lineTo(px + tile - 6, py + tile * 0.32);
          ctx.stroke();
          ctx.restore();
        } else if (c === TILE.MIRROR_FWD || c === TILE.MIRROR_BWD) {
          roundRect(ctx, px + 3, py + 3, tile - 6, tile - 6, 5);
          fillAlpha(theme.mirror, 0.18);
          strokeAlpha(theme.mirror, 1, 1.5);
          ctx.strokeStyle = theme.mirror;
          ctx.lineWidth = 2.6;
          ctx.beginPath();
          if (c === TILE.MIRROR_FWD) {
            ctx.moveTo(px + 7, py + tile - 7);
            ctx.lineTo(px + tile - 7, py + 7);
          } else {
            ctx.moveTo(px + 7, py + 7);
            ctx.lineTo(px + tile - 7, py + tile - 7);
          }
          ctx.stroke();
        } else if (c === TILE.BOOM) {
          roundRect(ctx, px + 3, py + 3, tile - 6, tile - 6, 5);
          fillAlpha(theme.warning, 0.28);
          strokeAlpha(theme.error, 1, 1.75);
          ctx.fillStyle = theme.error;
          ctx.font = `800 ${Math.max(8, Math.floor(tile * 0.28))}px "Montserrat", system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('TNT', px + tile / 2, py + tile / 2 + 0.5);
        }
      }
    }

    // Pending health packet spawn indicators
    for (const pp of state.pendingPickups) {
      const px = ox + pp.x * tile;
      const py = oy + pp.y * tile;
      const cx = px + tile / 2;
      const cy = py + tile / 2;
      const frac = Math.max(0, Math.min(1, pp.remaining / pp.duration));
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.01);

      roundRect(ctx, px + 2, py + 2, tile - 4, tile - 4, 5);
      fillAlpha(theme.success, 0.12 + pulse * 0.08);
      strokeAlpha(theme.success, 0.45, 1.2);

      ctx.beginPath();
      ctx.arc(cx, cy, tile * 0.34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
      strokeAlpha(theme.success, 0.72, Math.max(2, tile * 0.08));

      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = theme.success;
      ctx.font = `bold ${Math.max(11, Math.floor(tile * 0.48))}px "Montserrat", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♥', cx, cy + 1);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = theme.fg;
      ctx.font = `bold ${Math.max(9, Math.floor(tile * 0.31))}px "Montserrat", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pp.remaining.toFixed(1), cx, cy + 0.5);
      ctx.restore();
    }

    // Pickups
    for (const pk of state.pickups) {
      const cx = ox + (pk.x + 0.5) * tile;
      const cy = oy + (pk.y + 0.5) * tile;
      const col = pk.type === 'heal' ? theme.success : theme.primary;
      ctx.beginPath();
      ctx.arc(cx, cy, tile * 0.28, 0, Math.PI * 2);
      fillAlpha(col, 0.22);
      strokeAlpha(col, 1, 1.5);
      ctx.fillStyle = col;
      ctx.font = `bold ${Math.max(10, Math.floor(tile * 0.42))}px "Montserrat", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pk.type === 'heal' ? '♥' : '⚡', cx, cy + 1);
    }

    // Turrets
    for (const t of state.turrets) {
      const cx = ox + (t.x + 0.5) * tile;
      const cy = oy + (t.y + 0.5) * tile;
      const [dx, dy] = DIR_VEC[t.dir];
      const ownerColor = t.owner?.color || theme.palette[t.ownerColorIdx ?? 0] || theme.primary;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, tile * 0.25, 0, Math.PI * 2);
      fillAlpha(ownerColor, 0.25);
      strokeAlpha(ownerColor, 1, 2);
      ctx.strokeStyle = ownerColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + dx * tile * 0.4, cy + dy * tile * 0.4);
      ctx.stroke();
      if (t.timer < 0.4) {
        ctx.fillStyle = theme.warning;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(3, tile * 0.11), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Bots / Players
    for (const b of state.bots) {
      if (b.hp <= 0) continue;
      if (b.invuln > 0 && Math.floor(b.invuln * 16) % 2 === 0) continue;
      const cx = ox + (b.rx + 0.5) * tile;
      const cy = oy + (b.ry + 0.5) * tile;
      const [dx, dy] = DIR_VEC[b.dir];
      ctx.save();
      if (b.isLocal) {
        ctx.beginPath();
        ctx.arc(cx, cy, tile * 0.42, 0, Math.PI * 2);
        strokeAlpha(b.color, 0.65, 1.8);
      }
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(cx, cy, tile * 0.34, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = b.telegraph > 0 ? theme.warning : theme.bg;
      ctx.lineWidth = Math.max(2.5, tile * 0.11);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + dx * 2, cy + dy * 2);
      ctx.lineTo(cx + dx * tile * 0.4, cy + dy * tile * 0.4);
      ctx.stroke();
      ctx.restore();
    }

    // Laser beams (stored in grid coordinates [gx, gy] so every client scales cleanly)
    for (const beam of state.beams) {
      const alpha = Math.max(0, beam.life / beam.maxLife);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = beam.color;
      ctx.lineWidth = beam.width + 4;
      ctx.beginPath();
      beam.pts.forEach(([gx, gy], idx) => {
        const px = ox + gx * tile;
        const py = oy + gy * tile;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1.2, beam.width - 1.5);
      ctx.stroke();
      ctx.restore();
    }

    // Particles (stored in grid coordinates)
    for (const p of state.particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(ox + p.gx * tile, oy + p.gy * tile, Math.max(1.5, p.rTiles * tile), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Spectator notice for mid-round joiners
    if (state.netRole === 'guest' && state.spectating && !state.roundOver) {
      ctx.save();
      roundRect(ctx, W / 2 - 145, 14, 290, 28, 14);
      fillAlpha(theme.bg, 0.88);
      strokeAlpha(theme.primary, 0.7, 1.2);
      ctx.fillStyle = theme.primary;
      ctx.font = '600 11px "Montserrat", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('SPECTATING — JOINING NEXT ROUND', W / 2, 28);
      ctx.restore();
    }

    // Round Over Banner
    if (state.roundOver) {
      ctx.save();
      roundRect(ctx, W / 2 - 145, H / 2 - 32, 290, 64, 12);
      fillAlpha(theme.bg, 0.92);
      strokeAlpha(state.roundWinner ? state.roundWinner.color : theme.border, 1, 2);
      ctx.fillStyle = theme.fg;
      ctx.font = '700 16px "Montserrat", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const text = state.roundWinner ? `${state.roundWinner.name} WINS ROUND ${state.round}!` : 'DOUBLE KO — DRAW';
      ctx.fillText(text, W / 2, H / 2);
      ctx.restore();
    }

    ctx.restore();
  }

  return { draw, resize };
}
