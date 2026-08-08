/**
 * ALPHA AIRCRAFT RACE 3D — main.js
 * ---------------------------------------------------------------------------
 * Application bootstrap. Verifies the environment, starts the game, registers
 * the offline cache worker and provides a human-readable failure screen if
 * anything goes wrong before the loop is running.
 */

import { Game } from './game.js';
import { GAME_NAME, VERSION } from './config.js';

const bootStart = performance.now();

function fatal(title, detail) {
  const host = document.getElementById('loading-screen') || document.body;
  host.innerHTML = `
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
                text-align:center;padding:6vw;gap:14px;background:#04070c;color:#dce7f2;font-family:system-ui,sans-serif;z-index:999">
      <div style="font-size:.68rem;letter-spacing:.34em;color:#ff3b52">UNABLE TO START</div>
      <h1 style="font-size:clamp(1.2rem,3vw,2rem);letter-spacing:.14em;font-weight:700">${title}</h1>
      <p style="max-width:56ch;line-height:1.7;color:#8ba0b6;font-size:.86rem">${detail}</p>
      <button onclick="location.reload()" style="margin-top:10px;padding:12px 28px;border-radius:5px;cursor:pointer;
              border:1px solid rgba(57,245,255,.42);background:rgba(16,60,74,.8);color:#eafdff;
              letter-spacing:.16em;text-transform:uppercase;font-size:.78rem">Retry</button>
    </div>`;
  host.classList.add('active');
}

/** WebGL is non-negotiable — check before we build anything expensive. */
function checkWebGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (e) { return false; }
}

async function main() {
  console.info(`%c${GAME_NAME} %cv${VERSION}`,
    'color:#39f5ff;font-weight:700;letter-spacing:.14em', 'color:#8ba0b6');

  if (!checkWebGL()) {
    fatal('WebGL is not available',
      'This game needs hardware-accelerated WebGL. Enable it in your browser settings (or try a different browser) and reload.');
    return;
  }

  const canvas = document.getElementById('game-canvas');
  if (!canvas) { fatal('Canvas missing', 'The page did not load correctly. Try a hard refresh.'); return; }

  let game;
  try {
    game = new Game(canvas);
    window.__ALPHA__ = game;       // handy for debugging from the console
  } catch (err) {
    console.error(err);
    fatal('Initialisation failed', escapeHtml(err.message || String(err)));
    return;
  }

  // A lost GPU context should not look like a crash.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    game.ui?.toast('Graphics context lost — restoring…', 'warn');
    game.togglePause?.(true);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    game.ui?.toast('Graphics context restored');
    try { game.render.applyQuality(); } catch (e) { /* noop */ }
  });

  window.addEventListener('error', (e) => {
    if (e.message && /ResizeObserver/.test(e.message)) return;
    console.error('[Global]', e.message, e.filename, e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[Promise]', e.reason);
  });

  try {
    await game.boot();
    document.body.classList.remove('app-booting');
    console.info(`[Main] total boot ${((performance.now() - bootStart) / 1000).toFixed(2)}s`);
  } catch (err) {
    console.error(err);
    fatal('Startup failed', escapeHtml(err?.message || String(err)));
    return;
  }

  registerServiceWorker();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Caches the engine and app shell so repeat launches are near-instant. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;   // SW is unavailable on file://
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.info('[SW] not registered:', err.message);
    });
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
else main();
