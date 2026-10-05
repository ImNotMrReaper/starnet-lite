'use strict';
/* frame-governor: simulated 60 Hz screen + clock + timers, no browser needed. */
const test = require('node:test');
const assert = require('node:assert');
const { install, parseRates } = require('../public/frame-governor.js');

function makeEnv({ focused = true, setting } = {}) {
  let t = 0, nextNative = 1, nextTimer = 1;
  const nativeQ = new Map(), timers = new Map(), listeners = {};
  const state = { focused, nativeCancels: [], errors: [] };
  const win = {
    requestAnimationFrame: (cb) => { const id = nextNative++; nativeQ.set(id, cb); return id; },
    cancelAnimationFrame: (id) => { state.nativeCancels.push(id); nativeQ.delete(id); },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
  };
  const opts = {
    setting,
    now: () => t,
    focused: () => state.focused,
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
    report: (e) => state.errors.push(e),
  };
  function run(ms) {                       // advance the clock in 1 ms steps; vsync every 1000/60 ms
    const end = t + ms;
    let nextVsync = Math.ceil(t / (1000 / 60)) * (1000 / 60);
    while (t < end) {
      t += 1;
      for (const [id, tm] of [...timers]) if (tm.at <= t) { timers.delete(id); tm.fn(); }
      if (t >= nextVsync) {
        nextVsync += 1000 / 60;
        const q = [...nativeQ]; nativeQ.clear();
        for (const [, cb] of q) cb(t);
      }
    }
  }
  const fire = (ev) => (listeners[ev] || []).forEach((fn) => fn());
  return { win, opts, state, run, fire, nativePending: () => nativeQ.size };
}

function loop(win) {                       // an animation loop like StarNet's world.js frame()
  const frames = [];
  const frame = (ts) => { frames.push(ts); win.requestAnimationFrame(frame); };
  win.requestAnimationFrame(frame);
  return frames;
}

test('focused window: about 30 frames per second instead of 60', () => {
  const env = makeEnv({ focused: true });
  assert.ok(install(env.win, {}, env.opts));
  const frames = loop(env.win);
  env.run(1000);
  assert.ok(frames.length >= 27 && frames.length <= 31, `got ${frames.length}`);
});

test('background window: about 4 frames per second', () => {
  const env = makeEnv({ focused: false });
  install(env.win, {}, env.opts);
  const frames = loop(env.win);
  env.run(2000);
  assert.ok(frames.length >= 7 && frames.length <= 9, `got ${frames.length} in 2 s`);
});

test('all callbacks requested in one interval run in the same tick', () => {
  const env = makeEnv();
  install(env.win, {}, env.opts);
  const seen = [];
  env.win.requestAnimationFrame((ts) => seen.push(['a', ts]));
  env.win.requestAnimationFrame((ts) => seen.push(['b', ts]));
  env.run(40);
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0][1], seen[1][1]);
});

test('cancel removes our callback; ids from before install go to the browser', () => {
  const env = makeEnv();
  const early = env.win.requestAnimationFrame(() => {});   // requested before the governor existed
  install(env.win, {}, env.opts);
  let ran = false;
  const id = env.win.requestAnimationFrame(() => { ran = true; });
  assert.ok(id >= 1e9);
  env.win.cancelAnimationFrame(id);
  env.run(100);
  assert.strictEqual(ran, false);
  env.win.cancelAnimationFrame(early);
  assert.deepStrictEqual(env.state.nativeCancels.filter((x) => x === early), [early]);
});

test('a throwing callback does not stop the others, and the error is reported', () => {
  const env = makeEnv();
  install(env.win, {}, env.opts);
  let ok = false;
  env.win.requestAnimationFrame(() => { throw new Error('boom'); });
  env.win.requestAnimationFrame(() => { ok = true; });
  env.run(40);
  assert.strictEqual(ok, true);
  assert.strictEqual(env.state.errors.length, 1);
});

test('off switch leaves the browser untouched', () => {
  const env = makeEnv({ setting: 'off' });
  const before = env.win.requestAnimationFrame;
  assert.strictEqual(install(env.win, {}, env.opts), null);
  assert.strictEqual(env.win.requestAnimationFrame, before);
});

test('custom rates and bounds', () => {
  assert.deepStrictEqual(parseRates('20,2'), { focused: 20, background: 2 });
  assert.deepStrictEqual(parseRates('0,999'), { focused: 1, background: 240 });
  assert.deepStrictEqual(parseRates('junk'), { focused: 30, background: 4 });
  assert.strictEqual(parseRates('off'), null);
});

test('regaining focus wakes the next frame immediately instead of waiting 250 ms', () => {
  const env = makeEnv({ focused: false });
  install(env.win, {}, env.opts);
  const frames = loop(env.win);
  env.run(300);                           // in background: a frame is now waiting on the 250 ms timer
  const n = frames.length;
  env.state.focused = true;
  env.fire('focus');
  env.run(20);                            // one vsync later
  assert.ok(frames.length > n, 'frame arrived right after focus');
});

test('installing twice is a no-op', () => {
  const env = makeEnv();
  assert.ok(install(env.win, {}, env.opts));
  assert.strictEqual(install(env.win, {}, env.opts), null);
});
