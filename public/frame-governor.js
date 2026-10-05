/* StarNet Lite — frame governor. Added by the Lite add-on to the StarNet page on the COMPUTER only.
   Why: StarNet's station map redraws on every screen refresh (60+ fps) and only pauses when the window is HIDDEN.
   On Wayland a window covered by other windows is not hidden, so it kept burning ~90 % of a CPU core plus iGPU time
   that local AI models need (measured 2026-10-04). This batches every requestAnimationFrame callback into one tick:
     · focused window → FOCUSED_FPS (30)     · window in the background → BACKGROUND_FPS (4)
     · hidden/minimized → the browser already pauses frames (unchanged)
   StarNet's animations are time-based, so they look the same, just with fewer frames. No StarNet code is changed.
   Off switch (no code change): in the StarNet window's console run  localStorage.liteFrameGov = 'off'  and reload;
   custom rates:  localStorage.liteFrameGov = '30,4'  (focused,background). */
(function (root) {
  'use strict';

  var FOCUSED_FPS = 30, BACKGROUND_FPS = 4;

  function parseRates(setting) {
    if (setting === 'off') return null;
    var m = /^(\d{1,3}),(\d{1,3})$/.exec(String(setting || ''));
    if (!m) return { focused: FOCUSED_FPS, background: BACKGROUND_FPS };
    var f = Math.min(Math.max(+m[1], 1), 240), b = Math.min(Math.max(+m[2], 1), 240);
    return { focused: f, background: b };
  }

  function install(win, doc, opts) {
    opts = opts || {};
    if (!win || win.__LITE_FRAME_GOV__ || typeof win.requestAnimationFrame !== 'function') return null;
    var setting = opts.setting;
    if (setting === undefined) { try { setting = win.localStorage && win.localStorage.getItem('liteFrameGov'); } catch (_) {} }
    var rates = parseRates(setting);
    if (!rates) return null;                                   // switched off by the user

    var nativeRaf = win.requestAnimationFrame.bind(win);
    var nativeCaf = typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : function () {};
    var setT = opts.setTimeout || win.setTimeout.bind(win);
    var clearT = opts.clearTimeout || win.clearTimeout.bind(win);
    var now = opts.now || function () { return win.performance.now(); };
    var focused = opts.focused || function () { try { return doc.hasFocus(); } catch (_) { return true; } };
    var report = opts.report || function (e) { setT(function () { throw e; }, 0); };   // keep errors visible, never block

    var OWN = 1e9;                                          // our ids never collide with the browser's
    var queue = {}, count = 0, nextId = OWN, lastTick = -Infinity;
    var timer = null, rafHandle = null;

    function interval() { return 1000 / (focused() ? rates.focused : rates.background); }

    function tick(ts) {
      rafHandle = null;
      lastTick = now();
      var q = queue; queue = {}; count = 0;
      for (var id in q) { try { q[id](ts); } catch (e) { report(e); } }
    }
    function armRaf() { timer = null; if (rafHandle === null) rafHandle = nativeRaf(tick); }
    function schedule() {
      if (timer !== null || rafHandle !== null) return;
      // wake ~12 ms early: the browser then waits for the next screen refresh, which lands on the deadline
      var wait = lastTick + interval() - now() - 12;
      if (wait > 4) timer = setT(armRaf, wait); else armRaf();
    }
    function onFocus() {                                       // coming back to the window: no 250 ms wait
      if (timer !== null && count > 0) { clearT(timer); armRaf(); }
    }

    win.requestAnimationFrame = function (cb) {
      if (typeof cb !== 'function') return nativeRaf(cb);      // let the browser raise its own TypeError
      var id = nextId++; queue[id] = cb; count++; schedule(); return id;
    };
    win.cancelAnimationFrame = function (id) {
      if (!(id >= OWN)) return nativeCaf(id);                  // a frame requested before the governor loaded
      if (queue[id]) { delete queue[id]; count--; }
      if (count === 0) {
        if (timer !== null) { clearT(timer); timer = null; }
        if (rafHandle !== null) { nativeCaf(rafHandle); rafHandle = null; }
      }
    };
    try { win.addEventListener('focus', onFocus); } catch (_) {}
    win.__LITE_FRAME_GOV__ = { focusedFps: rates.focused, backgroundFps: rates.background };
    return win.__LITE_FRAME_GOV__;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { install: install, parseRates: parseRates };
  else if (root && root.document) { try { install(root, root.document); } catch (_) {} }   // never break StarNet
})(typeof window !== 'undefined' ? window : null);
