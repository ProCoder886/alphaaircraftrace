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
  DIFFICULTIES, DIFFICULTY_ORDER, POWERS, WEATHER, WEATHER_MENU, CAMPAIGN, ACHIEVEMENTS,
  STORY, STORY_BY_ID, STORY_ACTS, LOCATIONS_BY_ID,
  QUALITY_ORDER, QUALITY_PRESETS, BINDING_LABELS, DEFAULT_BINDINGS, TIPS,
  CONTROL_GROUPS, MACH, WEAPONS, GAME_NAME, VERSION, clamp, clamp01, lerp, TAU,
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
  lift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 20V5"/><path d="M6.5 10.5L12 4.6l5.5 5.9"/><path d="M5 20h14" opacity="0.55"/></svg>',
  maneuver: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 18c5-1 7-4 7-7 0-2.2-1.4-3.6-3-3.6-1.5 0-2.7 1.1-2.7 2.7"/><path d="M11 11c1.4 3.6 4 6 9 7"/><path d="M16.4 15.2L20 18l-3.6 2.8" fill="none"/></svg>',
  phase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12c0-4 3-7 7-7s7 3 7 7-3 7-7 7"/><path d="M9 5.5C6 7 4.5 9.3 4.5 12S6 17 9 18.5" stroke-dasharray="2.4 2.4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z"/></svg>',
  turbo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 3L5 13h5l-1 8 8-10h-5z" fill="currentColor" stroke="none"/></svg>',
  /* ---- control legend ---- */
  climb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 19V6"/><path d="M6.6 11.4L12 5.6l5.4 5.8"/></svg>',
  dive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 5v13"/><path d="M6.6 12.6L12 18.4l5.4-5.8"/></svg>',
  leanL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 9L11 13.5 4 10.5l7-2z"/><path d="M11 13.5v4l3 2"/></svg>',
  leanR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9l9 4.5 7-3-7-2z"/><path d="M13 13.5v4l-3 2"/></svg>',
  rollL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M19 12a7 7 0 1 0-2.4 5.3"/><path d="M5 8v4h4"/></svg>',
  rollR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12a7 7 0 1 1 2.4 5.3"/><path d="M19 8v4h-4"/></svg>',
  throttle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 19h16"/><path d="M7 19V9M12 19V5M17 19v-7"/></svg>',
  brake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><path d="M8.4 8.4l7.2 7.2M15.6 8.4l-7.2 7.2"/></svg>',
  gun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 10h11l3-2v6l-3-2H3z"/><path d="M17 12h4"/><path d="M6 14v3"/></svg>',
  missile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 4c-6 .6-10 3.4-13 7l3 3c3.6-3 6.4-7 10-10z"/><path d="M8 16l-3-3-2 6z"/><path d="M11 6l3 3"/></svg>',
  weaponSel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="6" width="17" height="5" rx="1.4"/><rect x="3.5" y="13" width="17" height="5" rx="1.4"/><path d="M7 8.5h3M7 15.5h3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/><circle cx="12" cy="12" r="2.6"/></svg>',
  laser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 12h7"/><circle cx="13" cy="12" r="2.2"/><path d="M16 12h5"/><path d="M13 5v3M13 16v3"/></svg>',
  grenade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="14.5" r="5.5"/><path d="M10 8.4V6.2h4v2.2"/><path d="M14 6.6l3.4-2.2 1.4 2.2"/></svg>',
  rpg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 12.5h9"/><path d="M12 9.4c3 0 5 1.6 6.4 3.1C17 14 15 15.6 12 15.6z"/><path d="M6 12.5v3.2"/><path d="M19 12.5h2"/></svg>',
  launch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3c2.6 2.6 3.8 6 3.8 9.4L12 16l-3.8-3.6C8.2 9 9.4 5.6 12 3z"/><path d="M9 18l3 3 3-3"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8.5h3.4L8 6.4h5.4L15 8.5H18a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="11.5" cy="13" r="3"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="7" y="5" width="3.4" height="14" rx="1"/><rect x="13.6" y="5" width="3.4" height="14" rx="1"/></svg>',
  play: '▶', mode: '◈', diff: '▲', loc: '◎', wx: '☁', craft: '✈', daily: '★',
  camp: '❐', ach: '✦', stats: '▤', set: '⚙', help: '?', cred: '©',
};

/* ---- procedural aircraft silhouette for menu cards -----------------------
 * A plan view drawn from the same `shape` block that builds the 3D mesh, so a
 * card genuinely previews the airframe you will fly. Everything is normalised
 * to a 100-unit fuselage and the viewBox is fitted to the drawn extents, so
 * wide-span frames read wide and long-bodied frames read long.
 * ----------------------------------------------------------------------- */
/**
 * Livery colours are chosen for the 3D airframe, where a near-black navy reads
 * beautifully against sky. On a dark card it disappears, so the silhouette
 * lifts anything too dark to a legible brightness without losing its hue.
 */
function legible(c) {
  let r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum >= 0.34) return `#${c.toString(16).padStart(6, '0')}`;
  const k = 0.34 / Math.max(0.04, lum);
  const mix = Math.min(1, (0.34 - lum) * 1.6);          // pull greys toward blue-white
  r = Math.min(255, Math.round(r * k * (1 - mix) + 150 * mix));
  g = Math.min(255, Math.round(g * k * (1 - mix) + 172 * mix));
  b = Math.min(255, Math.round(b * k * (1 - mix) + 196 * mix));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

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
    <svg class="mini-jet" viewBox="${-vw / 2} 0 ${vw} ${vh}" style="color:${legible(spec.colors.primary)}">
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
    /* The preset the renderer is actually running. Distinct from
       settings.graphics, which is null until the player picks one — this is
       what the Settings screen shows as active in that case. */
    this.activePreset = save.data.settings.graphics || null;
    this.notifications = [];
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
      camChip: $('#cam-chip'),
      zoomIn: $('#zoom-in'),
      zoomOut: $('#zoom-out'),
      zoomValue: $('#zoom-value'),
      camName: $('#cam-name'),
      countdown: $('#countdown'),
      warn: $('#warn-strip'),
      hazard: $('#hazard-strip'),
      hazardText: $('#hazard-text'),
      overheat: $('#overheat-strip'),
      overheatText: $('#overheat-text'),
      heatFill: $('#heat-fill'),
      damageVig: $('#damage-vignette'),
      compassTape: $('#compass-tape'),
      cpMarker: $('#cp-marker'),
      cpOff: $('#cp-offscreen'),
      powerRack: $('#power-rack'),
      touchPowers: $('#touch-powers'),
      targetLayer: $('#target-layer'),
      combat: $('#hud-combat'),
      lockStrip: $('#lock-strip'),
      lockText: $('#lock-text'),
      wpnName: $('#wpn-name'),
      wpnReload: $('#wpn-reload-fill'),
      wpnRack: $('#wpn-rack'),
      gunRack: $('#gun-rack'),
      cbtWave: $('#cbt-wave'),
      cbtKills: $('#cbt-kills'),
      cbtHostiles: $('#cbt-hostiles'),
      brief: $('#hud-brief'),
      controls: $('#hud-controls'),
      brief2: $('#mission-brief'),
      objHint: $('#obj-hint'),
      storyStrip: $('#story-strip'),
      storyMission: $('#story-mission'),
      storyPhase: $('#story-phase'),
      storyPips: $('#story-pips'),
      dialFlight: $('#dial-flight'),
      dialCombat: $('#dial-combat'),
      lockRange: $('#lock-range'),
      lockRangeValue: $('#lock-range-value'),
      machBlock: $('#hud-mach-block'),
      machValue: $('#hud-mach'),
      hudHide: $('#btn-hud-hide'),
      hudHideText: $('#btn-hud-hide-text'),
      touchGunName: $('#touch-gun-name'),
      touchMslName: $('#touch-msl-name'),
    };
    this.radarCtx = this.dom.radar.getContext('2d');

    this._buildCompass();
    this._buildGauges();
    this._buildPowerRack();
    this.buildControlLegend();
    this._buildOnboarding();
    this._buildMenuNav();
    // Through setSection rather than a bare _renderMenuPanel, so the launch
    // button's visibility is decided in exactly one place.
    this.setSection(this.menuSection);
    this._bindStatic();
    this._bindTouch();
    this._applyPanelState();
    this._applyBodyFlags();
    this.armFullscreenGesture();
    this.setTip();
  }

  on(callbacks) { Object.assign(this.callbacks, callbacks); }

  /* =====================================================================
   * SCREEN MANAGEMENT
   * ================================================================== */
  showScreen(name) {
    const map = {
      loading: this.dom.loading, onboarding: this.dom.onboarding,
      menu: this.dom.menu, pause: this.dom.pause, brief: this.dom.brief2,
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

  /**
   * Draw the always-on control legend top-left from the LIVE bindings, so a
   * rebound key shows its new cap without a reload.
   *
   * Three separate colour-coded boxes rather than one strip: nineteen controls
   * in a single row is a wall, and the thing a pilot actually needs mid-flight
   * is "where are the weapons" — which a red box answers before any of the
   * text is read. The combat box is omitted entirely in modes with no weapons.
   */
  buildControlLegend(showCombat = true) {
    const host = this.dom.controls;
    if (!host) return;
    this._legendCombat = showCombat;
    const binds = this.save.data.settings.bindings || {};
    const frag = document.createDocumentFragment();

    for (const group of CONTROL_GROUPS) {
      if (group.combat && !showCombat) continue;
      const box = el('div', `ctl-group tone-${group.tone}`);
      box.appendChild(el('div', 'ctl-group-name', group.name));
      const row = el('div', 'ctl-row');
      for (const entry of group.items) {
        const codes = binds[entry.action] || DEFAULT_BINDINGS[entry.action] || [];
        // Only the primary binding gets a cap — two caps per control turns the
        // legend back into the wall of text it is meant to replace.
        const cap = entry.keyOverride || prettyKey(codes[0]);
        const cell = el('div', 'ctl');
        cell.title = BINDING_LABELS[entry.action] || entry.short;
        cell.innerHTML = ICONS[entry.icon] || '';
        cell.appendChild(el('span', 'ctl-key', cap));
        cell.appendChild(el('span', 'ctl-name', entry.short));
        row.appendChild(cell);
      }
      box.appendChild(row);
      frag.appendChild(box);
    }
    host.replaceChildren(frag);
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
        body: 'Bank into the turn and pull — that is how a jet changes direction. Lean sideways to slide across a gate you are already lined up on. Follow the chevrons, clear every checkpoint, and keep the hull intact: contact costs speed and structure.',
        keys: [
          ['W / ↑', 'Pull · climb'], ['S / ↓', 'Push · dive'],
          ['A / D', 'Bank left / right'], ['Q / E', 'Lean left / right'],
          ['SPACE', 'Boost'], ['C', 'Change camera'],
        ],
        art: 'fly',
      },
      {
        step: 'STEP 3 OF 4', title: 'USE SPECIAL POWERS',
        body: 'Five powers, five cooldowns. Power Flight cancels gravity and the cost of turning, Turbo Speed rewrites your ceiling, Combat Maneuvers doubles your control authority, Shield absorbs an impact and Phase Shift lets you through soft obstacles.',
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
      ['weather', 'Weather', ICONS.wx],
      ['aircraft', 'Aircraft', ICONS.craft],
      ['story', 'Story Mode', ICONS.camp], ['campaign', 'Campaign', ICONS.camp],
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
    // Launch belongs to the Ready Room and nowhere else. Elsewhere it invites a
    // launch before the loadout has been confirmed, which is exactly what the
    // summary on the Play panel exists to prevent.
    this.dom.menu.classList.toggle('show-launch', id === 'play');
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
      case 'weather': p.innerHTML = this._panelWeather(); break;
      case 'aircraft': p.innerHTML = this._panelAircraft(); break;
      case 'story': p.innerHTML = this._panelStory(); break;
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
    const wxId = s.selectedWeather || 'random';
    const wx = wxId === 'random' ? null : WEATHER[wxId];
    const st = s.stats;

    /* The full launch contract in one block. Everything that changes the run —
     * including the two multipliers, shown multiplied out, because that product
     * is the number the score is actually scaled by and neither factor alone
     * tells the player what they are about to earn. */
    const locMult = loc ? loc.difficulty : 1;
    const total = diff.rewardMult * locMult;
    const gfx = QUALITY_PRESETS[s.settings.graphics || this.activePreset]?.label || 'Auto';
    const summary = [
      ['Mode', mode.name, 'mode'],
      ['Difficulty', diff.name, 'difficulty'],
      ['Location', loc ? loc.name : 'Random venue', 'location'],
      ['Weather', wx ? wx.name : 'Random (location pool)', 'weather'],
      ['Aircraft', craft.name, 'aircraft'],
      ['Graphics', gfx, 'settings'],
    ].map(([k, v, jump]) => `<button class="sum-row" data-jump="${jump}"><i>${k}</i><b>${v}</b><em>change</em></button>`).join('');

    return `
      ${this._head('READY ROOM', 'Confirm the loadout, then launch. Every launch regenerates the world from a fresh seed.')}
      <div class="launch-summary">
        ${summary}
        <div class="sum-row sum-total"><i>Reward multiplier</i><b>×${total.toFixed(2)}</b><em>${diff.rewardMult.toFixed(2)} diff · ${locMult.toFixed(2)} venue</em></div>
        <div class="sum-row sum-total"><i>Grid</i><b>${diff.aiCount + 1}</b><em>${mode.combat ? 'combat' : mode.hasRivals ? 'rivals' : 'solo'}</em></div>
      </div>
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
        <button class="card" data-jump="weather">
          <div class="card-title"><b>${wx ? wx.name : 'RANDOM WEATHER'}</b><span class="card-tag">WEATHER</span></div>
          <div class="card-desc">${wx
            ? `Visibility ${Math.round(wx.vis * 100)}%, turbulence ${Math.round(wx.turb * 100)}%${wx.precip ? `, ${wx.precip}` : ''}.`
            : 'Drawn from the location\'s own pool each launch.'}</div>
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
        <div class="stat-tile"><i>Top Mach</i><b>M ${(st.bestMach || 0).toFixed(1)}</b></div>
        <div class="stat-tile"><i>Total Kills</i><b>${nf(st.totalKills || 0)}</b></div>
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
      // Modes that can be lost in mode-specific ways spell out both sides of
      // the contract on the card: what you are trying to do, and what ends it.
      const brief = (m.objectives || m.gameOver) ? `
        <div class="mode-brief">
          ${m.objectives ? `<div class="brief-col">
            <i class="brief-head good">OBJECTIVES</i>
            <ul>${m.objectives.map((o) => `<li>${o}</li>`).join('')}</ul>
          </div>` : ''}
          ${m.gameOver ? `<div class="brief-col">
            <i class="brief-head bad">GAME OVER</i>
            <ul>${m.gameOver.map((o) => `<li>${o}</li>`).join('')}</ul>
          </div>` : ''}
        </div>` : '';
      return `<button class="card${sel}" data-mode="${id}">
        <div class="card-title"><b>${m.name}</b>${m.tag ? `<span class="card-tag">${m.tag}</span>` : ''}</div>
        <div class="card-desc">${m.desc}</div>
        ${brief}
        <div class="card-meta">
          <span>${m.combat ? 'COMBAT' : m.hasRivals ? 'RIVALS' : 'SOLO'}</span>
          <span>${m.hasLaps ? `${m.laps} LAPS` : m.hasTimer ? 'TIMED' : 'OPEN'}</span>
          <span>${m.failOnDamage ? 'FAILABLE' : 'NO FAIL'}</span>
        </div>
      </button>`;
    }).join('');
    return `${this._head('GAME MODE',
      `${MODE_ORDER.length} ways to fly the same procedural generator. Endless Battle and Endless Race are the new combat modes; Endless Flight is the default.`)}
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
    return `${this._head('LOCATION', `${BIOMES.length} venues plus Random — each a world type rather than a fixed map, with its own terrain, architecture, vegetation, palette, weather pool and hazards. Every launch regenerates the world from a new seed, so no two runs of the same location are alike.`)}
      <div class="card-grid wide stagger">
        <button class="card${randomSel}" data-location="random">
          <div class="card-title"><b>RANDOM</b><span class="card-tag">DEFAULT</span></div>
          <div class="card-desc">A fresh combination every launch — Desert + Sunset, Forest + Heavy Rain, Neon City + Rain, Fortress + Storm.</div>
          <div class="card-meta"><span>MAXIMUM VARIETY</span></div>
        </button>
        ${cards}
      </div>`;
  }

  /**
   * WEATHER
   *
   * Every state in the table, grouped by what it does to a flight rather than
   * by name, because "Fog Bank" and "Heavy Snow" are the same problem — you
   * cannot see — and belong next to each other.
   *
   * States outside the selected location's pool are marked rather than
   * disabled. Snow over the neon megacity is not a broken combination, it is
   * simply not the house style, and forbidding it would remove the one thing
   * this screen is for. The tag says "off-pool" and the choice still stands.
   */
  _panelWeather() {
    const s = this.save.data;
    const loc = s.selectedLocation === 'random' ? null : BIOMES_BY_ID[s.selectedLocation];
    const pool = loc ? new Set(loc.weather) : null;
    const sel = s.selectedWeather || 'random';

    const groups = [
      ['CLEAR & CLOUD', ['clear', 'brightSun', 'partlyCloudy', 'cloudy', 'overcast', 'darkClouds', 'floatingClouds', 'suspendedClouds']],
      ['LIGHT & TIME', ['dawn', 'sunrise', 'goldenHour', 'sunset', 'dusk', 'night', 'neonNight']],
      ['LOW VISIBILITY', ['fog', 'fogBank', 'dustStorm']],
      ['PRECIPITATION', ['lightRain', 'heavyRain', 'snow', 'heavySnow', 'storm', 'thunderstorm']],
    ];
    // Anything in the menu list but not in a group above still gets shown, so a
    // new state added to config.js cannot silently vanish from this screen.
    const grouped = new Set(groups.flatMap(([, ids]) => ids));
    const stray = WEATHER_MENU.filter((id) => id !== 'random' && !grouped.has(id) && WEATHER[id]);
    if (stray.length) groups.push(['OTHER', stray]);

    const cell = (id) => {
      const w = WEATHER[id];
      if (!w) return '';
      const on = sel === id ? ' selected' : '';
      const off = pool && !pool.has(id) ? ' offpool' : '';
      // Visibility and turbulence are what the player actually feels, so those
      // are the two numbers on the card.
      return `<button class="card wx-card${on}${off}" data-weather="${id}">
        <div class="card-title"><b>${w.name}</b>${off ? '<span class="card-tag offTag">OFF-POOL</span>' : ''}</div>
        <div class="card-meta">
          <span>VIS ${Math.round(w.vis * 100)}%</span>
          <span>TURB ${Math.round(w.turb * 100)}%</span>
          ${w.precip ? `<span>${w.precip.toUpperCase()}</span>` : ''}
          ${w.lightning ? '<span class="warnTag">LIGHTNING</span>' : ''}
        </div>
      </button>`;
    };

    const body = groups.map(([title, ids]) => `
      <div class="panel-head sub"><h2>${title}</h2></div>
      <div class="card-grid wide stagger">${ids.map(cell).join('')}</div>`).join('');

    const poolNote = loc
      ? `${loc.name} normally flies ${loc.weather.map((w) => WEATHER[w].name).join(' · ')}.`
      : 'Location is set to Random, so every state is in play.';

    return `${this._head('WEATHER', `Weather drives visibility, lighting, wet roads and reflections, particle load, turbulence and how the aircraft handles. Random draws from the location's own pool. ${poolNote}`)}
      <div class="card-grid wide stagger">
        <button class="card${sel === 'random' ? ' selected' : ''}" data-weather="random">
          <div class="card-title"><b>RANDOM</b><span class="card-tag">DEFAULT</span></div>
          <div class="card-desc">Drawn from the selected location's weather pool every launch, so the venue keeps its atmospheric identity while no two runs match.</div>
          <div class="card-meta"><span>MAXIMUM VARIETY</span></div>
        </button>
      </div>
      ${body}`;
  }

  _panelAircraft() {
    const s = this.save.data;
    const sel = AIRCRAFT_BY_ID[this.hangarSelection] || AIRCRAFT_BY_ID[s.selectedAircraft];
    const unlocked = (a) => a.unlock.type === 'default' || s.unlocked.includes(a.id);
    const list = AIRCRAFT.map((a) => {
      const isSel = a.id === sel.id ? ' selected' : '';
      const open = unlocked(a);
      const lock = open ? '' : ' locked';
      // The airframe you will actually fly is marked with a tick, not a word,
      // so it survives a glance down a list of thirteen.
      const active = open && a.id === s.selectedAircraft;
      const tag = !open
        ? `<span class="card-tag lockTag">${a.unlock.type === 'credits' ? `${nf(a.unlock.cost)} ◈` : 'LOCKED'}</span>`
        : (active ? '<span class="card-tag activeTag">✓ ACTIVE</span>' : '');
      return `<button class="card${isSel}${lock}${active ? ' is-active' : ''}" data-craft="${a.id}"${open ? '' : ' data-locked="1"'}>
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
        ? '<div class="active-confirm">✓ ACTIVE — this is the aircraft you will fly</div>'
        : `<button class="btn btn-primary" data-select-craft="${sel.id}">SET ACTIVE</button>`)
      : (sel.unlock.type === 'credits'
        ? `<div class="daily-best">${nf(sel.unlock.cost)} ◈ · you have ${nf(s.credits)}</div>
           <button class="btn ${canBuy ? 'btn-primary' : 'disabled'}" data-buy-craft="${sel.id}">Unlock</button>`
        : `<div class="daily-best">${sel.unlock.label}</div>`);

    return `${this._head('HANGAR', `${AIRCRAFT.length} airframes with genuinely different geometry, mass and handling — three of them modelled in full. Tap an airframe to make it active; the silhouette tells you how each one flies.`)}
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

  _panelStory() {
    const s = this.save.data;
    const prog = s.storyProgress || 0;
    const acts = STORY_ACTS.map((a) => {
      const rows = STORY.filter((m) => m.act === a.act).map((m) => {
        const cleared = m.id <= prog;
        const locked = m.id > prog + 1;
        const b = BIOMES_BY_ID[m.biome];
        return `<div class="chapter${cleared ? ' cleared' : ''}${locked ? ' locked' : ''}" ${locked ? '' : `data-mission="${m.id}"`}>
          <div class="chapter-num">${cleared ? '✓' : String(m.id).padStart(2, '0')}</div>
          <div class="chapter-body">
            <b>${m.name}</b>
            <span>${m.tagline}</span>
            <div class="chapter-meta">
              <span class="daily-pill">${b ? b.short : m.biome}</span>
              <span class="daily-pill">${WEATHER[m.weather]?.name || m.weather}</span>
              <span class="daily-pill">${DIFFICULTIES[m.diff].name}</span>
              <span class="daily-pill">${m.phases.length} PHASES</span>
              <span class="daily-pill hot">~${m.estMinutes} MIN</span>
            </div>
          </div>
          <div class="chapter-reward">${nf(m.reward)} ◈</div>
        </div>`;
      }).join('');
      return `<div class="act-block">
        <div class="act-head"><b>ACT ${['I', 'II', 'III'][a.act - 1]} · ${a.name}</b><span>${a.desc}</span></div>
        <div class="card-grid" style="grid-template-columns:1fr;gap:9px">${rows}</div>
      </div>`;
    }).join('');
    return `${this._head('STORY MODE',
      `Fifteen missions in three acts, flown in order. Each one is a full half-hour sortie with five phases and its own briefing. ${prog} of ${STORY.length} cleared.`)}
      ${acts}`;
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
      ['Top Speed', `${nf(st.bestSpeedKmh)} km/h`], ['Top Mach', `M ${(st.bestMach || 0).toFixed(1)}`],
      ['Enemies Destroyed', nf(st.totalKills || 0)], ['Manoeuvres Flown', nf(st.totalManoeuvres || 0)],
      ['Best Combo', `×${st.bestCombo}`],
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
    /* Most summary rows jump to a nav section; Graphics lives in the Settings
       overlay instead, which has no nav entry — routing it through setSection
       would leave menuSection on a value _renderMenuPanel has no case for, and
       so an empty panel. */
    pick('[data-jump]', (n) => {
      const to = n.dataset.jump;
      if (to === 'settings') this.openSettings();
      else this.setSection(to);
    });
    pick('[data-mode]', (n) => { this.save.set('selectedMode', n.dataset.mode); this._renderMenuPanel(); });
    pick('[data-difficulty]', (n) => { this.save.set('selectedDifficulty', n.dataset.difficulty); this._renderMenuPanel(); });
    pick('[data-location]', (n) => { this.save.set('selectedLocation', n.dataset.location); this._renderMenuPanel(); });
    pick('[data-weather]', (n) => { this.save.set('selectedWeather', n.dataset.weather); this._renderMenuPanel(); });
    /* Clicking a card in the hangar both previews it and makes it the aircraft
     * you will actually fly. Previously the card only previewed and a separate
     * "Select" button in the detail pane committed it, which meant browsing the
     * list looked exactly like choosing from it — the reported bug where the
     * jet you picked was not the one that launched. Locked airframes still only
     * preview; they have an Unlock button instead. */
    pick('[data-craft]', (n) => {
      const id = n.dataset.craft;
      this.hangarSelection = id;
      this.callbacks.onHangarPreview?.(id);
      if (n.dataset.locked !== '1') {
        this.save.set('selectedAircraft', id);
        this.audio.ui('confirm');
        this.callbacks.onAircraftChange?.(id);
      }
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
    // A Story mission opens its briefing first; the briefing launches it.
    pick('[data-mission]', (n) => {
      const m = STORY_BY_ID[+n.dataset.mission];
      if (m) this.showMissionBrief(m, this.save.data.storyProgress || 0);
    });
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
    const wxId = s.selectedWeather || 'random';
    const wx = wxId === 'random' ? 'Random' : (WEATHER[wxId]?.name || 'Random');
    this.dom.loadout.innerHTML = [
      ['Mode', mode.name], ['Difficulty', diff.name], ['Location', loc],
      ['Weather', wx], ['Airframe', craft.name],
    ].map(([k, v]) => `<div class="loadout-chip"><i>${k}</i><b>${v}</b></div>`).join('');
    this.dom.launchSub.textContent = `${mode.name} · ${diff.name} · ${loc} · ${wx}`;
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
    const seg = (key, options, effective = null) => {
      const g = el('div', 'seg');
      // `effective` covers the settings that are null until the player chooses,
      // so the segment shows what is actually running rather than nothing.
      const current = s[key] ?? effective;
      options.forEach(([val, label]) => {
        const b = el('button', current === val ? 'active' : '', label);
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
    field(gg, 'Quality Preset', 'Chosen for your device on first run — Extreme on a landscape phone, High on desktop. This is a CEILING, not a promise: on desktop the frame governor holds 60-120 FPS at every setting, easing detail down and, if it has to, running a preset below the one you picked until there is headroom to climb back.',
      seg('graphics', QUALITY_ORDER.map((q) => [q, QUALITY_PRESETS[q].label]), this.activePreset));
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
    field(ag, 'Environment', 'Engine, wind and weather bed.', slider('environmentVolume', 0, 1, 0.02, (v) => `${Math.round(v * 100)}%`));

    /* -- gameplay -- */
    const pg = group('Gameplay');
    field(pg, 'Flight Sensitivity', 'Control input scaling.', slider('flightSensitivity', 0.4, 1.8, 0.05, (v) => `${v.toFixed(2)}×`));
    field(pg, 'Camera Sensitivity', 'Chase camera responsiveness.', slider('cameraSensitivity', 0.4, 1.8, 0.05, (v) => `${v.toFixed(2)}×`));
    field(pg, 'HUD Scale', 'Size of every HUD element.', slider('hudScale', 0.75, 1.4, 0.05, (v) => `${Math.round(v * 100)}%`));
    field(pg, 'Invert Pitch', 'Flip the pitch axis.', toggle('invertPitch'));
    field(pg, 'Vibration', 'Haptic feedback on impacts (supported devices).', toggle('vibration'));
    field(pg, 'Route Guidance', 'Floating chevrons showing the line ahead.', toggle('guidance'));
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
  /**
   * Combat overlay: one bracket per hostile with its live speed in Mach and
   * km/h, plus the weapon and lock strip along the bottom.
   *
   * Target boxes are recycled rather than rebuilt — a wave of nine hostiles at
   * 60 Hz is 540 element creations a second otherwise, which is exactly the
   * kind of churn that shows up as a stutter.
   */
  updateCombatHud(s) {
    const host = this.dom.targetLayer;
    if (!host) return;
    this.dom.combat.classList.add('active');

    const pool = (this._tgtPool ||= []);
    while (pool.length < s.boxes.length) {
      const n = el('div', 'tgt');
      n.innerHTML = '<i></i><i></i><i></i><i></i>'
        + '<div class="tgt-name"></div>'
        + '<div class="tgt-hull"><b></b></div>'
        + '<div class="tgt-lock-label">TARGET LOCKED</div>'
        + '<div class="tgt-info"><span class="mach"></span> · <span class="kmh"></span></div>';
      host.appendChild(n);
      pool.push({
        root: n, hull: n.querySelector('.tgt-hull b'),
        label: n.querySelector('.tgt-lock-label'),
        name: n.querySelector('.tgt-name'),
        mach: n.querySelector('.mach'), kmh: n.querySelector('.kmh'),
      });
    }
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i], b = s.boxes[i];
      if (!b) { p.root.style.display = 'none'; continue; }
      p.root.style.display = '';
      p.root.style.left = `${b.x}%`;
      p.root.style.top = `${b.y}%`;
      // Distant hostiles get a smaller bracket, which reads as depth.
      const sc = clamp(1.15 - b.dist / 9000, 0.45, 1.15);
      p.root.style.transform = `translate(-50%, -50%) scale(${sc.toFixed(2)})`;
      p.root.classList.toggle('locked', !!b.locked);
      p.root.classList.toggle('tracking', !!b.tracking && !b.locked);
      p.hull.style.width = `${Math.round(b.health * 100)}%`;
      p.label.style.display = b.locked ? '' : 'none';
      if (p.name && p.name.textContent !== (b.label || '')) p.name.textContent = b.label || '';
      p.mach.textContent = `M ${b.mach}`;
      p.kmh.textContent = `${b.kmh.toLocaleString('en-US')} km/h`;
    }

    /* --- rounds in flight --------------------------------------------------
     * One label per live missile, riding above it, counting the gap down. Same
     * pooled-node approach as the target brackets: allocation during a fight is
     * the one thing the HUD must not do. */
    const mpool = (this._mslPool ||= []);
    const mList = s.missiles || [];
    while (mpool.length < mList.length) {
      const n = el('div', 'msl-tag');
      n.innerHTML = '<span class="msl-d"></span>';
      host.appendChild(n);
      mpool.push({ root: n, d: n.querySelector('.msl-d') });
    }
    for (let i = 0; i < mpool.length; i++) {
      const p = mpool[i], m = mList[i];
      if (!m) { p.root.style.display = 'none'; continue; }
      p.root.style.display = '';
      p.root.style.left = `${m.x}%`;
      p.root.style.top = `${m.y}%`;
      p.root.classList.toggle('near', !!m.near);
      p.d.textContent = `${m.km} km`;
    }

    const strip = this.dom.lockStrip;
    strip.classList.toggle('locked', !!s.locked);
    strip.classList.toggle('tracking', !s.locked && s.lock > 0.02);
    /* Out of range is its own state. A solid lock on something the armed weapon
     * cannot reach is exactly the case where the launch will be refused, so the
     * strip says so before the player presses the key rather than after. */
    const far = !!s.locked && s.targetRange != null && !s.inRange;
    strip.classList.toggle('outofrange', far);

    /* Target lock range, on its own under the reticle. Independent of the panel
     * above — that one is closed by default, and the distance to what you have
     * locked is not a number to go opening a panel for. */
    const lr = this.dom.lockRange;
    if (lr) {
      const tracking = !!s.locked || s.lock > 0.02;
      lr.classList.toggle('active', tracking);
      lr.classList.toggle('locked', !!s.locked && !far);
      lr.classList.toggle('far', far);
      if (tracking) {
        this.dom.lockRangeValue.textContent = s.targetKm != null ? s.targetKm : '--.-';
      }
    }

    this.dom.lockText.textContent = far
      ? `OUT OF RANGE ${s.targetKm} km / ${s.weaponRangeKm} km`
      : s.locked
        ? (s.targetKm != null ? `TARGET LOCKED · ${s.targetKm} km` : 'TARGET LOCKED')
        : s.lock > 0.02 ? `ACQUIRING ${Math.round(s.lock * 100)}%` : 'NO TARGET';
    this.dom.wpnName.textContent = (s.weapon?.name || '').toUpperCase();
    // Gun belt: built once, then only the armed class changes.
    if (this.dom.gunRack && s.gunRack) {
      if (!this._gunBuilt) {
        this._gunBuilt = true;
        this._gunSlots = s.gunRack.map((w) => {
          const n = el('div', 'gun-slot');
          n.title = w.name;
          n.textContent = w.short;
          this.dom.gunRack.appendChild(n);
          return n;
        });
        this.dom.gunRack.appendChild(el('span', 'rack-key', 'N8'));
      }
      for (let i = 0; i < this._gunSlots.length; i++) {
        this._gunSlots[i].classList.toggle('armed', s.gunRack[i].armed);
      }
    }
    // Weapon rack: built once, then only the armed class changes.
    if (this.dom.wpnRack && s.rack) {
      if (!this._rackBuilt) {
        this._rackBuilt = true;
        this._rackSlots = s.rack.map((w) => {
          const n = el('div', 'wpn-slot');
          n.title = w.name;
          n.appendChild(el('span', 'wk', w.key));
          n.appendChild(el('span', 'wn', w.short));
          this.dom.wpnRack.appendChild(n);
          return n;
        });
        this.dom.wpnRack.appendChild(el('span', 'rack-key', 'N9'));
      }
      for (let i = 0; i < this._rackSlots.length; i++) {
        this._rackSlots[i].classList.toggle('armed', s.rack[i].armed);
      }
    }
    this.dom.wpnReload.style.width = `${Math.round(clamp01(s.reload) * 100)}%`;
    /* The touch arm buttons carry the same short codes as the desktop racks, so
     * what is armed is legible without the rack itself, which does not fit on a
     * phone. Guarded on change: these are string writes inside the combat loop. */
    if (this.dom.touchGunName) {
      const g = s.gunRack?.find((w) => w.armed)?.short || '—';
      if (this._touchGunShort !== g) { this._touchGunShort = g; this.dom.touchGunName.textContent = g; }
    }
    if (this.dom.touchMslName) {
      const m = s.rack?.find((w) => w.armed)?.short || '—';
      if (this._touchMslShort !== m) { this._touchMslShort = m; this.dom.touchMslName.textContent = m; }
    }
    this.dom.cbtWave.textContent = String(s.wave);
    this.dom.cbtKills.textContent = String(s.kills);
    this.dom.cbtHostiles.textContent = String(s.hostiles);
  }

  /** Tear the combat overlay down when a non-combat mode starts. */
  clearCombatHud() {
    this.dom.combat?.classList.remove('active');
    this.dom.lockRange?.classList.remove('active', 'locked', 'far');
    if (this._tgtPool) for (const p of this._tgtPool) p.root.style.display = 'none';
  }

  /**
   * Pin the mode's objectives and its game-over conditions to the HUD for the
   * whole run — the same two lists the main-menu card shows, so what ends the
   * run is never something the player has to have memorised.
   */
  setModeBrief(mode) {
    // Weapons only exist in the combat modes, so the touch rack follows suit.
    this.dom.body.classList.toggle('combat-mode', !!mode?.combat);
    const b = this.dom.brief;
    if (!b) return;
    if (!mode || (!mode.objectives && !mode.gameOver)) {
      b.classList.remove('active');
      b.innerHTML = '';
      return;
    }
    b.innerHTML = `${mode.objectives ? `<h5 class="good">OBJECTIVES</h5>
      <ul>${mode.objectives.map((o) => `<li>${o}</li>`).join('')}</ul>` : ''}
      ${mode.gameOver ? `<h5 class="bad">GAME OVER IF</h5>
      <ul>${mode.gameOver.map((o) => `<li>${o}</li>`).join('')}</ul>` : ''}`;
    b.classList.add('active');
  }

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
    set('pos', $('#hud-pos'), solo ? String(s.soloValue ?? s.checkpoints) : String(s.position));
    set('grid', $('#hud-grid'), solo ? (s.soloUnit || 'GATES') : `/ ${s.gridSize}`);
    set('posLabel', $('.hud-position .hud-label'), solo ? (s.soloLabel || 'CHECKPOINTS') : 'POSITION');
    set('score', $('#hud-score'), nf(s.score));
    set('dist', $('#hud-distance'), `${(s.distance / 1000).toFixed(2)} km`);
    set('cps', $('#hud-checkpoints'), String(s.checkpoints));
    set('spd', $('#hud-speed'), String(Math.round(s.speedKmh)));
    const mach = s.mach || 0;
    set('mach', this.dom.machValue, mach.toFixed(1));
    if (this.dom.machBlock) {
      this.dom.machBlock.classList.toggle('hot', mach >= MACH.blurMach);
      this.dom.machBlock.classList.toggle('max', mach >= MACH.max - 1);
    }
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

    // gauges — the speed arc reads across the whole Mach envelope
    const spdT = clamp01(mach / MACH.max);
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

    // engine thermal state
    const oh = this.dom.overheat;
    if (oh) {
      const on = !!s.overheatText;
      if (s.overheatText !== c.overheat) {
        c.overheat = s.overheatText;
        this.dom.overheatText.textContent = s.overheatText || '';
      }
      oh.classList.toggle('show', on);
      oh.classList.toggle('cooling', on && !s.redline);
      oh.classList.toggle('lvl1', on && s.overheatLevel === 1);
      oh.classList.toggle('lvl2', on && s.overheatLevel === 2);
      if (on) this.dom.heatFill.style.width = `${Math.round(clamp01(s.heat) * 100)}%`;
    }

    // collision warning — its own strip, because it can be up at the same time
    // as a terrain or hull warning and neither should hide the other.
    const hz = this.dom.hazard;
    if (hz) {
      const on = !!s.hazardText;
      if (s.hazardText !== c.hazard) { c.hazard = s.hazardText; this.dom.hazardText.textContent = s.hazardText || ''; }
      hz.classList.toggle('show', on);
      hz.classList.toggle('lvl1', on && s.hazardLevel === 1);
      hz.classList.toggle('lvl2', on && s.hazardLevel === 2);
    }

    // terrain warning
    const warn = this.dom.warn;
    // A mode-specific warning (speed floor, disengagement timer) outranks the
    // generic ones — it is the thing about to end the run.
    const warnText = s.warn || (s.agl < 110 ? 'PULL UP'
      : (s.hasRoute !== false && s.corridorOut > 1.35 ? 'OFF ROUTE'
        : (s.hull < 0.22 ? 'HULL CRITICAL' : '')));
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

  /** Shows which camera is live, bottom-right, and pulses when it changes. */
  /** Reflect the camera zoom level, and grey the buttons out at the limits. */
  setZoom(percent, min = 25, max = 100) {
    if (!this.dom.zoomValue) return;
    this.dom.zoomValue.textContent = `${percent}%`;
    this.dom.zoomIn.disabled = percent >= max;
    this.dom.zoomOut.disabled = percent <= min;
  }

  setCamera(name) {
    const c = this.dom.camChip, n = this.dom.camName;
    if (!c || !n || n.textContent === name) return;
    n.textContent = name;
    c.classList.remove('flash');
    void c.offsetWidth;
    c.classList.add('flash');
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
    click('#btn-hud-hide', () => this.toggleHudChrome());
    click('#brief-launch', () => {
      this.audio.ui('confirm');
      const m = this._briefMission;
      if (m) this.callbacks.onLaunchStory?.(m.id);
    });
    click('#brief-back', () => { this.audio.ui('back'); this.showScreen('menu'); });
    click('#dial-flight', () => this.togglePanel('flight'));
    click('#dial-combat', () => this.togglePanel('combat'));
    // Camera zoom. Repeats while held so dragging the framing in is one press
    // rather than eight, and both pointer and touch drive the same path.
    const zoomHold = (el, dir) => {
      if (!el) return;
      let timer = null, delay = null;
      const step = () => { this.callbacks.onZoom?.(dir); this.audio.ui('slider', { volume: 0.5 }); };
      const start = (e) => {
        e.preventDefault();
        step();
        delay = setTimeout(() => { timer = setInterval(step, 90); }, 320);
      };
      const stop = () => { clearTimeout(delay); clearInterval(timer); timer = delay = null; };
      el.addEventListener('pointerdown', start);
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(ev, stop);
    };
    zoomHold(this.dom.zoomIn, 1);
    zoomHold(this.dom.zoomOut, -1);
    click('#btn-fullscreen', () => this.toggleFullscreen());
    click('#orient-fullscreen', () => this.toggleFullscreen());
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
    // Cards and rows are built and rebuilt constantly, so hover is delegated.
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest?.('.card, .seg button, .switch, .power-cell');
      if (t && t !== this._lastHover) { this._lastHover = t; this.audio.ui('hover', { volume: 0.6 }); }
    });

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
      if (name === 'camera') { if (down) { this.callbacks.onCamera?.(); this.audio.ui('click'); } return; }
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
    // Portrait on a touch device is never playable, whatever the width.
    this.dom.orientation.classList.toggle('show', this.device.isTouch && portrait);
  }

  /* =====================================================================
   * STORY MODE
   * ================================================================== */

  /**
   * Mission briefing. Shown before every Story launch, never skipped.
   *
   * A mission runs about half an hour and its five phases have to be flown in
   * order, so arriving in one without knowing what it wants is not a challenge
   * — it is half an hour spent finding out. The briefing states the situation,
   * the intelligence, the orders and every phase up front, and the player
   * launches from it rather than from the main menu.
   */
  showMissionBrief(m, progress = 0) {
    const cleared = progress >= m.id;
    $('#brief-act').textContent = `ACT ${['I', 'II', 'III'][m.act - 1]} · ${m.actName}`;
    $('#brief-no').textContent = String(m.id).padStart(2, '0');
    $('#brief-name').textContent = m.name;
    $('#brief-tagline').textContent = m.tagline;
    $('#brief-situation').textContent = m.situation;
    $('#brief-intel').textContent = m.intel;
    $('#brief-orders').textContent = m.orders;

    const list = $('#brief-phases');
    list.innerHTML = m.phases.map((ph) => `
      <li class="brief-phase">
        <b>${ph.text}</b>
        ${ph.hint ? `<i>${ph.hint}</i>` : ''}
      </li>`).join('');

    const loc = LOCATIONS_BY_ID[m.biome];
    $('#brief-facts').innerHTML = `
      <div class="fact"><i>VENUE</i><b>${loc ? loc.name : m.biome}</b></div>
      <div class="fact"><i>WEATHER</i><b>${WEATHER[m.weather]?.name || m.weather}</b></div>
      <div class="fact"><i>DIFFICULTY</i><b>${DIFFICULTIES[m.diff]?.name || m.diff}</b></div>
      <div class="fact"><i>EST. LENGTH</i><b>${m.estMinutes} min</b></div>
      <div class="fact"><i>SQUADRON</i><b>×${m.pressure.toFixed(2)} pressure</b></div>
      <div class="fact"><i>REWARD</i><b>◈ ${m.reward.toLocaleString()}</b></div>`;

    $('#brief-sub').textContent = cleared
      ? `Mission ${m.id} · already cleared · ${m.phases.length} phases`
      : `Mission ${m.id} of 15 · ${m.phases.length} phases · ~${m.estMinutes} minutes`;
    this._briefMission = m;
    this.showScreen('brief');
  }

  /** The how-to line for the live phase. Empty clears it. */
  setStoryHint(text) {
    const n = this.dom.objHint;
    if (!n) return;
    n.textContent = text || '';
    n.classList.toggle('show', !!text);
  }

  /**
   * The phase banner: which mission, which phase, and how many are left. Lives
   * outside the objective card so closing that panel does not lose the one
   * thing a half-hour mission needs permanently on screen.
   */
  setStoryPhase(mission, index, total) {
    const strip = this.dom.storyStrip;
    if (!strip) return;
    if (!mission) { strip.classList.remove('show'); this._storyKey = null; return; }
    // Called every frame from the phase machine; the content changes about
    // five times in half an hour, so nothing is written unless it changed.
    const key = `${mission.id}:${index}:${total}`;
    if (key === this._storyKey) return;
    this._storyKey = key;
    strip.classList.add('show');
    this.dom.storyMission.textContent = `M${String(mission.id).padStart(2, '0')} · ${mission.name}`;
    this.dom.storyPhase.textContent = `PHASE ${Math.min(index + 1, total)} / ${total}`;
    if (this._storyPips !== total) {
      this._storyPips = total;
      this.dom.storyPips.innerHTML = Array.from({ length: total }, () => '<i></i>').join('');
    }
    const pips = this.dom.storyPips.children;
    for (let i = 0; i < pips.length; i++) pips[i].className = i < index ? 'done' : i === index ? 'live' : '';
  }

  clearStoryHud() {
    this.setStoryHint('');
    this.dom.storyStrip?.classList.remove('show');
  }

  /* =====================================================================
   * REFERENCE PANELS
   * ------------------------------------------------------------------
   * The control legend and the weapons/objective block are reference, not
   * instruments: worth reading for the first few runs and then permanently in
   * front of the thing you are actually looking at. Both are CLOSED by default
   * on every device, each behind its own circular dial, and the choice is
   * remembered — a pilot who wants the legend up gets it up on every launch
   * without touching a settings screen.
   * ================================================================== */

  /** Settings key and body class for each dial. */
  static get PANELS() {
    return {
      flight: { key: 'panelFlight', cls: 'panel-flight-off', dial: 'dialFlight' },
      combat: { key: 'panelCombat', cls: 'panel-combat-off', dial: 'dialCombat' },
    };
  }

  /** Paint both panels from the saved settings. Called once, on boot. */
  _applyPanelState() {
    for (const id of Object.keys(UI.PANELS)) this.setPanel(id, this.panelOpen(id), false);
  }

  /** Is this panel currently open? Closed unless the player has said otherwise. */
  panelOpen(id) {
    const p = UI.PANELS[id];
    return !!(p && this.save.data.settings[p.key]);
  }

  /** Open or close one panel, optionally persisting the choice. */
  setPanel(id, open, persist = true) {
    const p = UI.PANELS[id];
    if (!p) return false;
    document.body.classList.toggle(p.cls, !open);
    const dial = this.dom[p.dial];
    if (dial) dial.setAttribute('aria-expanded', String(open));
    if (persist) this.save.setSetting(p.key, open);
    return open;
  }

  togglePanel(id) {
    this.audio.ui('click');
    return this.setPanel(id, !this.panelOpen(id));
  }

  /**
   * Hide or show every control overlay in one click.
   *
   * Everything the pilot does not need in order to fly — the control legend, the
   * zoom rack, the camera chip, the radar, the touch cluster — goes behind a
   * single body class, so the CSS decides what "chrome" means rather than this
   * method holding a list that drifts. The flight instruments stay: this is a
   * clean-screen toggle for a look at the world, not a no-HUD mode.
   */
  toggleHudChrome(force = null) {
    const hidden = force == null ? !document.body.classList.contains('hud-hidden') : !!force;
    document.body.classList.toggle('hud-hidden', hidden);
    this.dom.hudHide?.setAttribute('aria-pressed', String(hidden));
    if (this.dom.hudHideText) this.dom.hudHideText.textContent = hidden ? 'SHOW UI' : 'HIDE UI';
    this.audio.ui('click');
    return hidden;
  }

  /**
   * Landscape phones get fullscreen, but only on a real tap: every browser
   * rejects a programmatic request, so this arms a one-shot listener and fires
   * on whatever the player touches first. Desktop is left alone — taking over
   * the whole screen uninvited on a desktop is hostile.
   */
  armFullscreenGesture() {
    if (this._fsArmed) return;
    if (!this.device.isMobile) return;
    this._fsArmed = true;
    const go = () => {
      window.removeEventListener('pointerdown', go);
      window.removeEventListener('touchend', go);
      if (window.innerHeight > window.innerWidth) return;   // portrait: not yet
      if (document.fullscreenElement) return;
      this.toggleFullscreen();
    };
    window.addEventListener('pointerdown', go, { once: true });
    window.addEventListener('touchend', go, { once: true });
  }

  toggleFullscreen() {
    this.audio.ui('click');
    try {
      if (!document.fullscreenElement) {
        (document.documentElement.requestFullscreen
          || document.documentElement.webkitRequestFullscreen
          || (() => {})).call(document.documentElement).catch?.(() => {});
        if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => {});
        this._lockRequested = true;
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
