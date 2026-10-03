// Tiny DevTools-protocol helper for the dev rig (zero deps; Node ≥ 22 has fetch + WebSocket).
//   node dev/cdp.mjs <port> eval '<js>'        → prints the value
//   node dev/cdp.mjs <port> shot <file.png>    → screenshot of the current page
//   node dev/cdp.mjs <port> nav <url>
//   node dev/cdp.mjs <port> size 960x480       → emulate a screen size (persists for the tab)
const [port, op, arg] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const my = ++id;
  const on = (e) => { const m = JSON.parse(e.data); if (m.id === my) { ws.removeEventListener('message', on); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id: my, method, params }));
});
if (op === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result ? r.result.value : r, null, 1));
} else if (op === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(arg, Buffer.from(r.data, 'base64'));
  console.log('saved', arg);
} else if (op === 'shotat') {
  // shotat <WxH> <file.png> <url>: size + load + wait + screenshot in ONE session (the override dies with the session)
  const [w, h] = arg.split('x').map(Number);
  const [file, url] = process.argv.slice(5);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 800 });
  await send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, Number(process.env.WAIT || 5000)));
  const r = await send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(file, Buffer.from(r.data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  console.log('saved', file, w + 'x' + h);
} else if (op === 'size') {
  const [w, h] = arg.split('x').map(Number);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 800 });
  console.log('size', w, h);
} else if (op === 'nav') {
  await send('Page.navigate', { url: arg });
  console.log('navigated');
}
ws.close();
process.exit(0);
