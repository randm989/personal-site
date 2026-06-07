/*
 * stickman.js — Josh's running stick figure, as a reusable, renderer-agnostic model.
 *
 * This is the SINGLE SOURCE OF TRUTH for the character: skeleton proportions, the
 * procedural run/wave animation, and the tuned config. The DOM/SVG renderer below is one
 * consumer; Zipix (Phaser/canvas) can port `computePose` + `SKELETON` + `CONFIG` and draw
 * the returned line segments with any renderer. See docs/STICKMAN.md.
 *
 * Classic script (attaches `window.Stickman`); also sets module.exports when present.
 * Faithful to the all-black, hollow-circle-head figure from Josh's sophomore project.
 */
(function (root) {
  'use strict';

  // ---- skeleton proportions (local SVG units; feet sit at FEET_Y) ----
  var SKELETON = {
    W: 46, H: 54, CX: 23,
    HIP_Y: 30, SH_Y: 18, HEAD_Y: 11, HEAD_R: 5,
    TH: 8, SH: 9, UA: 7, FA: 7,   // thigh, shin, upper-arm, fore-arm lengths
    FEET_Y: 47,                   // y of the planted foot (align this to the ground line)
    STROKE: 2.2
  };

  // ---- Josh's tuned configuration (config of record; mirrors stickman.config.json) ----
  var CONFIG = {
    size: 1.29, stride: 1.25, lift: 1.6, knee: 1.25, kneeF: 1.09,
    arm: 1.15, armBack: 1.6, elbow: 0.95, lean: 5.7, headTilt: 1.73,
    bob: 1.75, speed: 77, tempo: 10.6, rnd: 0.06,
    waveArm: 4.28, waveAmp: 0.45, waveSpd: 10
  };

  var WAVE_MS = 2400;

  // 2-segment limb solver. Angles measured from straight-down; +x is forward (run direction).
  function limb(rx, ry, l1, l2, a1, a2) {
    var mx = rx + l1 * Math.sin(a1), my = ry + l1 * Math.cos(a1);
    return [mx, my, mx + l2 * Math.sin(a1 + a2), my + l2 * Math.cos(a1 + a2)];
  }

  /*
   * computePose(state, config) -> renderer-agnostic skeleton.
   *   state: { phase, run (0..1), dir (+1/-1), waving (bool), t (seconds), rA, rB (-1..1) }
   *   returns: { head:[cx,cy,r], lines:{spine,auL,afL,auR,afR,luL,lfL,luR,lfR:[x1,y1,x2,y2]},
   *              bob, dir, center } — apply bob (translateY) and dir (scaleX about center)
   *              as a group transform; `lines` and `head` already include the lean.
   *
   * The run cycle is the v2 cycle mirrored across the vertical axis (limbs face the run
   * direction); lean is a positional offset that is NOT mirrored.
   */
  function computePose(st, c) {
    var S = SKELETON, run = st.run, s = Math.sin(st.phase), t = st.t;
    var mA = 1 + st.rA * c.rnd, mB = 1 + st.rB * c.rnd; // slight per-step L/R variation

    // forward swing uses 'lift' (front leg raises higher), backswing uses 'stride'
    var thighA = (s < 0 ? -s * c.lift : -s * c.stride) * run * mA;
    var thighB = (s > 0 ? s * c.lift : s * c.stride) * run * mB;
    // knee = back-bend (recovery leg) + forward-bend (planting leg)
    var kneeA = -(Math.max(0, s) * c.knee + Math.max(0, -s) * c.kneeF) * run * mA;
    var kneeB = -(Math.max(0, -s) * c.knee + Math.max(0, s) * c.kneeF) * run * mB;
    // arms pump opposite the legs; asymmetric forward (arm) vs back (armBack); forearms bend forward
    var upA = -0.2 + (s > 0 ? s * c.arm : s * c.armBack) * run;
    var upB = -0.2 - (s > 0 ? s * c.armBack : s * c.arm) * run;
    var elA = c.elbow * run + 0.1, elB = c.elbow * run + 0.1;
    var bob = -Math.abs(s) * c.bob * run - Math.sin(t * 1.6) * 0.4;
    var lean = run * c.lean, dir = st.dir;

    if (st.waving) { // planted stance, one arm raised waving toward the viewer
      thighA = 0.18; thighB = -0.18; kneeA = 0.14; kneeB = 0.14;
      upA = 0.25; upB = c.waveArm; elA = 0.3; elB = -0.5 + Math.sin(t * c.waveSpd) * c.waveAmp;
      bob = Math.sin(t * 2) * 0.4; dir = 1; lean = 0;
    }

    var hipX = S.CX, hipY = S.HIP_Y, shX = S.CX + lean, shY = S.SH_Y;
    var p, lines = {};
    lines.spine = [hipX, hipY, shX, shY];
    p = limb(hipX, hipY, S.TH, S.SH, thighA, kneeA); lines.luL = [hipX, hipY, p[0], p[1]]; lines.lfL = [p[0], p[1], p[2], p[3]];
    p = limb(hipX, hipY, S.TH, S.SH, thighB, kneeB); lines.luR = [hipX, hipY, p[0], p[1]]; lines.lfR = [p[0], p[1], p[2], p[3]];
    p = limb(shX, shY, S.UA, S.FA, upA, elA); lines.auL = [shX, shY, p[0], p[1]]; lines.afL = [p[0], p[1], p[2], p[3]];
    p = limb(shX, shY, S.UA, S.FA, upB, elB); lines.auR = [shX, shY, p[0], p[1]]; lines.afR = [p[0], p[1], p[2], p[3]];

    return { head: [S.CX + lean * c.headTilt, S.HEAD_Y, S.HEAD_R], lines: lines, bob: bob, dir: dir, center: S.CX };
  }

  // ---- SVG renderer (one consumer of computePose) ----
  var NS = 'http://www.w3.org/2000/svg';
  var LIMB_KEYS = ['spine', 'auL', 'afL', 'auR', 'afR', 'luL', 'lfL', 'luR', 'lfR'];

  function createSVG(color) {
    color = color || 'currentColor';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', SKELETON.W); svg.setAttribute('height', SKELETON.H);
    svg.setAttribute('viewBox', '0 0 ' + SKELETON.W + ' ' + SKELETON.H);
    svg.style.cssText = 'display:block;overflow:visible;pointer-events:none';
    var g = document.createElementNS(NS, 'g');
    var head = document.createElementNS(NS, 'circle');
    head.setAttribute('fill', 'none'); head.setAttribute('stroke', color); head.setAttribute('stroke-width', SKELETON.STROKE);
    g.appendChild(head);
    var els = {};
    LIMB_KEYS.forEach(function (k) {
      var ln = document.createElementNS(NS, 'line');
      ln.setAttribute('stroke', color); ln.setAttribute('stroke-width', SKELETON.STROKE);
      ln.setAttribute('stroke-linecap', 'round'); ln.setAttribute('fill', 'none');
      g.appendChild(ln); els[k] = ln;
    });
    svg.appendChild(g);
    function render(pose) {
      head.setAttribute('cx', pose.head[0]); head.setAttribute('cy', pose.head[1]); head.setAttribute('r', pose.head[2]);
      LIMB_KEYS.forEach(function (k) { var v = pose.lines[k]; els[k].setAttribute('x1', v[0]); els[k].setAttribute('y1', v[1]); els[k].setAttribute('x2', v[2]); els[k].setAttribute('y2', v[3]); });
      g.setAttribute('transform', 'translate(0 ' + pose.bob + ') translate(' + pose.center + ' 0) scale(' + pose.dir + ' 1) translate(' + (-pose.center) + ' 0)');
    }
    return { svg: svg, render: render };
  }

  /*
   * createRunner(opts) — full DOM driver: figure + procedural loop + slow linear chase +
   * wave + dust. opts: { mount, config?, color?, dustColor?, startX? }.
   * Returns { el, config, setTarget(x), wave(), isWaving(), destroy() }.
   * `config` is live: mutate it to tune in real time. Chase FREEZES while waving.
   */
  function createRunner(opts) {
    opts = opts || {};
    var mount = opts.mount;
    var cfg = Object.assign({}, CONFIG, opts.config || {});
    var RM = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var el = document.createElement('div');
    el.style.cssText = 'position:absolute;top:50%;left:0;pointer-events:none;will-change:transform;transform-origin:0 ' + SKELETON.FEET_Y + 'px';
    var view = createSVG(opts.color);
    el.appendChild(view.svg);
    // clickable hitbox (figure lines are thin)
    var hit = document.createElementNS(NS, 'rect');
    hit.setAttribute('x', 4); hit.setAttribute('y', 0); hit.setAttribute('width', SKELETON.W - 8); hit.setAttribute('height', SKELETON.H);
    hit.setAttribute('fill', 'transparent'); hit.style.cssText = 'pointer-events:all;cursor:pointer';
    view.svg.appendChild(hit);
    if (mount) { if (getComputedStyle(mount).position === 'static') mount.style.position = 'relative'; mount.appendChild(el); }

    var curX = opts.startX || 60, tgtX = curX, dir = 1, phase = 0, run = 0;
    var waving = false, waveStart = 0, lastBeat = 0, rA = 0, rB = 0, raf = null, last = performance.now();
    var dustColor = opts.dustColor || 'currentColor';

    function dust() {
      if (!mount) return;
      var d = document.createElement('div');
      var x = curX + (dir > 0 ? 6 : SKELETON.W - 12) * cfg.size;
      d.style.cssText = 'position:absolute;top:50%;left:' + x + 'px;width:4px;height:4px;border-radius:50%;background:' + dustColor + ';pointer-events:none;opacity:.5;transition:transform .55s ease-out,opacity .55s ease-out;transform:translate(0,-1px)';
      mount.appendChild(d);
      requestAnimationFrame(function () { d.style.transform = 'translate(' + (-dir * 12) + 'px,-9px) scale(.25)'; d.style.opacity = '0'; });
      setTimeout(function () { d.remove(); }, 560);
    }

    function step(now) {
      var dt = Math.min(40, now - last); last = now;
      var dd = tgtX - curX, moving = false;
      if (!waving && !RM) {                       // FREEZE position while waving
        moving = Math.abs(dd) > 0.6;
        var mv = cfg.speed * dt / 1000;
        if (Math.abs(dd) <= mv) curX = tgtX; else curX += Math.sign(dd) * mv;
        if (moving) dir = Math.sign(dd);
      }
      if (waving && now - waveStart > WAVE_MS) waving = false;
      run += ((moving ? 1 : 0) - run) * 0.15;
      if (!RM) phase += cfg.tempo * (dt / 1000) * Math.max(run, 0);
      var beat = Math.floor(phase / Math.PI);
      if (beat !== lastBeat) { if (!RM && run > 0.5) dust(); if (beat % 2 === 0) rA = Math.random() * 2 - 1; else rB = Math.random() * 2 - 1; lastBeat = beat; }
      view.render(computePose({ phase: phase, run: run, dir: dir, waving: waving, t: now / 1000, rA: rA, rB: rB }, cfg));
      el.style.transform = 'translate(' + curX + 'px,' + (-SKELETON.FEET_Y) + 'px) scale(' + cfg.size + ')';
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    hit.addEventListener('click', function () { if (!waving) { waving = true; waveStart = performance.now(); } });

    return {
      el: el, config: cfg,
      setTarget: function (x) { tgtX = x; },
      wave: function () { if (!waving) { waving = true; waveStart = performance.now(); } },
      isWaving: function () { return waving; },
      destroy: function () { cancelAnimationFrame(raf); el.remove(); }
    };
  }

  /*
   * attachLineFollow(runner, opts) — common usage: chase the pointer's x along a horizontal
   * separator. opts: { line (the rule element), host (positioned ancestor, defaults to runner.el.parentNode) }.
   */
  function attachLineFollow(runner, opts) {
    var line = opts.line, host = opts.host || runner.el.parentNode;
    function move(e) {
      var h = host.getBoundingClientRect(), l = line.getBoundingClientRect();
      var lo = l.left - h.left, hi = l.right - h.left - 24;
      runner.setTarget(Math.max(lo, Math.min(hi, (e.clientX - h.left) - SKELETON.CX)));
    }
    window.addEventListener('pointermove', move);
    return function () { window.removeEventListener('pointermove', move); };
  }

  var Stickman = { SKELETON: SKELETON, CONFIG: CONFIG, WAVE_MS: WAVE_MS, computePose: computePose, createSVG: createSVG, createRunner: createRunner, attachLineFollow: attachLineFollow };
  root.Stickman = Stickman;
  if (typeof module !== 'undefined' && module.exports) module.exports = Stickman;
})(typeof window !== 'undefined' ? window : globalThis);
