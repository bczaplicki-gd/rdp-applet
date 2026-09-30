# RDP Activity Indicator

GNOME Shell extension that shows the current `gnome-remote-desktop` RDP status in the top bar.

Supports GNOME Shell 46 and 50. Requires `gnome-remote-desktop` and `ss` (iproute2); Tailscale username lookup is optional.

The panel now shows one of these states:

- `RDP OFF` with no status dot when Remote Control is disabled
- `RDP NOT AVAILABLE` with a red status dot when Remote Control is enabled but no RDP method is actually available
- `RDP available` with a yellow status dot when at least one RDP method is available but no Remote Control client is connected
- `RDP <user>` or `RDP <user> +N` with a green status dot when one or more Remote Control clients are connected

## What it displays

When you open the applet menu, it shows:

- Available ports summary, for example `control 3390 • login 3389`
- `Remote Control` details, including configured vs actual listened port when port negotiation moves it
- inferred `Remote Login` details when another RDP listener is present on `3389`
- Remote Control client list with Tailscale username, raw IP fallback, and connection duration
- A menu action to turn Remote Control on or off directly from the applet

Example client entry:

- `alice (100.64.0.10) • 12m 5s`

## How it works

The extension:

- reads Remote Control state from `grdctl status`
- inspects actually listened RDP ports with `ss`
- infers a likely `Remote Login` listener on `3389` without calling privileged system commands
- infers which port belongs to Remote Control when port negotiation moves it away from `3389`
- resolves Tailscale usernames from `tailscale status --json`

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

After updating GNOME, run `make install` again to install the current compatibility metadata. On Wayland, log out and back in to load the update; toggling the extension does not reload its JavaScript modules.

## Notes

- The indicator refreshes every 3 seconds.
- Tailscale usernames are cached for 30 seconds.
- If `tailscale` is unavailable or a client is not on Tailscale, the extension falls back to the raw IP address.
- The applet avoids privileged `grdctl --system` calls, so `Remote Login` is shown as an inferred status based on listened ports.
- The Remote Login details are read-only; the menu action only toggles Remote Control.
