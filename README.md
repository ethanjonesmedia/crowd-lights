# Crowd Lights: phone light show for your stands

Fans scan a QR code, tap **Join**, and their phone screen becomes a light you control from one panel. They don't install an app or create an account.

- **Fan page:** `https://your-server/?s=3` (each section gets its own QR code)
- **Control panel:** `https://your-server/control` (PIN protected)

## Run it on your laptop (to try it out)

You only need Node.js 18 or newer, with no packages to install.

```bash
CONTROL_PIN=2468 node server.js
```

Open `http://localhost:3000/control` and enter your PIN. Then open `http://localhost:3000/?s=1` in another tab or on a phone on the same Wi-Fi (use your laptop's IP address, e.g. `http://192.168.1.20:3000/?s=1`).

## Put it online for game day

Phones need to reach the server over **HTTPS**. The screen-awake lock and the flashlight only work over HTTPS. Any host that runs Node works, for example:

| Host | Notes |
|---|---|
| **Railway** or **Render** (paid tier) | Push this folder to GitHub, create a "Web Service", start command `node server.js`, and add env var `CONTROL_PIN`. HTTPS is automatic. Avoid free tiers that go to sleep. |
| **Fly.io** | `fly launch`, then `fly secrets set CONTROL_PIN=2468`. |
| A small VPS ($5–6/mo) | Run behind Caddy or nginx for HTTPS. If you use nginx, turn off proxy buffering for `/events`. |

The server keeps everything in memory, so run **one instance** with no autoscaling. One small instance handles a few thousand phones, because messages only go out when you change something.

Environment variables:
- `CONTROL_PIN`: the operator PIN (**set this**; it defaults to 1234)
- `PORT`: the host normally sets this for you

## Game-day checklist

1. Set **Sections** in the control panel to match your stands, numbered left to right so the Wave travels across the crowd.
2. In the control panel, check that the **Fan link** is your public URL, then **Print QR codes** (one per section). Post them on signs and the scoreboard, or have the PA announce them.
3. Leave the effect on **Blackout** while people join. Fans see "You're in! Keep this screen open".
4. Watch the **phones connected** counter, then go.
5. Keyboard shortcuts: `1`–`9` pick effects, and `B` or `Esc` triggers Blackout.
6. Test on the actual stadium cell signal beforehand. If fans' data is weak, offer guest Wi-Fi.

## How the sync works

When you press a button, the server sends one small message, stamped to start about 0.3 s in the future. Each phone syncs its clock with the server and runs the effect itself. This keeps the whole crowd in step, and a phone that briefly loses signal keeps running the current effect.

## Limitations

- **iPhone flashlight:** iOS doesn't let websites control the flashlight, so the **screen** is the light. Android phones in Chrome can also opt in to the flashlight from the menu that appears when you tap the screen.
- **Screen sleep:** the page asks the phone to keep the screen on. This works on iOS 16.4+ and recent Android. On older phones, fans may need to turn off auto-lock.
- **Strobe is capped at 3 flashes per second** to reduce the risk of photosensitive seizures. The fan page warns about flashing lights. Don't remove either.
- Fans who leave the page or lock their phone drop out until they come back.
