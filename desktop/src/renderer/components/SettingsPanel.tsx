import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DeviceIdentity, Settings } from '../../shared/types/models';

export function SettingsPanel({ identity, settings, onName, onSettings, onFolder }: {
  identity: DeviceIdentity;
  settings: Settings;
  onName: (name: string) => Promise<void>;
  onSettings: (patch: Partial<Settings>) => Promise<void>;
  onFolder: () => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState(identity.deviceName);
  const [ports, setPorts] = useState({ controlPort: settings.controlPort, transferPort: settings.transferPort, discoveryPort: settings.discoveryPort });
  useEffect(() => setName(identity.deviceName), [identity.deviceName]);
  return <div className="settings-form">
    <label><span>Device name<small>Visible to other LANVIA devices</small></span><div className="inline-control"><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)}/><button className="secondary-button compact" onClick={() => void onName(name)}>Save</button></div></label>
    <label><span>Download folder<small>Received files are never opened automatically</small></span><button className="folder-control" onClick={() => void onFolder()}><FolderOpen size={16}/><b>{settings.downloadFolder}</b></button></label>
    <label><span>Theme</span><select value={settings.theme} onChange={(e) => void onSettings({ theme: e.target.value as Settings['theme'] })}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select></label>
    <label className="toggle-row"><span>Launch at startup<small>Start LANVIA after sign-in</small></span><input type="checkbox" checked={settings.launchAtStartup} onChange={(e) => void onSettings({ launchAtStartup: e.target.checked })}/></label>
    <label className="toggle-row"><span>Minimize to tray<small>Keep receiving when the window closes</small></span><input type="checkbox" checked={settings.minimizeToTray} onChange={(e) => void onSettings({ minimizeToTray: e.target.checked })}/></label>
    <label className="toggle-row"><span>Notifications</span><input type="checkbox" checked={settings.notifications} onChange={(e) => void onSettings({ notifications: e.target.checked })}/></label>
    <div className="settings-section"><h3>Network ports</h3><p>Defaults are shared by both clients. Changed listener ports apply after restarting LANVIA and are advertised to peers.</p>
      <div className="ports-row">
        {(['controlPort', 'transferPort', 'discoveryPort'] as const).map((key) => <label key={key}><small>{key.replace('Port', '')}</small><input type="number" min={1} max={65535} value={ports[key]} onChange={(e) => setPorts({ ...ports, [key]: Number(e.target.value) })}/></label>)}
      </div>
      <button className="secondary-button" onClick={() => void onSettings(ports)}>Save ports</button>
    </div>
    <div className="settings-meta"><span>App version <b>{identity.appVersion}</b></span><span>Protocol <b>v{identity.protocolVersion}</b></span><span>Device ID <code>{identity.deviceId}</code></span></div>
  </div>;
}
