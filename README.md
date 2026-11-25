# Sokowar — Laser Box Arena

Fast 2D grid kinetic battle game combining **Sokoban box & mirror pushing**, **bouncing supercharged lasers**, **chain-reaction boom crates**, **placeable auto-turrets**, **timed health spawns**, and **AI bots** on procedural maps — hosted statically on GitHub Pages with **serverless WebRTC P2P multiplayer**.

**Play Live:** `https://amaan12.github.io/sokowar/`

---

## Features

- **Instant Solo vs Bots (Zero Setup):** Loads directly into `1P + Bots` (plus toggleable `2P Local + Bots`).
- **Serverless WebRTC P2P Multiplayer (2–8 Players + Optional AI Bot Backfill):**
  - Powered by [Trystero](https://github.com/dmotz/trystero) over WebRTC DataChannels (Nostr signaling default + MQTT relay fallback).
  - Short 5-character room codes and one-click `?room=CODE` invite URLs.
  - **Host-Authoritative Simulation:** The Host runs the official grid, raycasts, explosions, turrets, pickups, and AI bots, syncing compact deltas and grid-normalized discrete events.
  - **Client-Side Prediction (CSP) + Reconciliation:** Guest arrow-key movement and crate pushes respond at `0ms` locally while reconciling seamlessly against Host authority, with smooth `rx`/`ry` visual interpolation for remote combatants.
  - **NAT & Connection Diagnostics:** Live RTT ping (`ms`), ICE candidate inspection (`Direct LAN` / `STUN NAT` / `TURN Relay`), clear failure diagnostics for strict CGNAT/firewalls, and an optional browser-local `ICE/TURN` JSON setting.

---

## Controls & Tiles

| Input | P1 / Online | P2 (Local) |
| --- | --- | --- |
| Move & push boxes | `Arrow Keys` | `W A S D` |
| Fire laser beam | `Space` | `F` |
| Drop auto-turret | `Shift` / `X` / `Enter` | `G` |
| New procedural map | `N` *(Solo / Host)* | — |
| Rematch current seed | `R` *(Solo / Host)* | — |

- **`/ \` Mirrors:** Reflect laser beams at 90° and supercharge them to **2 DMG**.
- **`✦` Boom Crates:** Explode in a 3×3 radius and chain-detonate adjacent boom crates.
- **`♥` / `⚡` Pickups:** Repair +1 HP or grant temporary Overdrive (rapid fire + faster turrets).

---

## Project Structure

```text
├── index.html          # App layout, Tailwind UI, and Multiplayer bar
├── src/
│   ├── constants.js    # Tile codes, directions, network & ICE defaults
│   ├── map.js          # Deterministic Mulberry32 procedural map generator
│   ├── audio.js        # Zero-dependency Web Audio API synth SFX
│   ├── render.js       # DPR-aware HTML5 Canvas renderer (grid-scaled beams/FX)
│   ├── net.js          # Trystero WebRTC P2P wrapper, RTT & NAT diagnostics
│   └── game.js         # Simulation loop, Host delta sync, Guest CSP & UI wiring
├── .gitignore
└── README.md
```

---

## Local Development

Because Sokowar uses native ES modules (`<script type="module">`), serve the folder over a local static HTTP server rather than opening via `file://`:

```bash
python -m http.server 8080
# or
npx serve .
```

Then open `http://localhost:8080` in your browser (or two tabs to test Host & Join locally).

---

## Notes on P2P & Mobile Data / Strict NAT

Because Sokowar runs 100% statically on GitHub Pages with no backend servers, WebRTC uses public STUN servers (`stun.l.google.com:19302`) for NAT traversal. Standard broadband/Wi-Fi connections punch through directly in most cases; however, two peers both behind strict symmetric NAT / mobile CGNAT may be blocked without a TURN relay. If needed, click **ICE/TURN** in the multiplayer bar to paste your own `iceServers` JSON (saved only in your browser's `localStorage`).
