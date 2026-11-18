import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'io.github.erhanzeyrek.WifiHotspot';
const OBJECT_PATH = '/io/github/erhanzeyrek/WifiHotspot';
const INTERFACE_NAME = 'io.github.erhanzeyrek.WifiHotspot';

const HotspotDBusInterface = `
<node>
  <interface name="${INTERFACE_NAME}">
    <method name="Start">
      <arg type="s" name="result" direction="out"/>
    </method>
    <method name="Stop">
      <arg type="b" name="success" direction="out"/>
    </method>
    <method name="GetStatus">
      <arg type="s" name="status_json" direction="out"/>
    </method>
    <method name="GetClients">
      <arg type="s" name="clients_json" direction="out"/>
    </method>
    <method name="GetConfig">
      <arg type="s" name="config_json" direction="out"/>
    </method>
    <method name="SetConfig">
      <arg type="s" name="config_json" direction="in"/>
      <arg type="b" name="success" direction="out"/>
    </method>
    <method name="SwitchBandAndReconnect">
      <arg type="s" name="target_band" direction="in"/>
      <arg type="s" name="result_json" direction="out"/>
    </method>
    <signal name="StatusChanged">
      <arg type="s" name="status_json"/>
    </signal>
    <signal name="ClientsChanged">
      <arg type="s" name="clients_json"/>
    </signal>
    <signal name="UserActionRequired">
      <arg type="s" name="action_json"/>
    </signal>
  </interface>
</node>`;

const HotspotProxy = Gio.DBusProxy.makeProxyWrapper(HotspotDBusInterface);

const HotspotToggle = GObject.registerClass(
class HotspotToggle extends QuickSettings.QuickMenuToggle {
    _init(extension) {
        super._init({
            title: _('Wi-Fi Hotspot'),
            subtitle: _('Off'),
            iconName: 'network-wireless-hotspot-symbolic',
            toggleMode: true,
        });

        this._extension = extension;
        this._isBusy = false;
        this._clients = [];
        this._status = { active: false, ssid: '', client_count: 0 };

        // 1. Configure Header & Menu
        this.menu.setHeader('network-wireless-hotspot-symbolic', _('Wi-Fi Hotspot'), _('Off'));

        // 2. Dynamic Details Section
        this._detailsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._detailsSection);

        // 3. Separator & Hotspot Settings Link
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction(_('Hotspot Settings'), () => {
            this._openSettings();
        });

        // 4. Primary Button Click Event
        this.connect('clicked', () => this._onToggleClicked());

        // 5. Connect D-Bus Proxy
        this._initDBus();
    }

    _initDBus() {
        try {
            this._proxy = new HotspotProxy(
                Gio.DBus.system,
                BUS_NAME,
                OBJECT_PATH,
                (proxy, error) => {
                    if (error) {
                        console.warn(`[Hotspot] D-Bus proxy error: ${error.message}`);
                        return;
                    }
                    this._onProxyReady();
                }
            );
        } catch (e) {
            console.error(`[Hotspot] Failed to create D-Bus proxy: ${e}`);
        }
    }

    _onProxyReady() {
        // Listen to signals
        this._statusSignalId = this._proxy.connectSignal('StatusChanged', (_proxy, _sender, [statusJson]) => {
            try {
                const status = JSON.parse(statusJson);
                this._updateUI(status);
            } catch (e) {
                console.error(`[Hotspot] StatusChanged parse error: ${e}`);
            }
        });

        this._clientsSignalId = this._proxy.connectSignal('ClientsChanged', (_proxy, _sender, [clientsJson]) => {
            try {
                this._clients = JSON.parse(clientsJson);
                this._renderMenuDetails();
            } catch (e) {
                console.error(`[Hotspot] ClientsChanged parse error: ${e}`);
            }
        });

        this._actionSignalId = this._proxy.connectSignal('UserActionRequired', (_proxy, _sender, [actionJson]) => {
            try {
                const action = JSON.parse(actionJson);
                this._handleUserActionRequired(action);
            } catch (e) {
                console.error(`[Hotspot] UserActionRequired parse error: ${e}`);
            }
        });

        // Initial status query
        this._queryStatus();

        // Polling fallback every 5s
        this._pollTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._queryStatus();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _queryStatus() {
        if (!this._proxy || this._isBusy) return;
        this._proxy.GetStatusRemote((result, error) => {
            if (error) return;
            try {
                const [statusJson] = result;
                const status = JSON.parse(statusJson);
                this._updateUI(status);
            } catch (e) {}
        });
    }

    _updateUI(status) {
        this._status = status;
        const active = !!status.active;
        this.checked = active;

        if (active) {
            const count = status.client_count || this._clients.length;
            this.subtitle = count > 0 ? `${status.ssid} (${count} devices)` : (status.ssid || _('On'));
            this.menu.setHeader('network-wireless-hotspot-symbolic', status.ssid || _('Wi-Fi Hotspot'), _('Active'));
        } else {
            this.subtitle = _('Off');
            this.menu.setHeader('network-wireless-hotspot-symbolic', _('Wi-Fi Hotspot'), _('Off'));
        }

        if (this._extension.indicator) {
            this._extension.indicator.visible = active;
        }

        this._renderMenuDetails();
    }

    _renderMenuDetails() {
        this._detailsSection.removeAll();

        if (this._status.active) {
            const bandText = (this._status.band && this._status.band !== 'auto') ? `${this._status.band} GHz` : '2.4 GHz';
            const ssidItem = new PopupMenu.PopupImageMenuItem(
                `SSID: ${this._status.ssid || 'Hotspot'} (${bandText})`,
                'network-wireless-hotspot-symbolic'
            );
            ssidItem.reactive = false;
            this._detailsSection.addMenuItem(ssidItem);

            const countItem = new PopupMenu.PopupMenuItem(
                `Connected Devices: ${this._clients.length}`
            );
            countItem.reactive = false;
            this._detailsSection.addMenuItem(countItem);

            for (const client of this._clients) {
                let label = '';
                if (client.hostname && client.ip) {
                    label = `${client.hostname} (${client.ip})`;
                } else if (client.hostname) {
                    label = client.hostname;
                } else if (client.ip) {
                    label = `Device (${client.ip})`;
                } else {
                    label = `Device (${_('Connecting...')})`;
                }
                const clientRow = new PopupMenu.PopupImageMenuItem(label, 'computer-symbolic');
                clientRow.reactive = false;
                this._detailsSection.addMenuItem(clientRow);
            }
        } else {
            const item = new PopupMenu.PopupMenuItem(_('Hotspot is currently turned off.'));
            item.reactive = false;
            this._detailsSection.addMenuItem(item);
        }
    }

    _onToggleClicked() {
        if (!this._proxy || this._isBusy) return;
        this._isBusy = true;

        const isCurrentlyActive = !!this._status.active;

        if (isCurrentlyActive) {
            // Currently active -> Turn OFF
            this.subtitle = _('Stopping...');
            this._proxy.StopRemote((result, error) => {
                this._isBusy = false;
                if (error) {
                    console.error(`[Hotspot] Stop error: ${error.message}`);
                    Main.notify(_('Wi-Fi Hotspot'), _('Stop error: ') + error.message);
                }
                this._queryStatus();
            });
        } else {
            // Currently inactive -> Turn ON
            this.subtitle = _('Starting...');
            this._proxy.StartRemote((result, error) => {
                this._isBusy = false;
                if (error) {
                    console.error(`[Hotspot] Start error: ${error.message}`);
                    let userMsg = error.message;
                    if (error.message.includes('ServiceUnknown') || error.message.includes('not activatable')) {
                        userMsg = _('Background service (daemon) is not running.');
                    }
                    Main.notify(_('Wi-Fi Hotspot'), _('Start error: ') + userMsg);
                    this.checked = false;
                    this.subtitle = _('Off');
                    return;
                }

                try {
                    const [resJson] = result;
                    const res = JSON.parse(resJson);
                    if (!res.success && res.action_required === 'band_switch') {
                        this._handleUserActionRequired(res);
                    } else if (!res.success) {
                        Main.notify(_('Wi-Fi Hotspot'), _('Start error: ') + (res.error || _('Failed to start Hotspot.')));
                        this.checked = false;
                        this.subtitle = _('Off');
                        return;
                    }
                } catch (e) {}

                this._queryStatus();
            });
        }
    }

    _handleUserActionRequired(action) {
        if (action.type === 'band_switch') {
            const msg = action.message || _("Your Wi-Fi adapter does not support 5GHz Hotspot. Switch to 2.4GHz and start?");
            
            // Show system notification with quick action button
            const source = new MessageTray.Source({
                title: _('Wi-Fi Hotspot'),
                iconName: 'network-wireless-hotspot-symbolic',
            });
            Main.messageTray.add(source);

            const notification = new MessageTray.Notification({
                source: source,
                title: _('Band Compatibility Warning'),
                body: msg,
                isTransient: false,
            });

            notification.addAction(_("Switch to 2.4GHz and Start"), () => {
                this.subtitle = _("Switching to 2.4GHz...");
                this._proxy.SwitchBandAndReconnectRemote('2.4', (res, err) => {
                    if (err) {
                        Main.notify(_('Wi-Fi Hotspot'), _('Band switch error: ') + err.message);
                        return;
                    }
                    // Automatically trigger start after 2 seconds
                    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                        this._onToggleClicked();
                        return GLib.SOURCE_REMOVE;
                    });
                });
            });

            source.addNotification(notification);
        }
    }

    _openSettings() {
        try {
            this._extension.openPreferences();
            return;
        } catch (e) {
            console.log(`[Hotspot] openPreferences failed, trying subprocess: ${e}`);
        }

        try {
            const devScript = GLib.build_filenamev([
                GLib.get_home_dir(),
                'source',
                'gnome-wifi-hotspot',
                'settings',
                'main.py',
            ]);
            const proc = new Gio.Subprocess({
                argv: ['python3', devScript],
                flags: Gio.SubprocessFlags.NONE,
            });
            proc.init(null);
        } catch (err) {
            console.error(`[Hotspot] Could not launch settings: ${err}`);
        }
    }

    destroy() {
        if (this._pollTimer) {
            GLib.source_remove(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._proxy) {
            if (this._statusSignalId) this._proxy.disconnectSignal(this._statusSignalId);
            if (this._clientsSignalId) this._proxy.disconnectSignal(this._clientsSignalId);
            if (this._actionSignalId) this._proxy.disconnectSignal(this._actionSignalId);
            this._proxy = null;
        }
        super.destroy();
    }
});

const HotspotIndicator = GObject.registerClass(
class HotspotIndicator extends QuickSettings.SystemIndicator {
    _init(extension) {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.iconName = 'network-wireless-hotspot-symbolic';
        this._indicator.visible = false;

        this._toggle = new HotspotToggle(extension);
        this.quickSettingsItems.push(this._toggle);
    }

    get indicator() {
        return this._indicator;
    }

    destroy() {
        if (this._toggle) {
            this._toggle.destroy();
            this._toggle = null;
        }
        super.destroy();
    }
});

export default class WifiHotspotExtension extends Extension {
    enable() {
        this._indicator = new HotspotIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    get indicator() {
        return this._indicator ? this._indicator.indicator : null;
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
