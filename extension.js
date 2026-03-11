import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const INDICATOR_NAME = 'rdp-activity-indicator';
const REFRESH_INTERVAL_SECONDS = 3;
const TAILSCALE_CACHE_SECONDS = 30;
const RDP_SETTINGS_SCHEMA = 'org.gnome.desktop.remote-desktop.rdp';
const GRD_SERVICE_NAME = 'gnome-remote-desktop.service';

function normalizeAddress(address) {
    if (!address)
        return null;

    let host = address;

    if (host.startsWith('[')) {
        const endBracket = host.indexOf(']');
        host = endBracket >= 0 ? host.slice(1, endBracket) : host;
    } else {
        const lastColon = host.lastIndexOf(':');
        host = lastColon >= 0 ? host.slice(0, lastColon) : host;
    }

    if (host.startsWith('::ffff:'))
        host = host.slice('::ffff:'.length);

    return host || null;
}

function parseClientAddresses(stdout) {
    const addresses = new Set();

    for (const line of stdout.split('\n')) {
        const trimmedLine = line.trim();
        if (!trimmedLine)
            continue;

        const columns = trimmedLine.split(/\s+/);
        const peerAddress = columns.at(-1);
        const normalizedAddress = normalizeAddress(peerAddress);

        if (normalizedAddress)
            addresses.add(normalizedAddress);
    }

    return [...addresses].sort((left, right) => left.localeCompare(right, undefined, {numeric: true}));
}

function formatDuration(seconds) {
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainderSeconds = totalSeconds % 60;

    if (hours > 0)
        return `${hours}h ${minutes}m`;

    if (minutes > 0)
        return `${minutes}m ${remainderSeconds}s`;

    return `${remainderSeconds}s`;
}

function isTailscaleAddress(address) {
    return address.startsWith('100.');
}

function parseTailscaleUsers(statusJson) {
    const usersById = new Map();
    const usernamesByIp = new Map();

    for (const [userId, user] of Object.entries(statusJson.User ?? {}))
        usersById.set(String(userId), user?.LoginName || user?.DisplayName || null);

    for (const peer of Object.values(statusJson.Peer ?? {})) {
        const username = usersById.get(String(peer?.UserID));
        if (!username)
            continue;

        for (const ip of peer?.TailscaleIPs ?? [])
            usernamesByIp.set(ip, username);
    }

    return usernamesByIp;
}

function runCommand(argv) {
    return new Promise((resolve, reject) => {
        let subprocess;

        try {
            subprocess = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (error) {
            reject(error);
            return;
        }

        subprocess.communicate_utf8_async(null, null, (process, result) => {
            try {
                const [, stdout, stderr] = process.communicate_utf8_finish(result);
                resolve({
                    successful: process.get_successful(),
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                });
            } catch (error) {
                reject(error);
            }
        });
    });
}

const RdpActivityIndicator = GObject.registerClass(
class RdpActivityIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'RDP Activity Indicator');

        this._destroyed = false;
        this._refreshInFlight = false;
        this._refreshSourceId = null;
        this._settingsSignals = [];
        this._clientSince = new Map();
        this._tailscaleUsersByIp = new Map();
        this._tailscaleCacheUntil = 0;
        this._rdpSettings = new Gio.Settings({schema_id: RDP_SETTINGS_SCHEMA});

        const panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        this._icon = new St.Icon({
            icon_name: 'network-wired-symbolic',
            style_class: 'system-status-icon',
        });

        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'rdp-activity-label',
        });
        this._dot = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'rdp-activity-dot',
        });

        panelBox.add_child(this._icon);
        panelBox.add_child(this._label);
        panelBox.add_child(this._dot);
        this.add_child(panelBox);

        this._stateItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._portItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._clientsSection = new PopupMenu.PopupMenuSection();
        this._actionItem = new PopupMenu.PopupMenuItem('');

        this._actionItem.connect('activate', () => {
            this._toggleRdpEnabled();
        });

        this.menu.addMenuItem(this._stateItem);
        this.menu.addMenuItem(this._portItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._clientsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._actionItem);

        for (const key of ['enable', 'port', 'negotiate-port']) {
            this._settingsSignals.push(this._rdpSettings.connect(`changed::${key}`, () => {
                this._refresh();
            }));
        }

        this._setUnavailable('RDP NOT AVAILABLE', 'RDP is disabled or not running');
        this._refresh();
        this._refreshSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _getConfiguredPort() {
        const configuredPort = this._rdpSettings?.get_value('port')?.unpack?.() ?? 0;
        return configuredPort > 0 ? configuredPort : 3389;
    }

    _getNowSeconds() {
        return Math.floor(GLib.get_monotonic_time() / 1000000);
    }

    _setStatusDot(dotClass, text = '●') {
        this._dot.text = text;
        this._dot.remove_style_class_name('rdp-activity-dot-connected');
        this._dot.remove_style_class_name('rdp-activity-dot-available');
        this._dot.remove_style_class_name('rdp-activity-dot-unavailable');

        if (dotClass)
            this._dot.add_style_class_name(dotClass);
    }

    _setActionLabel(label) {
        this._actionItem.label.text = label;
    }

    _setOff() {
        this._label.text = 'RDP OFF';
        this._stateItem.label.text = 'RDP is disabled';
        this._portItem.label.text = `Configured port: ${this._getConfiguredPort()}`;
        this._setActionLabel('Turn On RDP');
        this._setStatusDot(null, '');
        this._rebuildClientItems([]);
        this.show();
    }

    _setUnavailable(summary, details) {
        this._label.text = summary;
        this._stateItem.label.text = details;
        this._portItem.label.text = `Configured port: ${this._getConfiguredPort()}`;
        this._setActionLabel('Turn Off RDP');
        this._setStatusDot('rdp-activity-dot-unavailable');
        this._rebuildClientItems([]);
        this.show();
    }

    _setAvailable() {
        this._label.text = 'RDP available';
        this._stateItem.label.text = 'No active RDP client';
        this._portItem.label.text = `Configured port: ${this._getConfiguredPort()}`;
        this._setActionLabel('Turn Off RDP');
        this._setStatusDot('rdp-activity-dot-available');
        this._rebuildClientItems([]);
        this.show();
    }

    _setConnected(clients) {
        const [firstClient] = clients;
        const firstSummary = firstClient.username || firstClient.address;

        this._label.text = clients.length === 1
            ? `RDP ${firstSummary}`
            : `RDP ${firstSummary} +${clients.length - 1}`;

        this._stateItem.label.text = clients.length === 1
            ? '1 active RDP client'
            : `${clients.length} active RDP clients`;

        this._portItem.label.text = `Configured port: ${this._getConfiguredPort()}`;
        this._setActionLabel('Turn Off RDP');
        this._setStatusDot('rdp-activity-dot-connected');
        this._rebuildClientItems(clients);
        this.show();
    }

    _rebuildClientItems(clients) {
        this._clientsSection.removeAll();

        if (clients.length === 0) {
            this._clientsSection.addMenuItem(new PopupMenu.PopupMenuItem('No connected clients', {
                reactive: false,
                can_focus: false,
            }));
            return;
        }

        for (const client of clients) {
            const label = client.username
                ? `${client.username} (${client.address}) • ${client.duration}`
                : `${client.address} • ${client.duration}`;

            this._clientsSection.addMenuItem(new PopupMenu.PopupMenuItem(label, {
                reactive: false,
                can_focus: false,
            }));
        }
    }

    _pruneClientSessions(activeAddresses) {
        const nowSeconds = this._getNowSeconds();
        const activeSet = new Set(activeAddresses);

        for (const address of activeAddresses) {
            if (!this._clientSince.has(address))
                this._clientSince.set(address, nowSeconds);
        }

        for (const knownAddress of this._clientSince.keys()) {
            if (!activeSet.has(knownAddress))
                this._clientSince.delete(knownAddress);
        }
    }

    async _getServiceState() {
        const result = await runCommand(['systemctl', '--user', 'is-active', GRD_SERVICE_NAME]);
        return result.stdout.trim() || result.stderr.trim() || 'inactive';
    }

    async _getTailscaleUsers(activeAddresses) {
        const hasTailscaleClients = activeAddresses.some(address => isTailscaleAddress(address));
        if (!hasTailscaleClients)
            return new Map();

        const nowSeconds = this._getNowSeconds();
        if (this._tailscaleUsersByIp.size > 0 && nowSeconds < this._tailscaleCacheUntil)
            return this._tailscaleUsersByIp;

        try {
            const result = await runCommand(['tailscale', 'status', '--json']);
            if (!result.successful)
                return new Map();

            this._tailscaleUsersByIp = parseTailscaleUsers(JSON.parse(result.stdout));
            this._tailscaleCacheUntil = nowSeconds + TAILSCALE_CACHE_SECONDS;
            return this._tailscaleUsersByIp;
        } catch (error) {
            return new Map();
        }
    }

    _toggleRdpEnabled() {
        const enabled = this._rdpSettings.get_boolean('enable');
        this._rdpSettings.set_boolean('enable', !enabled);
        this._refresh();
    }

    _buildClients(activeAddresses, tailscaleUsersByIp) {
        const nowSeconds = this._getNowSeconds();

        return activeAddresses.map(address => {
            const startedAt = this._clientSince.get(address) ?? nowSeconds;
            return {
                address,
                username: tailscaleUsersByIp.get(address) ?? null,
                duration: formatDuration(nowSeconds - startedAt),
            };
        });
    }

    _refresh() {
        void this._refreshAsync();
    }

    async _refreshAsync() {
        if (this._destroyed || this._refreshInFlight)
            return;

        this._refreshInFlight = true;

        try {
            if (!this._rdpSettings.get_boolean('enable')) {
                this._clientSince.clear();
                this._setOff();
                return;
            }

            const serviceState = await this._getServiceState();
            if (this._destroyed)
                return;

            if (serviceState !== 'active') {
                this._clientSince.clear();
                this._setUnavailable('RDP NOT AVAILABLE', `Service state: ${serviceState}`);
                return;
            }

            const result = await runCommand([
                'ss',
                '-Htn',
                'state',
                'established',
                `( sport = :${this._getConfiguredPort()} )`,
            ]);

            if (this._destroyed)
                return;

            if (!result.successful) {
                this._setUnavailable('RDP NOT AVAILABLE', result.stderr.trim() || 'The ss command failed');
                return;
            }

            const activeAddresses = parseClientAddresses(result.stdout);
            this._pruneClientSessions(activeAddresses);

            if (activeAddresses.length === 0) {
                this._setAvailable();
                return;
            }

            const tailscaleUsersByIp = await this._getTailscaleUsers(activeAddresses);
            if (this._destroyed)
                return;

            this._setConnected(this._buildClients(activeAddresses, tailscaleUsersByIp));
        } catch (error) {
            if (!this._destroyed)
                this._setUnavailable('RDP NOT AVAILABLE', error.message);
        } finally {
            this._refreshInFlight = false;
        }
    }

    destroy() {
        this._destroyed = true;

        if (this._refreshSourceId !== null) {
            GLib.source_remove(this._refreshSourceId);
            this._refreshSourceId = null;
        }

        for (const signalId of this._settingsSignals)
            this._rdpSettings.disconnect(signalId);

        this._clientSince.clear();
        this._tailscaleUsersByIp.clear();
        this._settingsSignals = [];
        this._rdpSettings = null;

        super.destroy();
    }
});

export default class RdpActivityExtension extends Extension {
    enable() {
        this._indicator = new RdpActivityIndicator();
        Main.panel.addToStatusArea(INDICATOR_NAME, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
