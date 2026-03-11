# RDP Activity Indicator

GNOME Shell extension that shows the current `gnome-remote-desktop` RDP status in the top bar.

The panel now shows one of these states:

- `RDP OFF` with no status dot when RDP is disabled
- `RDP NOT AVAILABLE` with a red status dot when RDP is enabled but the user service is not active
- `RDP available` with a yellow status dot when the service is up but no client is connected
- `RDP <user>` or `RDP <user> +N` with a green status dot when one or more clients are connected

## What it displays

When clients are connected, the menu lists each client with:

- Tailscale username, when the client IP is a Tailscale `100.x.x.x` address and it can be matched from `tailscale status --json`
- Raw client IP as a fallback
- Session duration since the client first appeared in the active TCP session list
- A menu action to turn RDP on or off directly from the applet

Example menu entry:

- `alice (100.64.0.10) • 12m 5s`

## How it works

The extension:

- reads the configured RDP port from `org.gnome.desktop.remote-desktop.rdp`
- checks whether `gnome-remote-desktop.service` is active
- polls active TCP sessions with `ss`
- optionally resolves Tailscale usernames from `tailscale status --json`

## Install locally

```bash
UUID=rdp-activity@bczaplicki
mkdir -p ~/.local/share/gnome-shell/extensions/$UUID
cp metadata.json extension.js stylesheet.css README.md ~/.local/share/gnome-shell/extensions/$UUID/
```

Then restart GNOME Shell or log out and back in, and enable the extension:

```bash
gnome-extensions enable rdp-activity@bczaplicki
```

## Notes

- The indicator refreshes every 3 seconds.
- Tailscale usernames are cached for 30 seconds.
- If `tailscale` is unavailable or a client is not on Tailscale, the extension falls back to the raw IP address.
