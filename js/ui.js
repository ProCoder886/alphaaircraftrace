/**
 * ALPHA AIRCRAFT RACE 3D — ui.js
 * ---------------------------------------------------------------------------
 * Everything the player reads or clicks: loading screen, onboarding, main menu
 * and its selectors, the flight HUD, the radar, pause, settings, results,
 * touch controls, fullscreen and the debug overlay.
 *
 * The UI never touches game state directly — it renders what it is given and
 * reports intent back through `callbacks`.
 */

import {
  AIRCRAFT, AIRCRAFT_BY_ID, BIOMES, BIOMES_BY_ID, MODES, MODE_ORDER,
  DIFFICULTIES, DIFFICULTY_ORDER, POWERS, WEATHER, CAMPAIGN, ACHIEVEMENTS,
  QUALITY_ORDER, QUALITY_PRESETS, BINDING_LABELS, DEFAULT_BINDINGS, TIPS,
  GAME_NAME, VERSION, clamp, clamp01, lerp, TAU,
} from './config.js';

/* ---- helpers ------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

export function formatTime(sec, showMs = true) {
  if (!isFinite(sec) || sec < 0) return showMs ? '--:--.---' : '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (!showMs) return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const ms = Math.floor((sec % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
export function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
const nf = (n) => Math.round(n).toLocaleString('en-US');

/* ---- inline icon set ----------------------------------------------------- */
const ICONS = {
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>',
  freeze: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3.4 2"/></svg>',
  phase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12c0-4 3-7 7-7s7 3 7 7-3 7-7 7"/><path d="M9 5.5C6 7 4.5 9.3 4.5 12S6 17 9 18.5" stroke-dasharray="2.4 2.4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/></svg>',
  turbo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 3L5 13h5l-1 8 8-10h-5z" fill="currentColor" stroke="none"/></svg>',
  play: '▶', mode: '◈', diff: '▲', loc: '◎', craft: '✈', daily: '★',
  camp: '❐', ach: '✦', stats: '▤', set: '⚙', help: '?', cred: '©',
};

/* ---- procedural aircraft silhouette for menu cards -----------------------
 * A plan view drawn from the same `shape` block that builds the 3D mesh, so a
 * card genuinely previews the airframe you will fly. Everything is normalised
 * to a 100-unit fuselage and the viewBox is fitted to the drawn extents, so
 * wide-span frames read wide and long-bodied frames read long.
 * ----------------------------------------------------------------------- */
function jetSilhouette(spec) {
  const s = spec.shape;
  const L = 100;                                  // fuselage length in view units
  const u = L / s.length;                         // metres → view units
  const halfSpan = (s.wingSpan / 2) * u;
  const bodyW = s.bodyW * u;
  const nose = 6, tail = nose + L;
  const cx = 0;

  const wingRootY = nose + L * (0.50 + s.wingPos);
  const wingTipY = wingRootY + s.wingSweep * halfSpan * 0.62;
  const rootChord = s.wingRoot * u;
  const tipChord = s.wingTip * u;

  const mirror = (d) => `${d} ${d.replace(/(-?[\d.]+) (-?[\d.]+)/g, (m, x, y) => `${-parseFloat(x)} ${y}`)}`;

  // Main wing (right side; mirrored for the left).
  const wing = `M ${bodyW * 0.5} ${wingRootY - rootChord * 0.45}
    L ${halfSpan} ${wingTipY - tipChord * 0.5}
    L ${halfSpan} ${wingTipY + tipChord * 0.5}
    L ${bodyW * 0.5} ${wingRootY + rootChord * 0.55} Z`;

  // Canards.
  const canardSpan = (s.canardSpan / 2) * u;
  const canard = s.canard > 0.1 ? `M ${bodyW * 0.42} ${nose + L * 0.20}
    L ${canardSpan} ${nose + L * 0.30}
    L ${canardSpan} ${nose + L * 0.36}
    L ${bodyW * 0.42} ${nose + L * 0.32} Z` : '';

  // Leading-edge root extensions.
  const strake = s.strakes > 0.05 ? `M ${bodyW * 0.44} ${nose + L * 0.30}
    L ${bodyW * 0.95 * s.strakes} ${wingRootY - rootChord * 0.42}
    L ${bodyW * 0.5} ${wingRootY - rootChord * 0.42} Z` : '';

  // Fuselage: sharp nose, chined mid-body, engine deck at the tail.
  const body = `M ${cx} ${nose}
    C ${bodyW * 0.34} ${nose + L * 0.14}, ${bodyW * 0.52} ${nose + L * 0.24}, ${bodyW * 0.5} ${nose + L * 0.36}
    L ${bodyW * 0.5} ${tail - L * 0.14}
    L ${s.engineSep * u * 0.5 + bodyW * 0.30} ${tail}
    L ${-(s.engineSep * u * 0.5 + bodyW * 0.30)} ${tail}
    L ${-bodyW * 0.5} ${tail - L * 0.14}
    L ${-bodyW * 0.5} ${nose + L * 0.36}
    C ${-bodyW * 0.52} ${nose + L * 0.24}, ${-bodyW * 0.34} ${nose + L * 0.14}, ${cx} ${nose} Z`;

  // Tail fins.
  const finY = tail - L * 0.20;
  const finX = s.engineSep * u * 0.5;
  const finSize = L * 0.16 * s.tailSize;
  const fins = s.tail === 'single'
    ? `M ${-finSize * 0.18} ${finY} L ${finSize * 0.18} ${finY} L ${finSize * 0.10} ${finY + finSize} L ${-finSize * 0.10} ${finY + finSize} Z`
    : `M ${finX} ${finY} L ${finX + finSize * 0.55} ${finY + finSize * 0.9} L ${finX + finSize * 0.30} ${finY + finSize} L ${finX - finSize * 0.12} ${finY + finSize * 0.3} Z
       M ${-finX} ${finY} L ${-(finX + finSize * 0.55)} ${finY + finSize * 0.9} L ${-(finX + finSize * 0.30)} ${finY + finSize} L ${-(finX - finSize * 0.12)} ${finY + finSize * 0.3} Z`;

  const vw = Math.max(halfSpan, canardSpan, finX + finSize) * 2 + 12;
  const vh = tail + 12;
  const nozR = s.engineR * u * 0.55;

  return `
    <svg class="mini-jet" viewBox="${-vw / 2} 0 ${vw} ${vh}" style="color:${hex(spec.colors.primary)}">
      <g fill="currentColor">
        <path d="${mirror(wing)}" opacity="0.94"/>
        ${canard ? `<path d="${mirror(canard)}" opacity="0.9"/>` : ''}
        ${strake ? `<path d="${mirror(strake)}" opacity="0.8"/>` : ''}
        <path d="${body}"/>
        <path d="${fins}" opacity="0.75"/>
      </g>
      <g fill="${hex(spec.colors.secondary)}" opacity="0.55">
        <path d="M ${-bodyW * 0.22} ${nose + L * 0.16} L ${bodyW * 0.22} ${nose + L * 0.16}
                 L ${bodyW * 0.16} ${nose + L * 0.34} L ${-bodyW * 0.16} ${nose + L * 0.34} Z"/>
      </g>
      <g fill="${hex(spec.colors.accent)}" opacity="0.9">
        <rect x="${-bodyW * 0.07}" y="${nose + L * 0.40}" width="${bodyW * 0.14}" height="${L * 0.34}" rx="1"/>
      </g>
      <g fill="${hex(spec.colors.emissive)}">
        <ellipse cx="${-finX}" cy="${tail - 1}" rx="${nozR}" ry="${nozR * 0.62}"/>
        <ellipse cx="${finX}" cy="${tail - 1}" rx="${nozR}" ry="${nozR * 0.62}"/>
      </g>
    </svg>`;
}

/* ===========================================================================
 * UI
 * ======================================================================== */

export class UI {
  constructor({ audio, save, input, device }) {
    this.audio = audio;
    this.save = save;
    this.input = input;
    this.device = device;
    this.callbacks = {};
    this.currentScreen = 'loading';
    this.menuSection = 'play';
    this.hangarSelection = save.data.selectedAircraft;
    this.notifications = [];
    this.subtitleTimer = 0;
    this.listeningFor = null;
    this.hudVisible = false;
    this.lastRadarDraw = 0;

    this.dom = {
      body: document.body,
      loading: $('#loading-screen'),
      loadFill: $('#load-bar-fill'),
      loadStage: $('#load-stage'),
      loadPercent: $('#load-percent'),
      loadVenue: $('#load-venue'),
      loadTip: $('#load-tip'),
      onboarding: $('#onboarding'),
      obSlides: $('#ob-slides'),
      obDots: $('#ob-dots'),
      menu: $('#main-menu'),
      menuNav: $('#menu-nav'),
      menuPanel: $('#menu-panel'),
      loadout: $('#loadout-summary'),
      launchSub: $('#launch-sub'),
      credits: $('#credit-value'),
      hud: $('#hud'),
      pause: $('#pause-menu'),
      pauseStats: $('#pause-stats'),
      pauseContext: $('#pause-context'),
      overlay: $('#overlay-panel'),
      overlayTitle: $('#overlay-title'),
      overlayBody: $('#overlay-body'),
      results: $('#results-screen'),
      radar: $('#radar'),
      mobile: $('#mobile-controls'),
      orientation: $('#orientation-overlay'),
      debug: $('#debug-overlay'),
      toast: $('#toast-host'),
      notif: $('#notif-stack'),
      banner: $('#event-banner'),
      subtitle: $('#subtitle-bar'),
      countdown: $('#countdown'),
      warn: $('#warn-strip'),
      damageVig: $('#damage-vignette'),
      compassTape: $('#compass-tape'),
      cpMarker: $('#cp-marker'),
      cpOff: $('#cp-offscreen'),
      powerRack: $('#power-rack'),
      touchPowers: $('#touch-powers'),
    };
    this.radarCtx = this.dom.radar.getContext('2d');

    this._buildCompass();
    this._buildGauges();
    this._buildPowerRack();
    this._buildOnboarding();
    this._buildMenuNav();
    this._bindStatic();
    this._bindTouch();
    this._applyBodyFlags();
    this.setTip();
  }

  on(callbacks) { Object.assign(this.callbacks, callbacks); }

  /* =====================================================================
   * SCREEN MANAGEMENT
   * ================================================================== */
  showScreen(name) {
    const map = {
      loading: this.dom.loading, onboarding: this.dom.onboarding,
      menu: this.dom.menu, pause: this.dom.pause,
      results: this.dom.results, overlay: this.dom.overlay, none: null,
    };
    for (const [k, node] of Object.entries(map)) {
      if (!node) continue;
      if (k === 'overlay') continue;              // overlay is layered, not exclusive
      node.classList.toggle('active', k === name);
    }
    if (name !== 'overlay') this.dom.overlay.classList.remove('active');
    this.currentScreen = name;
    if (name === 'menu') this._renderMenuPanel();
    this.dom.body.classList.toggle('in-game', name === 'none' || name === 'pause');
  }

  setHudVisible(v) {
    this.hudVisible = v;
    this.dom.hud.classList.toggle('active', v);
    this.dom.hud.setAttribute('aria-hidden', String(!v));
    this.dom.mobile.classList.toggle('enabled',
      v && this.device.isTouch && this.save.data.settings.touchControls !== false);
  }

  /* =====================================================================
   * LOADING
   * ================================================================== */
  setLoadProgress(p, stage) {
    const pct = Math.round(clamp01(p) * 100);
    this.dom.loadFill.style.width = `${pct}%`;
    this.dom.loadPercent.textContent = `${pct}%`;
    if (stage) this.dom.loadStage.textContent = stage;
  }
  setLoadVenue(text) { this.dom.loadVenue.textContent = text; }
  setTip() { this.dom.loadTip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)]; }

  /* =====================================================================
   * ONBOARDING (exactly four screens, shown once)
   * ================================================================== */
  _buildOnboarding() {
    const slides = [
      {
        step: 'STEP 1 OF 4', title: 'WELCOME TO ALPHA AIRCRAFT RACE 3D',
        body: 'You fly a prototype racing airframe through procedurally generated sky routes — mountain passes, storm cells, megacity canyons — against a full grid of rival pilots. Every route is generated fresh. No two runs are the same.',
        keys: [], art: 'welcome',
      },
      {
        step: 'STEP 2 OF 4', title: 'FLY & SURVIVE',
        body: 'Bank into the turn and pull — heading follows roll far faster than rudder alone. Clear every checkpoint gate, thread the ring chains, and keep the hull intact. Contact costs speed and structure.',
        keys: [
          ['W / ↑', 'Pitch up · accelerate'], ['S / ↓', 'Pitch down · brake'],
          ['A / D', 'Roll left / right'], ['Q / E', 'Yaw'], ['SPACE', 'Boost'],
        ],
        art: 'fly',
      },
      {
        step: 'STEP 3 OF 4', title: 'USE SPECIAL POWERS',
        body: 'Five powers, five cooldowns. Scan reads the route ahead, Freeze slows the airspace, Phase lets you through soft obstacles, Shield absorbs an impact and Overdrive rewrites your top speed.',
        keys: POWERS.map((p) => [`NUM ${p.slot}`, `${p.name} · ${p.cooldown}s`]),
        art: 'powers',
      },
      {
        step: 'STEP 4 OF 4', title: 'MASTER THE SKY',
        body: 'The radar shows rivals, traffic and the next gate. Altitude is a weapon — high routes are faster, low routes are shorter and far more dangerous. Complete objectives to earn credits and unlock the hangar.',
        keys: [['ESC', 'Pause'], ['F', 'Fullscreen'], ['V', 'Camera'], ['F8', 'Debug overlay']],
        art: 'master',
      },
    ];
    this.obIndex = 0;
    this.obCount = slides.length;

    this.dom.obSlides.innerHTML = '';
    this.dom.obDots.innerHTML = '';
    slides.forEach((s, i) => {
      const slide = el('div', `ob-slide${i === 0 ? ' active' : ''}`);
      slide.innerHTML = `
        <div class="ob-art">${this._obArt(s.art)}</div>
        <div class="ob-copy">
          <div class="ob-step">${s.step}</div>
          <h2>${s.title}</h2>
          <p>${s.body}</p>
          <div class="ob-keys">${s.keys.map(([k, v]) => `<span class="kbd"><b>${k}</b><i>${v}</i></span>`).join('')}</div>
        </div>`;
      this.dom.obSlides.appendChild(slide);
      const dot = el('div', `ob-dot${i === 0 ? ' on' : ''}`);
      this.dom.obDots.appendChild(dot);
    });
  }

  _obArt(kind) {
    if (kind === 'welcome') {
      return `<svg viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice">
        <defs><linearGradient id="skyG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0d3d5c"/><stop offset="60%" stop-color="#1d6f8f"/><stop offset="100%" stop-color="#2c4a3a"/></linearGradient></defs>
        <rect width="400" height="400" fill="url(#skyG)"/>
        <g fill="#0d2432" opacity="0.9">
          <path d="M0 300 L70 200 L130 268 L190 176 L268 292 L330 224 L400 300 L400 400 L0 400 Z"/>
        </g>
        <g opacity="0.5" fill="#eaf6ff">
          <ellipse cx="90" cy="110" rx="52" ry="17"/><ellipse cx="120" cy="100" rx="38" ry="14"/>
          <ellipse cx="300" cy="150" rx="60" ry="18"/><ellipse cx="266" cy="142" rx="34" ry="12"/>
        </g>
        <g transform="translate(200 220) scale(1.5)">
          <path fill="#c8dcea" d="M0 -46 L11 -8 L54 8 L11 12 L6 44 L0 26 L-6 44 L-11 12 L-54 8 L-11 -8 Z"/>
          <path fill="#39f5ff" d="M-5 26 L0 56 L5 26 Z" opacity="0.95"/>
        </g>
        <g fill="none" stroke="#9dff4a" stroke-width="2.4" opacity="0.85">
          <ellipse cx="200" cy="150" rx="52" ry="17"/>
          <ellipse cx="200" cy="96" rx="34" ry="11" opacity="0.6"/>
          <ellipse cx="200" cy="62" rx="22" ry="7" opacity="0.35"/>
        </g></svg>`;
    }
    if (kind === 'fly') {
      return `<svg viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice">
        <rect width="400" height="400" fill="#0a1622"/>
        <g stroke="#1d3346" stroke-width="1"><path d="M0 100 H400 M0 200 H400 M0 300 H400 M100 0 V400 M200 0 V400 M300 0 V400"/></g>
        <g transform="translate(200 210) rotate(-22)">
          <path fill="#cfe3f2" d="M0 -44 L10 -8 L50 8 L10 12 L5 42 L0 24 L-5 42 L-10 12 L-50 8 L-10 -8 Z"/>
          <path fill="#ff7a2a" d="M-5 24 L0 58 L5 24 Z"/>
        </g>
        <g fill="none" stroke="#39f5ff" stroke-width="2" opacity="0.7">
          <path d="M60 300 C120 250 150 190 200 150" stroke-dasharray="6 6"/>
          <path d="M340 300 C280 250 250 190 200 150" stroke-dasharray="6 6"/>
        </g>
        <g fill="none" stroke="#ff3b52" stroke-width="2.4" opacity="0.8">
          <rect x="70" y="60" width="52" height="52" rx="4"/><rect x="288" y="150" width="44" height="70" rx="4"/>
        </g>
        <g fill="none" stroke="#9dff4a" stroke-width="3"><ellipse cx="200" cy="118" rx="46" ry="15"/></g></svg>`;
    }
    if (kind === 'powers') {
      const cells = POWERS.map((p, i) => {
        const x = 66 + (i % 3) * 118, y = 110 + Math.floor(i / 3) * 130;
        return `<g transform="translate(${x} ${y})">
          <rect x="-42" y="-42" width="84" height="84" rx="8" fill="#0d1c28" stroke="${hex(p.color)}" stroke-width="1.6"/>
          <g transform="translate(-17 -22) scale(1.45)" style="color:${hex(p.color)}">${ICONS[p.icon]}</g>
          <text x="0" y="30" fill="${hex(p.color)}" font-size="11" text-anchor="middle" font-family="monospace">NUM ${p.slot}</text>
        </g>`;
      }).join('');
      return `<svg viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice">
        <rect width="400" height="400" fill="#080f18"/>${cells}</svg>`;
    }
    return `<svg viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice">
      <rect width="400" height="400" fill="#08121c"/>
      <g fill="none" stroke="#1e3d52" stroke-width="1.4">
        <circle cx="130" cy="270" r="86"/><circle cx="130" cy="270" r="58"/><circle cx="130" cy="270" r="29"/>
        <path d="M44 270 H216 M130 184 V356"/>
      </g>
      <g><path fill="#9dff4a" d="M130 250 L138 276 L130 270 L122 276 Z"/>
        <circle cx="168" cy="232" r="5" fill="#ff3b52"/><circle cx="98" cy="238" r="5" fill="#ffb648"/>
        <circle cx="150" cy="312" r="5" fill="#39f5ff"/></g>
      <g fill="none" stroke="#39f5ff" stroke-width="2" opacity="0.85">
        <path d="M240 340 L268 250 L300 180 L344 96"/>
        <ellipse cx="268" cy="250" rx="20" ry="7"/><ellipse cx="300" cy="180" rx="16" ry="6"/><ellipse cx="344" cy="96" rx="12" ry="4"/>
      </g>
      <g font-family="monospace" font-size="15" fill="#dce7f2">
        <text x="240" y="60">ALT 1240 m</text><text x="240" y="82" fill="#9dff4a">SPD 1680 km/h</text>
      </g></svg>`;
  }

  _obGo(delta) {
    const next = clamp(this.obIndex + delta, 0, this.obCount - 1);
    if (next === this.obIndex) return;
    $$('.ob-slide', this.dom.obSlides).forEach((s, i) => s.classList.toggle('active', i === next));
    $$('.ob-dot', this.dom.obDots).forEach((d, i) => d.classList.toggle('on', i === next));
    this.obIndex = next;
    $('#ob-next').textContent = next === this.obCount - 1 ? 'START RACING' : 'Next';
    this.audio.ui('select');
  }

  /* =====================================================================
   * MAIN MENU
   * ================================================================== */
  _buildMenuNav() {
    const items = [
      ['play', 'Play', ICONS.play], ['mode', 'Game Mode', ICONS.mode],
      ['difficulty', 'Difficulty', ICONS.diff], ['location', 'Location', ICONS.loc],
      ['aircraft', 'Aircraft', ICONS.craft], ['campaign', 'Campaign', ICONS.camp],
      ['daily', 'Daily Challenge', ICONS.daily], ['achievements', 'Achievements', ICONS.ach],
      ['stats', 'Statistics', ICONS.stats], ['settings', 'Settings', ICONS.set],
      ['howto', 'How To Play', ICONS.help], ['credits', 'Credits', ICONS.cred],
    ];
    this.dom.menuNav.innerHTML = '';
    for (const [id, label, icon] of items) {
      const b = el('button', `nav-item${id === this.menuSection ? ' active' : ''}`,
        `<span class="nav-ico">${icon}</span><span>${label}</span>`);
      b.type = 'button';
      b.dataset.section = id;
      b.addEventListener('click', () => { this.audio.ui('click'); this.setSection(id); });
      b.addEventListener('pointerenter', () => this.audio.ui('hover'));
      this.dom.menuNav.appendChild(b);
    }
  }

  setSection(id) {
    this.menuSection = id;
    $$('.nav-item', this.dom.menuNav).forEach((n) => n.classList.toggle('active', n.dataset.section === id));
    // The hangar takes over the live background camera for a close inspection
    // orbit; every other section gets the cinematic fly-by.
    this.dom.menu.classList.toggle('hangar-open', id === 'aircraft');
    this.callbacks.onHangarMode?.(id === 'aircraft');
    this._renderMenuPanel();
    if (id === 'aircraft') this.callbacks.onHangarPreview?.(this.hangarSelection);
  }

  _renderMenuPanel() {
    const p = this.dom.menuPanel;
    p.scrollTop = 0;
    p.className = 'menu-panel scroll-area anim-sweep';
    // Re-trigger the entry animation.
    void p.offsetWidth;
    const s = this.save.data;
    switch (this.menuSection) {
      case 'play': p.innerHTML = this._panelPlay(); break;
      case 'mode': p.innerHTML = this._panelMode(); break;
      case 'difficulty': p.innerHTML = this._panelDifficulty(); break;
      case 'location': p.innerHTML = this._panelLocation(); break;
      case 'aircraft': p.innerHTML = this._panelAircraft(); break;
      case 'campaign': p.innerHTML = this._panelCampaign(); break;
      case 'daily': p.innerHTML = this._panelDaily(); break;
      case 'achievements': p.innerHTML = this._panelAchievements(); break;
      case 'stats': p.innerHTML = this._panelStats(); break;
      case 'settings': p.innerHTML = ''; this._renderSettingsInto(p, true); break;
      case 'howto': p.innerHTML = this._panelHowTo(); break;
      case 'credits': p.innerHTML = this._panelCredits(); break;
      default: p.innerHTML = '';
    }
    this._wirePanel();
    this.refreshLoadout();
  }

  _head(title, sub) { return `<div class="panel-head"><h2>${title}</h2><p>${sub}</p></div>`; }

  _panelPlay() {
    const s = this.save.data;
    const mode = MODES[s.selectedMode];
    const diff = DIFFICULTIES[s.selectedDifficulty];
    const loc = s.selectedLocation === 'random' ? null : BIOMES_BY_ID[s.selectedLocation];
    const craft = AIRCRAFT_BY_ID[s.selectedAircraft];
    const st = s.stats;
    return `
      ${this._head('READY ROOM', 'Confirm your loadout, then launch. Endless Flight on Elite over a random venue is the standard configuration.')}
      <div class="card-grid wide stagger">
        <button class="card" data-jump="mode">
          <div class="card-title"><b>${mode.name}</b><span class="card-tag">MODE</span></div>
          <div class="card-desc">${mode.desc}</div>
        </button>
        <button class="card" data-jump="difficulty">
          <div class="card-title"><b>${diff.name}</b><span class="card-tag">DIFFICULTY</span></div>
          <div class="card-desc">${diff.desc}</div>
          <div class="card-meta"><span>REWARD ×${diff.rewardMult.toFixed(2)}</span><span>GRID ${diff.aiCount + 1}</span></div>
        </button>
        <button class="card" data-jump="location">
          <div class="card-title"><b>${loc ? loc.name : 'RANDOM VENUE'}</b><span class="card-tag">LOCATION</span></div>
          <div class="card-desc">${loc ? loc.desc : 'A different venue, weather system and time of day every single run.'}</div>
        </button>
        <button class="card" data-jump="aircraft">
          <div class="card-title"><b>${craft.name}</b><span class="card-tag">AIRFRAME</span></div>
          <div class="card-desc">${craft.class} — ${craft.ability}</div>
          <div class="card-swatch" style="background:${hex(craft.colors.primary)}"></div>
        </button>
      </div>
      <div class="panel-head" style="margin-top:26px"><h2>CAREER</h2></div>
      <div class="stat-grid">
        <div class="stat-tile"><i>Best Score</i><b>${nf(st.bestScore)}</b></div>
        <div class="stat-tile"><i>Best Distance</i><b>${(st.bestDistance / 1000).toFixed(2)} km</b></div>
        <div class="stat-tile"><i>Top Speed</i><b>${nf(st.bestSpeedKmh)} km/h</b></div>
        <div class="stat-tile"><i>Runs</i><b>${nf(st.totalRuns)}</b></div>
        <div class="stat-tile"><i>Podiums</i><b>${nf(st.podiums)}</b></div>
        <div class="stat-tile"><i>Credits</i><b>${nf(s.credits)}</b></div>
      </div>`;
  }

  _panelMode() {
    const s = this.save.data;
    const cards = MODE_ORDER.map((id) => {
      const m = MODES[id];
      const sel = s.selectedMode === id ? ' selected' : '';
      return `<button class="card${sel}" data-mode="${id}">
        <div class="card-title"><b>${m.name}</b>${m.tag ? `<span class="card-tag">${m.tag}</span>` : ''}</div>
        <div class="card-desc">${m.desc}</div>
        <div class="card-meta">
          <span>${m.hasRivals ? 'RIVALS' : 'SOLO'}</span>
          <span>${m.hasLaps ? `${m.laps} LAPS` : m.hasTimer ? 'TIMED' : 'OPEN'}</span>
          <span>${m.failOnDamage ? 'FAILABLE' : 'NO FAIL'}</span>
        </div>
      </button>`;
    }).join('');
    return `${this._head('GAME MODE', 'Six ways to fly the same procedural generator. Endless Flight is the default and the deepest.')}
      <div class="card-grid wide stagger">${cards}</div>`;
  }

  _panelDifficulty() {
    const s = this.save.data;
    const cards = DIFFICULTY_ORDER.map((id) => {
      const d = DIFFICULTIES[id];
      const sel = s.selectedDifficulty === id ? ' selected' : '';
      return `<button class="card${sel}" data-difficulty="${id}">
        <div class="card-title"><b>${d.name}</b><span class="card-tag${d.order >= 3 ? ' warnTag' : ''}">×${d.rewardMult.toFixed(2)}</span></div>
        <div class="card-desc">${d.desc}</div>
        <div class="card-meta">
          <span>AI ${Math.round(d.aiSkill * 100)}</span>
          <span>OBST ${Math.round(d.obstacleDensity * 100)}%</span>
          <span>ROUTE ${Math.round(d.routeComplexity * 100)}%</span>
          <span>GRID ${d.aiCount + 1}</span>
        </div>
      </button>`;
    }).join('');
    return `${this._head('DIFFICULTY', 'Difficulty changes behaviour, not just rival top speed: route complexity, obstacle density, traffic, weather severity and your recovery window all move with it.')}
      <div class="card-grid wide stagger">${cards}</div>`;
  }

  _panelLocation() {
    const s = this.save.data;
    const randomSel = s.selectedLocation === 'random' ? ' selected' : '';
    const cards = BIOMES.slice().sort((a, b) => a.order - b.order).map((b) => {
      const sel = s.selectedLocation === b.id ? ' selected' : '';
      const wx = b.weather.slice(0, 3).map((w) => WEATHER[w].name).join(' · ');
      return `<button class="card${sel}" data-location="${b.id}">
        <div class="card-title"><b>${b.name}</b><span class="card-tag${b.difficulty > 1.2 ? ' warnTag' : ''}">×${b.difficulty.toFixed(2)}</span></div>
        <div class="card-desc">${b.desc}</div>
        <div class="card-meta"><span>${wx}</span></div>
        <div class="card-swatch" style="background:${hex(b.accent)}"></div>
      </button>`;
    }).join('');
    return `${this._head('LOCATION', 'Seventeen venues, each an aerial interpretation with its own terrain, palette, weather pool and hazards. Random recombines venue, weather and time of day every run.')}
      <div class="card-grid wide stagger">
        <button class="card${randomSel}" data-location="random">
          <div class="card-title"><b>RANDOM</b><span class="card-tag">DEFAULT</span></div>
          <div class="card-desc">A fresh combination every launch — Desert + Sunset, Forest + Heavy Rain, Neon City + Rain, Fortress + Storm.</div>
          <div class="card-meta"><span>MAXIMUM VARIETY</span></div>
        </button>
        ${cards}
      </div>`;
  }

  _panelAircraft() {
    const s = this.save.data;
    const sel = AIRCRAFT_BY_ID[this.hangarSelection] || AIRCRAFT_BY_ID[s.selectedAircraft];
    const unlocked = (a) => a.unlock.type === 'default' || s.unlocked.includes(a.id);
    const list = AIRCRAFT.map((a) => {
      const isSel = a.id === sel.id ? ' selected' : '';
      const lock = unlocked(a) ? '' : ' locked';
      const tag = !unlocked(a)
        ? `<span class="card-tag lockTag">${a.unlock.type === 'credits' ? `${nf(a.unlock.cost)} ◈` : 'LOCKED'}</span>`
        : (a.id === s.selectedAircraft ? '<span class="card-tag">ACTIVE</span>' : '');
      return `<button class="card${isSel}${lock}" data-craft="${a.id}">
        <div class="card-title"><b>${a.name}</b>${tag}</div>
        ${jetSilhouette(a)}
        <div class="card-desc">${a.class}</div>
        <div class="card-swatch" style="background:${hex(a.colors.primary)}"></div>
      </button>`;
    }).join('');

    const statRow = (k, v) => `<div class="stat-row"><span>${k}</span><div class="stat-bar"><span style="width:${Math.round(v * 100)}%"></span></div><b class="stat-num">${Math.round(v * 100)}</b></div>`;
    const canBuy = sel.unlock.type === 'credits' && s.credits >= sel.unlock.cost;
    const unlockBlock = unlocked(sel)
      ? (sel.id === s.selectedAircraft
        ? '<div class="muted" style="font-size:.76rem">Currently selected</div>'
        : `<button class="btn btn-primary" data-select-craft="${sel.id}">Select</button>`)
      : (sel.unlock.type === 'credits'
        ? `<div class="daily-best">${nf(sel.unlock.cost)} ◈ · you have ${nf(s.credits)}</div>
           <button class="btn ${canBuy ? 'btn-primary' : 'disabled'}" data-buy-craft="${sel.id}">Unlock</button>`
        : `<div class="daily-best">${sel.unlock.label}</div>`);

    return `${this._head('HANGAR', 'Ten airframes with genuinely different geometry, mass and handling. The silhouette tells you how it flies.')}
      <div class="hangar">
        <div class="hangar-list stagger">${list}</div>
        <aside class="hangar-detail">
          <h3>${sel.name}</h3>
          <div class="hangar-class">${sel.class}</div>
          ${jetSilhouette(sel)}
          <div class="hangar-desc">${sel.desc}</div>
          <div class="hangar-ability"><b>${sel.ability}</b></div>
          <div class="stat-list">
            ${statRow('Speed', sel.stats.speed)}
            ${statRow('Accel', sel.stats.accel)}
            ${statRow('Handling', sel.stats.handling)}
            ${statRow('Boost', sel.stats.boost)}
            ${statRow('Durability', sel.stats.durability)}
          </div>
          <div class="hangar-unlock">${unlockBlock}</div>
          <div class="hangar-hint">Drag to rotate the preview</div>
        </aside>
      </div>`;
  }

  _panelCampaign() {
    const s = this.save.data;
    const prog = s.campaignProgress || 0;
    const rows = CAMPAIGN.map((c) => {
      const cleared = c.id <= prog;
      const locked = c.id > prog + 1;
      const b = BIOMES_BY_ID[c.biome];
      return `<div class="chapter${cleared ? ' cleared' : ''}${locked ? ' locked' : ''}" ${locked ? '' : `data-chapter="${c.id}"`}>
        <div class="chapter-num">${cleared ? '✓' : c.id}</div>
        <div class="chapter-body">
          <b>${c.name}${c.boss ? ' — BOSS' : ''}</b>
          <span>${c.desc}</span>
          <div class="chapter-meta">
            <span class="daily-pill">${b.short}</span>
            <span class="daily-pill">${WEATHER[c.weather].name}</span>
            <span class="daily-pill">${DIFFICULTIES[c.diff].name}</span>
            <span class="daily-pill">${c.laps} LAP${c.laps > 1 ? 'S' : ''}</span>
            <span class="daily-pill hot">${c.goal.type === 'position' ? `TOP ${c.goal.value}` : 'OBJECTIVE'}</span>
          </div>
        </div>
        <div class="chapter-reward">${nf(c.reward)} ◈</div>
      </div>`;
    }).join('');
    return `${this._head('CAMPAIGN', `Nine chapters across the circuit. ${prog} of ${CAMPAIGN.length} cleared.`)}
      <div class="card-grid" style="grid-template-columns:1fr;gap:9px">${rows}</div>`;
  }

  _panelDaily() {
    const d = this.callbacks.getDaily?.();
    if (!d) return this._head('DAILY CHALLENGE', 'Unavailable.');
    const s = this.save.data;
    const done = s.dailyState.date === d.dateKey && s.dailyState.completed;
    return `${this._head('DAILY CHALLENGE', 'A new seed, venue, objective and modifier every day. Same route for everyone, all day.')}
      <div class="daily-card">
        <div class="daily-tag">DAILY CHALLENGE · ${d.dateKey}</div>
        <div class="daily-title">${d.biome.name} + ${WEATHER[d.weather].name}</div>
        <div class="daily-line">
          <span class="daily-pill">${MODES[d.mode].name}</span>
          <span class="daily-pill">${DIFFICULTIES[d.difficulty].name}</span>
          <span class="daily-pill hot">${d.modifier.name}</span>
          <span class="daily-pill hot">×${d.scoreMultiplier.toFixed(1)} SCORE</span>
        </div>
        <div class="daily-obj">${d.objective.label}</div>
        <div class="daily-foot">
          <div class="daily-best">Today's best: <b class="mono">${nf(s.dailyState.date === d.dateKey ? s.dailyState.best : 0)}</b>${done ? ' · <span class="good">COMPLETED</span>' : ''}</div>
          <button class="btn btn-primary" data-daily="1">Fly Daily Challenge</button>
        </div>
      </div>`;
  }

  _panelAchievements() {
    const s = this.save.data;
    const rows = ACHIEVEMENTS.map((a) => {
      const done = s.achievements.includes(a.id);
      return `<div class="ach-row${done ? ' done' : ''}">
        <div class="ach-badge">${done ? '✓' : '✦'}</div>
        <div class="ach-body"><b>${a.name}</b><span>${a.desc}</span></div>
        <div class="ach-reward">${nf(a.reward)} ◈</div>
      </div>`;
    }).join('');
    const got = s.achievements.length;
    return `${this._head('ACHIEVEMENTS', `${got} of ${ACHIEVEMENTS.length} unlocked.`)}
      <div class="card-grid" style="grid-template-columns:1fr;gap:8px">${rows}</div>`;
  }

  _panelStats() {
    const st = this.save.data.stats;
    const tiles = [
      ['Runs Flown', nf(st.totalRuns)], ['Total Distance', `${(st.totalDistance / 1000).toFixed(1)} km`],
      ['Total Score', nf(st.totalScore)], ['Air Time', formatTime(st.totalTime, false)],
      ['Checkpoints', nf(st.totalCheckpoints)], ['Rings', nf(st.totalRings)],
      ['Near Misses', nf(st.totalNearMisses)], ['Overtakes', nf(st.totalOvertakes)],
      ['Wins', nf(st.wins)], ['Podiums', nf(st.podiums)], ['Crashes', nf(st.crashes)],
      ['Best Score', nf(st.bestScore)], ['Best Distance', `${(st.bestDistance / 1000).toFixed(2)} km`],
      ['Top Speed', `${nf(st.bestSpeedKmh)} km/h`], ['Best Combo', `×${st.bestCombo}`],
      ['Clean Streak', nf(st.bestCleanStreak)], ['Longest Survival', formatTime(st.bestSurvivalTime, false)],
      ['Venues Visited', `${Object.keys(st.biomesVisited || {}).length} / ${BIOMES.length}`],
    ].map(([k, v]) => `<div class="stat-tile"><i>${k}</i><b>${v}</b></div>`).join('');
    return `${this._head('STATISTICS', 'Everything you have done across every run, stored locally on this device.')}
      <div class="stat-grid">${tiles}</div>
      <div style="margin-top:22px"><button class="btn btn-danger" data-reset="1">Reset All Progress</button></div>`;
  }

  _panelHowTo() {
    const powers = POWERS.map((p) => `<div class="howto-row"><span class="kbd"><b>NUM ${p.slot}</b></span><span><b style="color:${hex(p.color)}">${p.name}</b> — ${p.desc} <i class="muted">(${p.cooldown}s)</i></span></div>`).join('');
    return `${this._head('HOW TO PLAY', 'Everything you need in one screen.')}
      <div class="howto-grid">
        <div class="howto-block">
          <h4>Flight</h4>
          <div class="howto-row"><span class="kbd"><b>W / ↑</b></span><span>Pitch up — also feeds the throttle</span></div>
          <div class="howto-row"><span class="kbd"><b>S / ↓</b></span><span>Pitch down — also bleeds throttle</span></div>
          <div class="howto-row"><span class="kbd"><b>A / D</b></span><span>Roll left / right — this is how you turn</span></div>
          <div class="howto-row"><span class="kbd"><b>Q / E</b></span><span>Yaw left / right for fine corrections</span></div>
          <div class="howto-row"><span class="kbd"><b>SHIFT</b></span><span>Throttle up</span></div>
          <div class="howto-row"><span class="kbd"><b>C</b></span><span>Air brake — tightens your turn radius</span></div>
          <div class="howto-row"><span class="kbd"><b>SPACE</b></span><span>Boost</span></div>
        </div>
        <div class="howto-block"><h4>Powers</h4>${powers}</div>
        <div class="howto-block">
          <h4>System</h4>
          <div class="howto-row"><span class="kbd"><b>ESC</b></span><span>Pause</span></div>
          <div class="howto-row"><span class="kbd"><b>F</b></span><span>Fullscreen</span></div>
          <div class="howto-row"><span class="kbd"><b>V</b></span><span>Cycle camera — chase, wide, close, cockpit</span></div>
          <div class="howto-row"><span class="kbd"><b>F8</b></span><span>Debug overlay (seed, FPS, draw calls)</span></div>
        </div>
        <div class="howto-block">
          <h4>Scoring</h4>
          <div class="howto-row"><span class="kbd"><b>Gates</b></span><span>Clear checkpoints in order. Dead-centre earns a precision bonus.</span></div>
          <div class="howto-row"><span class="kbd"><b>Rings</b></span><span>Boost rings refill the meter; precision rings pay the most.</span></div>
          <div class="howto-row"><span class="kbd"><b>Near miss</b></span><span>Pass close to an obstacle without touching it to build combo.</span></div>
          <div class="howto-row"><span class="kbd"><b>Combo</b></span><span>Keep scoring to hold the multiplier. It decays after ~4.5s of nothing.</span></div>
          <div class="howto-row"><span class="kbd"><b>Overtake</b></span><span>Every position gained is worth serious points.</span></div>
        </div>
      </div>`;
  }

  _panelCredits() {
    return `${this._head('CREDITS', `${GAME_NAME} v${VERSION}`)}
      <div class="credits-body">
        <p>An original browser racing game. Every aircraft, terrain heightfield, cloud, gate, texture, sound and piece of music in this build is generated procedurally at runtime — there are no downloaded art or audio assets.</p>
        <h4>Engine</h4>
        <p>Rendering runs on three.js (MIT, © three.js authors), vendored locally in <span class="mono">/vendor/three</span>. Everything else — flight model, procedural world generator, AI, audio synthesis, UI — is bespoke to this project.</p>
        <h4>Systems</h4>
        <p>Seeded route generation · geo-clipmap terrain · streamed world chunks · adaptive quality scaling · Web Audio synthesis · path-space rival AI.</p>
        <h4>3D Asset Pipeline</h4>
        <p>A Tripo3D generation utility ships in <span class="mono">/tools/tripo</span>. It reads asset definitions, submits generation jobs, polls, downloads, validates and writes an asset manifest into <span class="mono">/Assets/3d</span>. The game loads those models when the manifest lists them and falls back to its procedural airframes when it does not, so the build is always playable. The API key is read from the <span class="mono">TRIPO_API_KEY</span> environment variable and never reaches the browser.</p>
        <h4>Notes</h4>
        <p>Progress, settings and records are stored in this browser's local storage only. Nothing is uploaded anywhere.</p>
      </div>`;
  }

  _wirePanel() {
    const p = this.dom.menuPanel;
    p.querySelectorAll('.card, .chapter, .btn').forEach((n) => {
      n.addEventListener('pointerenter', () => this.audio.ui('hover'));
    });
    const pick = (sel, fn) => p.querySelectorAll(sel).forEach((n) => n.addEventListener('click', (e) => {
      e.preventDefault(); this.audio.ui('select'); fn(n);
    }));
    pick('[data-jump]', (n) => this.setSection(n.dataset.jump));
    pick('[data-mode]', (n) => { this.save.set('selectedMode', n.dataset.mode); this._renderMenuPanel(); });
    pick('[data-difficulty]', (n) => { this.save.set('selectedDifficulty', n.dataset.difficulty); this._renderMenuPanel(); });
    pick('[data-location]', (n) => { this.save.set('selectedLocation', n.dataset.location); this._renderMenuPanel(); });
    pick('[data-craft]', (n) => {
      this.hangarSelection = n.dataset.craft;
      this.callbacks.onHangarPreview?.(this.hangarSelection);
      this._renderMenuPanel();
    });
    this._wireHangarDrag();
    pick('[data-select-craft]', (n) => {
      this.save.set('selectedAircraft', n.dataset.selectCraft);
      this.audio.ui('confirm'); this._renderMenuPanel();
      this.callbacks.onAircraftChange?.(n.dataset.selectCraft);
    });
    pick('[data-buy-craft]', (n) => {
      const ok = this.callbacks.onBuyAircraft?.(n.dataset.buyCraft);
      this.audio.ui(ok ? 'unlock' : 'error');
      this._renderMenuPanel();
    });
    pick('[data-chapter]', (n) => this.callbacks.onLaunchCampaign?.(+n.dataset.chapter));
    pick('[data-daily]', () => this.callbacks.onLaunchDaily?.());
    pick('[data-reset]', () => {
      if (confirm('Reset all progress, unlocks, records and settings? This cannot be undone.')) {
        this.callbacks.onResetProgress?.();
      }
    });
  }

  /** Drag anywhere on the hangar panel to spin the live 3D preview. */
  _wireHangarDrag() {
    if (this.menuSection !== 'aircraft') return;
    const host = $('.hangar', this.dom.menuPanel);
    if (!host || host.dataset.dragWired) return;
    host.dataset.dragWired = '1';
    let dragging = false, lastX = 0, moved = 0;
    host.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;      // let card clicks through
      dragging = true; lastX = e.clientX; moved = 0;
      host.setPointerCapture?.(e.pointerId);
      host.style.cursor = 'grabbing';
    });
    host.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      moved += Math.abs(dx);
      this.callbacks.onHangarSpin?.(-dx / 260);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      host.releasePointerCapture?.(e.pointerId);
      host.style.cursor = '';
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
    host.addEventListener('pointerleave', end);
  }

  refreshLoadout() {
    const s = this.save.data;
    const mode = MODES[s.selectedMode];
    const diff = DIFFICULTIES[s.selectedDifficulty];
    const loc = s.selectedLocation === 'random' ? 'Random' : BIOMES_BY_ID[s.selectedLocation].short;
    const craft = AIRCRAFT_BY_ID[s.selectedAircraft];
    this.dom.loadout.innerHTML = [
      ['Mode', mode.name], ['Difficulty', diff.name], ['Location', loc], ['Airframe', craft.name],
    ].map(([k, v]) => `<div class="loadout-chip"><i>${k}</i><b>${v}</b></div>`).join('');
    this.dom.launchSub.textContent = `${mode.name} · ${diff.name} · ${loc}`;
    this.dom.credits.textContent = nf(s.credits);
  }

  /* =====================================================================
   * SETTINGS
   * ================================================================== */
  _renderSettingsInto(root, inMenu) {
    const s = this.save.data.settings;
    root.innerHTML = '';
    if (inMenu) root.appendChild(el('div', 'panel-head', '<h2>SETTINGS</h2><p>Graphics, audio, gameplay and controls. Changes apply immediately and are saved to this device.</p>'));

    const group = (title) => {
      const g = el('div', 'settings-group');
      g.appendChild(el('h3', null, title));
      root.appendChild(g);
      return g;
    };
    const field = (parent, label, hint, control) => {
      const f = el('div', 'field');
      f.appendChild(el('div', 'field-label', `<b>${label}</b><i>${hint}</i>`));
      const c = el('div', 'field-control');
      c.appendChild(control);
      f.appendChild(c);
      parent.appendChild(f);
      return f;
    };
    const slider = (key, min, max, step, fmt) => {
      const wrap = el('div', 'field-control');
      const inp = el('input');
      inp.type = 'range'; inp.className = 'range';
      inp.min = min; inp.max = max; inp.step = step; inp.value = s[key];
      const out = el('span', 'range-value', fmt(s[key]));
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        out.textContent = fmt(v);
        this.save.setSetting(key, v);
        this.audio.ui('slider', { value: (v - min) / (max - min) });
        this.callbacks.onSettingsChange?.(key, v);
      });
      wrap.appendChild(inp); wrap.appendChild(out);
      return wrap;
    };
    const toggle = (key) => {
      const t = el('div', `switch${s[key] ? ' on' : ''}`);
      t.setAttribute('role', 'switch');
      t.tabIndex = 0;
      const flip = () => {
        const v = !this.save.data.settings[key];
        t.classList.toggle('on', v);
        this.save.setSetting(key, v);
        this.audio.ui('toggle', { on: v });
        this.callbacks.onSettingsChange?.(key, v);
      };
      t.addEventListener('click', flip);
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
      return t;
    };
    const seg = (key, options) => {
      const g = el('div', 'seg');
      options.forEach(([val, label]) => {
        const b = el('button', s[key] === val ? 'active' : '', label);
        b.type = 'button';
        b.addEventListener('click', () => {
          this.save.setSetting(key, val);
          $$('button', g).forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          this.audio.ui('select');
          this.callbacks.onSettingsChange?.(key, val);
        });
        g.appendChild(b);
      });
      return g;
    };

    /* -- graphics -- */
    const gg = group('Graphics');
    field(gg, 'Quality Preset', 'Medium is the shipping default and still runs the full effect stack.',
      seg('graphics', QUALITY_ORDER.map((q) => [q, QUALITY_PRESETS[q].label])));
    field(gg, 'Resolution Scale', 'Renders below native resolution to buy frame time.',
      slider('resolutionScale', 0.5, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`));
    field(gg, 'Shadows', 'Sun shadows on terrain and aircraft.', toggle('shadows'));
    field(gg, 'Reflections', 'Live environment map — drives metal and glass.', toggle('reflections'));
    field(gg, 'Bloom', 'Glow on engines, gates and highlights.', toggle('bloom'));
    field(gg, 'Motion Blur', 'Speed smear and speed lines at velocity.', toggle('motionBlur'));
    field(gg, 'Extra Effects', 'Chromatic aberration and film grain.', toggle('effects'));
    field(gg, 'Particles', 'VFX particle budget.', slider('particles', 0.2, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`));
    field(gg, 'View Distance', 'How far the world streams and draws.', slider('viewDistance', 0.5, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`));
    field(gg, 'Cloud Quality', 'Cloud cluster density and detail.', slider('cloudQuality', 0.2, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`));
    field(gg, 'Weather Quality', 'Rain, snow and dust particle counts.', slider('weatherQuality', 0.0, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`));

    /* -- audio -- */
    const ag = group('Audio');
    field(ag, 'Master', 'Overall output level.', slider('masterVolume', 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`));
    field(ag, 'Music', 'Adaptive generative score.', slider('musicVolume', 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`));
    field(ag, 'Effects', 'Impacts, gates, powers, UI.', slider('sfxVolume', 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`));
    field(ag, 'Commentary', 'Race commentary voice.', slider('commentaryVolume', 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`));
    field(ag, 'Environment', 'Engine, wind and weather bed.', slider('environmentVolume', 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`));

    /* -- gameplay -- */
    const pg = group('Gameplay');
    field(pg, 'Flight Sensitivity', 'Control input scaling.', slider('flightSensitivity', 0.4, 1.8, 0.05, (v) => `${v.toFixed(2)}×`));
    field(pg, 'Camera Sensitivity', 'Chase camera responsiveness.', slider('cameraSensitivity', 0.4, 1.8, 0.05, (v) => `${v.toFixed(2)}×`));
    field(pg, 'HUD Scale', 'Size of every HUD element.', slider('hudScale', 0.75, 1.4, 0.05, (v) => `${Math.round(v * 100)}%`));
    field(pg, 'Invert Pitch', 'Flip the pitch axis.', toggle('invertPitch'));
    field(pg, 'Vibration', 'Haptic feedback on impacts (supported devices).', toggle('vibration'));
    field(pg, 'Subtitles', 'Show commentary and announcements as text.', toggle('subtitles'));
    field(pg, 'Reduced Motion', 'Damps camera shake, blur and UI animation.', toggle('reducedMotion'));
    field(pg, 'Debug Overlay', 'Show FPS, seed, draw calls and world stats.', toggle('showDebug'));

    /* -- controls -- */
    const cg = group('Controls');
    const bindHost = el('div');
    cg.appendChild(bindHost);
    this._renderBindings(bindHost);
    const resetRow = el('div', 'field');
    const resetBtn = el('button', 'btn btn-ghost', 'Reset to defaults');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', () => {
      this.input.resetBindings();
      this.save.setSetting('bindings', null);
      this.audio.ui('back');
      this._renderBindings(bindHost);
    });
    resetRow.appendChild(el('div', 'field-label', '<b>Key Bindings</b><i>Click a binding, then press a key.</i>'));
    const rc = el('div', 'field-control'); rc.appendChild(resetBtn); resetRow.appendChild(rc);
    cg.insertBefore(resetRow, bindHost);

    if (this.device.isTouch) {
      const tg = group('Touch');
      field(tg, 'On-screen Controls', 'Virtual stick, boost, brake and power buttons.', toggle('touchControls'));
    }
    const sysg = group('System');
    const fsBtn = el('button', 'btn', 'Toggle Fullscreen');
    fsBtn.type = 'button';
    fsBtn.addEventListener('click', () => this.toggleFullscreen());
    field(sysg, 'Fullscreen', 'Also bound to F.', fsBtn);
  }

  _renderBindings(host) {
    host.innerHTML = '';
    const b = this.input.bindings;
    for (const [action, label] of Object.entries(BINDING_LABELS)) {
      const row = el('div', 'binding-row');
      row.appendChild(el('span', null, label));
      const btn = el('button', 'btn bind-btn', (b[action] || []).map(prettyKey).join(' / ') || '—');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (this.listeningFor) return;
        this.listeningFor = action;
        btn.classList.add('listening');
        btn.textContent = 'Press a key…';
        this.audio.ui('click');
        this.input.captureKey((code) => {
          this.input.rebind(action, code);
          this.save.setSetting('bindings', this.input.bindings);
          this.listeningFor = null;
          this.audio.ui('confirm');
          this._renderBindings(host);
        });
      });
      row.appendChild(btn);
      host.appendChild(row);
    }
  }

  openOverlay(title, builder) {
    this.dom.overlayTitle.textContent = title;
    this.dom.overlayBody.innerHTML = '';
    builder(this.dom.overlayBody);
    this.dom.overlay.classList.add('active');
  }
  closeOverlay() { this.dom.overlay.classList.remove('active'); this.audio.ui('back'); }
  openSettings() { this.openOverlay('Settings', (root) => this._renderSettingsInto(root, false)); }
  openControls() {
    this.openOverlay('Controls', (root) => {
      root.innerHTML = this._panelHowTo();
      const host = el('div', 'settings-group');
      host.appendChild(el('h3', null, 'Key Bindings'));
      const bh = el('div');
      host.appendChild(bh);
      root.appendChild(host);
      this._renderBindings(bh);
    });
  }

  /* =====================================================================
   * HUD — built once, updated per frame
   * ================================================================== */
  _buildCompass() {
    const tape = this.dom.compassTape;
    tape.innerHTML = '';
    const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    // Two full revolutions so the strip can scroll without a visible seam.
    for (let i = 0; i < 144; i++) {
      const deg = (i * 5) % 360;
      const major = deg % 45 === 0;
      const t = el('div', `ctick${major ? ' major' : ''}`);
      if (major) t.appendChild(el('span', 'clabel', labels[deg] || String(deg)));
      tape.appendChild(t);
    }
  }

  _buildGauges() {
    this.spdArc = $('#spd-arc');
    this.altArc = $('#alt-arc');
    for (const arc of [this.spdArc, this.altArc]) {
      const len = arc.getTotalLength ? arc.getTotalLength() : 300;
      arc.dataset.len = len;
      arc.style.strokeDasharray = `${len}`;
      arc.style.strokeDashoffset = `${len}`;
    }
    const mkTicks = (host, x, dir) => {
      const g = $(host);
      if (!g) return;
      let html = '';
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const a = lerp(-58.6, 58.6, t) * Math.PI / 180;
        const cx = dir > 0 ? -54 : 174;
        const R = 150;
        const px = cx + Math.cos(a) * R * dir * -1;
        const py = 150 + Math.sin(a) * R;
        const inner = i % 5 === 0 ? 9 : 5;
        const px2 = px + (dir > 0 ? inner : -inner);
        html += `<line class="${i % 5 === 0 ? 'major' : ''}" x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${px2.toFixed(1)}" y2="${py.toFixed(1)}"/>`;
      }
      g.innerHTML = html;
    };
    mkTicks('#spd-ticks', 96, 1);
    mkTicks('#alt-ticks', 24, -1);
  }

  _buildPowerRack() {
    this.dom.powerRack.innerHTML = '';
    this.dom.touchPowers.innerHTML = '';
    this.powerCells = [];
    this.touchPowerCells = [];
    POWERS.forEach((p, i) => {
      const cell = el('div', 'power-cell', `
        <div class="pk">NUM ${p.slot}</div>
        <div class="pi" style="color:${hex(p.color)}">${ICONS[p.icon]}</div>
        <div class="pn">${p.short}</div>
        <div class="cd"></div>
        <div class="cdnum">0</div>`);
      cell.title = `${p.name} — ${p.desc}`;
      this.dom.powerRack.appendChild(cell);
      this.powerCells.push({ root: cell, cd: $('.cd', cell), num: $('.cdnum', cell), wasReady: true });

      const tp = el('button', 'tbtn touch-power', `
        <span class="tp-num">${p.slot}</span>
        <span class="tp-name">${p.short}</span>
        <span class="tp-cd"></span>`);
      tp.type = 'button';
      tp.dataset.touch = `power${i + 1}`;
      this.dom.touchPowers.appendChild(tp);
      this.touchPowerCells.push({ root: tp, cd: $('.tp-cd', tp) });
    });
  }

  /** Per-frame HUD refresh. Only touches the DOM when a value actually moved. */
  updateHUD(s) {
    if (!this.hudVisible) return;
    const c = this._hudCache || (this._hudCache = {});
    const set = (key, node, value) => {
      if (c[key] === value) return;
      c[key] = value;
      node.textContent = value;
    };

    // Solo modes have no grid — show the checkpoint count in that slot instead
    // of a meaningless "1 / 1".
    const solo = s.gridSize <= 1;
    set('pos', $('#hud-pos'), solo ? String(s.checkpoints) : String(s.position));
    set('grid', $('#hud-grid'), solo ? 'GATES' : `/ ${s.gridSize}`);
    set('posLabel', $('.hud-position .hud-label'), solo ? 'CHECKPOINTS' : 'POSITION');
    set('score', $('#hud-score'), nf(s.score));
    set('dist', $('#hud-distance'), `${(s.distance / 1000).toFixed(2)} km`);
    set('cps', $('#hud-checkpoints'), String(s.checkpoints));
    set('spd', $('#hud-speed'), String(Math.round(s.speedKmh)));
    set('alt', $('#hud-altitude'), String(Math.round(s.altitude)));
    set('hdg', $('#hud-heading'), String(Math.round(s.heading)).padStart(3, '0'));
    set('timer', $('#hud-timer'), s.timerText);
    set('timerLabel', $('#hud-timer-label'), s.timerLabel);
    set('best', $('#hud-best'), s.bestText);
    set('penalty', $('#hud-penalty'), s.penaltyText);

    // combo
    const comboEl = $('#hud-combo');
    const comboTxt = `x${s.combo.toFixed(1)}`;
    if (c.combo !== comboTxt) {
      c.combo = comboTxt;
      comboEl.textContent = comboTxt;
      comboEl.classList.add('bump');
      setTimeout(() => comboEl.classList.remove('bump'), 130);
    }
    comboEl.classList.toggle('hot', s.combo >= 2.2);

    // gauges
    const spdT = clamp01(s.speedKmh / 2400);
    const altT = clamp01(s.altitude / 6000);
    const sLen = +this.spdArc.dataset.len;
    const aLen = +this.altArc.dataset.len;
    this.spdArc.style.strokeDashoffset = `${sLen * (1 - spdT)}`;
    this.altArc.style.strokeDashoffset = `${aLen * (1 - altT)}`;
    $('#hud-altitude').classList.toggle('danger', s.agl < 160);

    // compass
    const idx = ((s.heading % 360) + 360) % 360;
    const px = (this.dom.compassTape.parentElement.clientWidth / 2) - ((idx + 360) / 5) * 22 - 11;
    this.dom.compassTape.style.transform = `translateX(${px.toFixed(1)}px)`;

    // bars
    $('#boost-fill').style.width = `${clamp01(s.boost) * 100}%`;
    const hull = $('#hull-fill');
    hull.style.width = `${clamp01(s.hull) * 100}%`;
    const hullBar = hull.parentElement;
    hullBar.classList.toggle('warn', s.hull < 0.5 && s.hull >= 0.25);
    hullBar.classList.toggle('crit', s.hull < 0.25);
    set('hullPct', $('#hull-pct'), `${Math.round(s.hull * 100)}%`);

    // altitude tape
    $('#alt-tape-fill').style.height = `${altT * 100}%`;
    $('#alt-tape-mark').style.bottom = `${clamp01(s.aglNorm) * 100}%`;

    // damage vignette
    const dv = this.dom.damageVig;
    dv.style.opacity = String(clamp01((1 - s.hull - 0.35) / 0.65) * 0.9);
    dv.classList.toggle('crit', s.hull < 0.22);

    // terrain warning
    const warn = this.dom.warn;
    const warnText = s.agl < 110 ? 'PULL UP' : (s.corridorOut > 1.35 ? 'OFF ROUTE' : (s.hull < 0.22 ? 'HULL CRITICAL' : ''));
    if (warnText !== c.warn) {
      c.warn = warnText;
      warn.textContent = warnText;
      warn.classList.toggle('show', !!warnText);
      if (warnText) this.audio.play('warn');
    }

    // objective
    if (s.objective) {
      set('objText', $('#obj-text'), s.objective.text);
      set('objMode', $('#obj-mode'), s.modeName);
      $('#obj-bar-fill').style.width = `${clamp01(s.objective.progress) * 100}%`;
      $('#objective-card').classList.toggle('done', s.objective.complete);
    }

    // powers
    for (let i = 0; i < this.powerCells.length; i++) {
      const p = s.powers[i];
      const cell = this.powerCells[i];
      const t = this.touchPowerCells[i];
      const coolPct = p.cooldown > 0 ? clamp01(p.cooldown / (p.total || 1)) : 0;
      cell.cd.style.height = `${coolPct * 100}%`;
      if (t) t.cd.style.height = `${coolPct * 100}%`;
      const cooling = p.cooldown > 0.05;
      cell.root.classList.toggle('cooling', cooling);
      cell.root.classList.toggle('ready', !cooling && p.active <= 0);
      cell.root.classList.toggle('active', p.active > 0);
      if (t) { t.root.classList.toggle('ready', !cooling); t.root.classList.toggle('active', p.active > 0); }
      if (cooling) {
        const txt = String(Math.ceil(p.cooldown));
        if (cell.num.textContent !== txt) cell.num.textContent = txt;
        cell.wasReady = false;
      } else if (!cell.wasReady) {
        cell.wasReady = true;
        cell.root.classList.add('just-ready');
        setTimeout(() => cell.root.classList.remove('just-ready'), 620);
      }
    }

    // checkpoint marker
    this._updateCheckpointMarker(s.checkpointMarker);
    this._drawRadar(s);
  }

  _updateCheckpointMarker(m) {
    const marker = this.dom.cpMarker;
    const off = this.dom.cpOff;
    if (!m) { marker.classList.remove('show'); off.classList.remove('show'); return; }
    if (m.onScreen) {
      off.classList.remove('show');
      marker.classList.add('show');
      marker.style.left = `${(m.x * 100).toFixed(2)}%`;
      marker.style.top = `${(m.y * 100).toFixed(2)}%`;
      const dText = m.distance >= 1000 ? `${(m.distance / 1000).toFixed(1)} KM` : `${Math.round(m.distance)} M`;
      if (this._cpDist !== dText) { this._cpDist = dText; $('#cp-distance').textContent = dText; }
      if (this._cpLabel !== m.label) { this._cpLabel = m.label; $('#cp-label').textContent = m.label; }
    } else {
      marker.classList.remove('show');
      off.classList.add('show');
      // Park the arrow on the edge of a centred ellipse, pointing at the gate.
      const a = m.angle;
      const rx = 38, ry = 34;
      off.style.left = `${50 + Math.cos(a) * rx}%`;
      off.style.top = `${50 + Math.sin(a) * ry}%`;
      off.style.transform = `rotate(${a * 180 / Math.PI + 90}deg)`;
    }
  }

  /* ---- radar ------------------------------------------------------------ */
  _drawRadar(s) {
    const ctx = this.radarCtx;
    if (!ctx) return;
    const W = this.dom.radar.width, H = this.dom.radar.height;
    const cx = W / 2, cy = H / 2, R = W / 2 - 8;
    const range = s.radarRange || 3200;
    ctx.clearRect(0, 0, W, H);

    // frame
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.closePath();
    ctx.fillStyle = 'rgba(5,11,18,0.55)'; ctx.fill();
    ctx.clip();

    ctx.strokeStyle = 'rgba(140,200,235,0.16)';
    ctx.lineWidth = 1.4;
    for (const f of [0.33, 0.66, 1.0]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, TAU); ctx.stroke(); }
    ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
    ctx.setLineDash([]);

    const toRadar = (dx, dz) => {
      // North-up radar: world +Z is north, world +X is east.
      const x = cx + (dx / range) * R;
      const y = cy - (dz / range) * R;
      return [x, y];
    };

    // route ahead
    if (s.radarPath && s.radarPath.length > 1) {
      ctx.strokeStyle = 'rgba(57,245,255,0.45)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      s.radarPath.forEach((p, i) => {
        const [x, y] = toRadar(p[0], p[1]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // obstacles
    if (s.radarObstacles) {
      ctx.fillStyle = 'rgba(255,120,80,0.42)';
      for (const o of s.radarObstacles) {
        const [x, y] = toRadar(o[0], o[1]);
        ctx.beginPath(); ctx.arc(x, y, 2.4, 0, TAU); ctx.fill();
      }
    }
    // traffic
    if (s.radarTraffic) {
      ctx.fillStyle = 'rgba(220,235,250,0.62)';
      for (const o of s.radarTraffic) {
        const [x, y] = toRadar(o[0], o[1]);
        ctx.fillRect(x - 2, y - 2, 4, 4);
      }
    }
    // rivals — colour by whether they are ahead of or behind the player
    if (s.radarRivals) {
      for (const r of s.radarRivals) {
        const [x, y] = toRadar(r[0], r[1]);
        ctx.fillStyle = r[2] > 0 ? 'rgba(255,80,100,0.95)' : 'rgba(255,182,72,0.9)';
        ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fill();
        // altitude offset tick
        const dy = clamp(r[3] / 400, -1, 1) * 6;
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - dy); ctx.stroke();
      }
    }
    // checkpoints
    if (s.radarCheckpoints) {
      ctx.strokeStyle = 'rgba(157,255,74,0.95)';
      ctx.lineWidth = 2;
      s.radarCheckpoints.forEach((p, i) => {
        const [x, y] = toRadar(p[0], p[1]);
        ctx.beginPath(); ctx.arc(x, y, i === 0 ? 7 : 4.5, 0, TAU); ctx.stroke();
        if (i === 0) { ctx.fillStyle = 'rgba(157,255,74,0.30)'; ctx.fill(); }
      });
    }
    ctx.restore();

    // player arrow (rotates with heading)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(s.heading * Math.PI / 180);
    ctx.fillStyle = '#9dff4a';
    ctx.shadowColor = 'rgba(157,255,74,0.9)'; ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(6.5, 8); ctx.lineTo(0, 4.5); ctx.lineTo(-6.5, 8);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // rim
    ctx.strokeStyle = 'rgba(160,215,245,0.32)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  }

  /* =====================================================================
   * FEEDBACK
   * ================================================================== */
  notify(text, kind = '', value = null) {
    const n = el('div', `notif ${kind}`, `${text}${value != null ? `<b>${value}</b>` : ''}`);
    this.dom.notif.appendChild(n);
    this.notifications.push(n);
    while (this.notifications.length > 5) {
      const old = this.notifications.shift();
      old.remove();
    }
    setTimeout(() => {
      n.classList.add('leaving');
      setTimeout(() => { n.remove(); const i = this.notifications.indexOf(n); if (i >= 0) this.notifications.splice(i, 1); }, 220);
    }, 2400);
  }

  banner(title, sub = '') {
    const b = this.dom.banner;
    b.innerHTML = `${title}${sub ? `<small>${sub}</small>` : ''}`;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }

  subtitle(text) {
    if (!this.save.data.settings.subtitles) return;
    const s = this.dom.subtitle;
    s.textContent = text;
    s.classList.add('show');
    clearTimeout(this._subTimer);
    this._subTimer = setTimeout(() => s.classList.remove('show'), Math.max(2200, text.length * 62));
  }

  countdown(text, isGo = false) {
    const c = this.dom.countdown;
    c.textContent = text;
    c.classList.toggle('go', isGo);
    c.classList.remove('tick');
    void c.offsetWidth;
    c.classList.add('tick');
  }

  toast(text, kind = '') {
    const t = el('div', `toast ${kind}`, text);
    this.dom.toast.appendChild(t);
    setTimeout(() => { t.style.animation = 'toastOut 220ms var(--ease) both'; setTimeout(() => t.remove(), 240); }, 2600);
  }

  vibrate(ms) {
    if (!this.save.data.settings.vibration) return;
    try { navigator.vibrate?.(ms); } catch (e) { /* unsupported */ }
  }

  /* =====================================================================
   * PAUSE + RESULTS
   * ================================================================== */
  showPause(ctx, stats) {
    this.dom.pauseContext.textContent = ctx;
    this.dom.pauseStats.innerHTML = stats.map(([k, v]) => `<div class="stat-tile"><i>${k}</i><b>${v}</b></div>`).join('');
    this.showScreen('pause');
  }

  showResults(r) {
    const v = $('#results-verdict');
    v.textContent = r.verdict;
    v.className = `results-verdict ${r.win ? 'win' : r.lose ? 'lose' : ''}`;
    $('#results-reason').textContent = r.reason;

    $('#results-grid').innerHTML = r.tiles.map((t) => `
      <div class="result-tile${t.record ? ' record' : ''}">
        <i>${t.label}</i><b>${t.value}</b>
        ${t.record ? '<span class="rec-flag">NEW RECORD</span>' : ''}
      </div>`).join('');

    $('#results-objectives').innerHTML = (r.objectives || []).map((o) => `
      <div class="obj-result${o.complete ? ' done' : ''}">
        <span class="tick">${o.complete ? '✓' : '○'}</span>
        <span>${o.text}</span>
        <span style="margin-left:auto" class="mono">${o.detail || ''}</span>
      </div>`).join('');

    $('#results-rewards').innerHTML = (r.rewards || [])
      .map((x) => `<div class="reward-item">${x}</div>`).join('');

    this.showScreen('results');
  }

  /* =====================================================================
   * INPUT WIRING
   * ================================================================== */
  _bindStatic() {
    const click = (sel, fn) => { const n = typeof sel === 'string' ? $(sel) : sel; if (n) n.addEventListener('click', fn); };

    click('#ob-next', () => {
      if (this.obIndex === this.obCount - 1) { this.audio.ui('confirm'); this.callbacks.onOnboardingDone?.(); }
      else this._obGo(1);
    });
    click('#ob-skip', () => { this.audio.ui('back'); this.callbacks.onOnboardingDone?.(); });
    click('#btn-launch', () => { this.audio.ui('confirm'); this.callbacks.onLaunch?.(); });
    click('#btn-fullscreen', () => this.toggleFullscreen());
    click('#btn-mute', (e) => {
      const on = !this.audio.muted;
      this.audio.setMuted(on);
      e.currentTarget.classList.toggle('off', on);
      this.audio.ui('toggle', { on: !on });
    });
    click('#overlay-close', () => this.closeOverlay());

    $$('[data-pause]').forEach((b) => {
      b.addEventListener('pointerenter', () => this.audio.ui('hover'));
      b.addEventListener('click', () => {
        this.audio.ui('click');
        const a = b.dataset.pause;
        if (a === 'settings') this.openSettings();
        else if (a === 'controls') this.openControls();
        else this.callbacks.onPauseAction?.(a);
      });
    });
    $$('[data-result]').forEach((b) => {
      b.addEventListener('pointerenter', () => this.audio.ui('hover'));
      b.addEventListener('click', () => { this.audio.ui('click'); this.callbacks.onResultAction?.(b.dataset.result); });
    });
    $$('.icon-btn, .btn').forEach((b) => b.addEventListener('pointerenter', () => this.audio.ui('hover')));

    window.addEventListener('resize', () => this._applyBodyFlags());
    window.addEventListener('orientationchange', () => setTimeout(() => this._applyBodyFlags(), 120));
    document.addEventListener('fullscreenchange', () => {
      $('#btn-fullscreen').classList.toggle('off', !document.fullscreenElement);
      this.callbacks.onResize?.();
    });
  }

  _bindTouch() {
    const zone = $('#stick-zone');
    const base = $('#stick-base');
    const knob = $('#stick-knob');
    if (!zone) return;
    let active = null, ox = 0, oy = 0;
    const RADIUS = 58;

    const start = (e) => {
      const t = e.changedTouches ? e.changedTouches[0] : e;
      active = t.identifier ?? 'mouse';
      const r = zone.getBoundingClientRect();
      // Re-centre the stick under the finger wherever it lands.
      ox = clamp(t.clientX - r.left, 70, r.width - 20);
      oy = clamp(t.clientY - r.top, 20, r.height - 70);
      base.style.left = `${ox - 64}px`;
      base.style.bottom = `${r.height - oy - 64}px`;
      base.style.position = 'absolute';
      zone.classList.add('engaged');
      move(e);
    };
    const move = (e) => {
      if (active === null) return;
      const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
      const t = list.find((x) => (x.identifier ?? 'mouse') === active);
      if (!t) return;
      const r = zone.getBoundingClientRect();
      let dx = (t.clientX - r.left) - ox;
      let dy = (t.clientY - r.top) - oy;
      const d = Math.hypot(dx, dy);
      if (d > RADIUS) { dx *= RADIUS / d; dy *= RADIUS / d; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.input.setTouchAxis(dx / RADIUS, dy / RADIUS);
      e.preventDefault();
    };
    const end = (e) => {
      const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
      if (!list.some((x) => (x.identifier ?? 'mouse') === active)) return;
      active = null;
      knob.style.transform = 'translate(0,0)';
      zone.classList.remove('engaged');
      this.input.clearTouchAxis();
    };

    zone.addEventListener('touchstart', start, { passive: false });
    zone.addEventListener('touchmove', move, { passive: false });
    zone.addEventListener('touchend', end);
    zone.addEventListener('touchcancel', end);
    zone.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') start(e); });
    window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') move(e); });
    window.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') end(e); });

    // Buttons (delegated so power cells built later are covered).
    const host = this.dom.mobile;
    const press = (e, down) => {
      const btn = e.target.closest('[data-touch]');
      if (!btn) return;
      e.preventDefault();
      const name = btn.dataset.touch;
      btn.classList.toggle('held', down);
      if (name === 'pause') { if (down) this.callbacks.onPauseAction?.('toggle'); return; }
      this.input.setTouchButton(name, down);
      if (down) { this.audio.ui('click', { volume: 0.5 }); this.vibrate(12); }
    };
    host.addEventListener('touchstart', (e) => press(e, true), { passive: false });
    host.addEventListener('touchend', (e) => press(e, false));
    host.addEventListener('touchcancel', (e) => press(e, false));
    host.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') press(e, true); });
    host.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') press(e, false); });
  }

  _applyBodyFlags() {
    const b = document.body;
    b.classList.toggle('touch-mode', this.device.isTouch);
    b.classList.toggle('reduced-motion', !!this.save.data.settings.reducedMotion);
    document.documentElement.style.setProperty('--hud-scale', String(this.save.data.settings.hudScale || 1));
    const portrait = window.innerHeight > window.innerWidth;
    this.dom.orientation.classList.toggle('show', this.device.isTouch && portrait && window.innerWidth < 900);
  }

  toggleFullscreen() {
    this.audio.ui('click');
    try {
      if (!document.fullscreenElement) {
        (document.documentElement.requestFullscreen
          || document.documentElement.webkitRequestFullscreen
          || (() => {})).call(document.documentElement).catch?.(() => {});
        if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => {});
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
      }
    } catch (e) { this.toast('Fullscreen unavailable', 'warn'); }
  }

  setDebug(text, show) {
    this.dom.debug.classList.toggle('show', !!show);
    if (show) this.dom.debug.textContent = text;
  }

  applySettings() { this._applyBodyFlags(); }
}

function prettyKey(code) {
  if (!code) return '—';
  return code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad/, 'NUM ')
    .replace(/^Arrow/, '')
    .replace('ControlLeft', 'L-CTRL').replace('ControlRight', 'R-CTRL')
    .replace('ShiftLeft', 'L-SHIFT').replace('ShiftRight', 'R-SHIFT')
    .replace('Space', 'SPACE').replace('Escape', 'ESC')
    .toUpperCase();
}
