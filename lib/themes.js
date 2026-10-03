'use strict';
/* StarNet's six phosphor themes, copied from frontend/css/style.css (body.theme-*). StarNet keeps the picked
   theme in the browser, not on disk, so Lite can't read it: the default comes from LITE_THEME and each device
   can pick its own (cookie). Only the tokens Lite uses are kept; --ok / --bad are the same in every theme. */
const THEMES = {
  amber:  { ph: '#ffaa33', phBright: '#ffd9a3', phDim: '#b9791c', phFaint: '#1e1404', ink: '#190f02', bg: '#030201', panel: '#0c0704', warn: '#ffe97a', text: '#eec88f', gold: '#ffd34a' },
  green:  { ph: '#3dff70', phBright: '#ccffdb', phDim: '#1fae4e', phFaint: '#0c3a1d', ink: '#021407', bg: '#010503', panel: '#041c0d', warn: '#ffb641', text: '#8fe3ac', gold: '#d8f25a' },
  blue:   { ph: '#46c8ff', phBright: '#c8efff', phDim: '#1e87ba', phFaint: '#0a2c40', ink: '#021320', bg: '#010305', panel: '#051826', warn: '#ffc861', text: '#97d5ee', gold: '#5ce8c8' },
  purple: { ph: '#b46bff', phBright: '#e6d4ff', phDim: '#7d3fc4', phFaint: '#251038', ink: '#120720', bg: '#040208', panel: '#150a26', warn: '#ffb84a', text: '#c8a9ee', gold: '#f07ae0' },
  red:    { ph: '#ff4136', phBright: '#ffc9c2', phDim: '#b3271c', phFaint: '#3a0c08', ink: '#1f0603', bg: '#080201', panel: '#1a0705', warn: '#ffd24a', text: '#f0a89f', gold: '#ffab4a' },
  white:  { ph: '#e8f0e8', phBright: '#ffffff', phDim: '#97a397', phFaint: '#2c322c', ink: '#0c0f0c', bg: '#030403', panel: '#131713', warn: '#ffc247', text: '#d2dcd2', gold: '#ffe9a3' }
};

function themeCss(name) {
  const t = THEMES[name] || THEMES.amber;
  return `:root{--ph:${t.ph};--ph-bright:${t.phBright};--ph-dim:${t.phDim};--ph-faint:${t.phFaint};--ink:${t.ink};` +
    `--bg:${t.bg};--panel:${t.panel};--warn:${t.warn};--text:${t.text};--gold:${t.gold};--ok:#7bc88a;--bad:#ff5c4d}`;
}

module.exports = { THEMES, themeCss };
