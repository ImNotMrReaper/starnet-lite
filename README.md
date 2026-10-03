# StarNet Lite

**Your [StarNet](https://github.com/androoAGI/starnet) station on your phone, Echo Show, tablet or Raspberry Pi — live, both ways.**

StarNet Lite is an add-on for StarNet. It works like Claude Code's *Remote Control*: the StarNet window on your computer stays
in charge, and every other device becomes a live screen into it. Type on your phone and the message appears in StarNet on the
computer; the agent's reply streams onto both, word by word. Approvals, crew, sessions and the live station view all follow along.

- **No changes to StarNet.** Lite sits in front of StarNet and adds a small helper to the StarNet page on your computer.
- **Light.** The phone page is a few dozen KB (full StarNet is ~9 MB of JavaScript), so it runs on an Echo Show 5 and Raspberry Pis.
- **Same look.** StarNet's own colours (your theme, live), VT323 font, wordmark, glowing frames and CRT scanlines. Heavy
  effects scale down automatically on weak devices.
- **Safe.** Devices never receive StarNet's access token. Allow needs a 1-second hold; Deny is one tap; a phone can never grant
  "full power". Requests from other websites are refused (CSRF protection), and the page cannot be framed.
- **Zero dependencies.** Node.js 18 or newer, nothing to `npm install`.

## How it works

```
 phone / Echo Show / Pi ──▶ Lite device door (:8788) ──▶ Lite ──▶ StarNet (:8786)
                                                          ▲
 your computer's StarNet window ──▶ Lite computer door (:8787, StarNet + helper)
```

StarNet keeps sessions, the chat in progress, agent settings and the map inside its window and saves them as one file. Two
full StarNet windows would overwrite each other. So Lite never edits StarNet's data itself: devices *ask*, and the helper in
the computer's window does it with StarNet's own functions (`Chat.sendOrQueue`, `StationCommands`, …). One writer, many screens.

## Setup (5 minutes)

1. **Get Lite** (next to your StarNet folder, any place works):
   ```bash
   git clone https://github.com/ImNotMrReaper/starnet-lite.git
   ```
2. **Move StarNet one port over** so Lite can take StarNet's usual address (`8787`). Start StarNet with `PORT=8786`
   (or `STARNET_PORT=8786`). Your StarNet shortcut keeps working unchanged.
3. **Start Lite:**
   ```bash
   cd starnet-lite && node server.js
   ```
4. **Reload the StarNet window on your computer once** (Ctrl+R) so it picks up the helper.
5. **On your phone / Echo Show / Pi**, open `http://<your-computer's-IP>:8788` (or your Tailscale address) and add it to the
   home screen. Small devices always get Lite at that address.

Settings (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `STARNET` | `127.0.0.1:8786` | where StarNet really runs |
| `LITE_LOCAL` | `127.0.0.1:8787` | the computer's own door (full StarNet + helper) — keep it on 127.0.0.1 |
| `LITE_REMOTE` | `0.0.0.0:8788` | the door for other devices (`off` to disable) |
| `LITE_THEME` | `amber` | colours before the computer connects (`amber green blue purple red white`) |
| `STARNET_DATA` | `~/.local/share/StarNet/workspaces` | StarNet's data folder (read-only fallbacks) |

**Run it at login (Linux, systemd user service):** see [`examples/starnet-lite.service`](examples/starnet-lite.service).

> ⚠ **Who can reach port 8788 can use your station** (there is no login, same as StarNet's own page). Allow it only from your
> home network and/or Tailscale with your firewall, e.g. `sudo ufw allow from 192.168.1.0/24 to any port 8788 proto tcp`.
> Never forward it to the internet.

> **Packaged StarNet desktop app (Tauri)?** It starts its own StarNet on 8787, so step 2 is not possible there. Set
> `LITE_LOCAL=127.0.0.1:8789 STARNET=127.0.0.1:8787` and open StarNet in your browser at `http://127.0.0.1:8789` instead.

## What works on the device

| | |
|---|---|
| **Station** | live camera of your station (the real StarNet view, ~1 frame/s) + crew status |
| **Comms** | every session, the full conversation, the reply as it is typed, tools the agent is using, send, stop, new session |
| **Approvals** | cards with the exact command; Deny / hold-to-Allow once / this session / always; questions from agents |
| **Crew** | who is working or waiting, talk to an agent, approval mode (Ask / hold for Full Power), reach (Safe Cell … This Computer) |
| **Work** | tasks (add, move), routines, quests, recent runs |
| **No JavaScript** | `/lite/basic` — crew, runs and approvals as plain forms (Pi Zero, tiny screens, old browsers) |
| **Computer closed** | read every session, approve/deny scheduled and channel runs; chatting waits until StarNet is open again |

Layouts: phone (portrait), short landscape screens (Echo Show 5 960×480, Pi 7" 800×480), big screens (StarNet's three-column
floor) and tiny 320×240 / 480×320 Pi LCDs.

## Raspberry Pi kiosk

On a Pi 4/5 with Raspberry Pi OS (Wayland/labwc), open Lite full-screen at boot:
```bash
chromium-browser --kiosk --noerrdialogs --disable-session-crashed-bubble http://<your-computer's-IP>:8788
```
Pi Zero / Pi 3 or a tiny SPI screen: use `http://<your-computer's-IP>:8788/lite/basic` in any browser.

## Develop

```bash
npm test                         # 9 tests against a fake StarNet
node dev/teststation.mjs         # throwaway StarNet station + fake AI + Lite (needs a StarNet checkout: STARNET_REPO=...)
```
Tested with StarNet `feat/harness-backend` @ `fbddbf99`. If a future StarNet renames something the helper uses, Lite says
"this StarNet version does not support that" instead of guessing.

## Credits

[StarNet](https://github.com/androoAGI/starnet) by Andrew Sims (MIT) — Lite reuses its look and talks to it through its own
public page functions and API. StarNet Lite by ImNotMrReaper, built with Claude. MIT licence.
