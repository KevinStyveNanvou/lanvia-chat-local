import { Ban, CircleHelp, Laptop, Network, Radio, RefreshCw, Settings, ShieldCheck, Smartphone } from 'lucide-react';
import type { AppSnapshot, DiscoveredDevice, TrustedDevice } from '../../shared/types/models';

interface Props {
  snapshot: AppSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onSettings: () => void;
  onDiagnostics: () => void;
  onManual: () => void;
  onAbout: () => void;
}

function DeviceIcon({ mobile }: { mobile: boolean }): JSX.Element {
  return mobile ? <Smartphone size={19}/> : <Laptop size={20}/>;
}

function DeviceItem({ device, active, onSelect }: { device: DiscoveredDevice; active: boolean; onSelect: () => void }): JSX.Element {
  return <button className={`device-item ${active ? 'active' : ''}`} onClick={onSelect}>
    <span className="avatar"><DeviceIcon mobile={device.deviceType === 'mobile'}/></span>
    <span className="device-copy">
      <strong>{device.alias || device.deviceName}</strong>
      <small><i className={`status-dot ${device.status}`}/>{device.blocked ? 'Blocked' : device.status[0]?.toUpperCase() + device.status.slice(1)} · {device.platform}</small>
    </span>
    {device.blocked ? <Ban size={14} className="muted"/> : device.trusted ? <ShieldCheck size={14} className="trusted"/> : null}
  </button>;
}

function OfflineTrusted({ device, active, onSelect }: { device: Omit<TrustedDevice, 'sharedToken'>; active: boolean; onSelect: () => void }): JSX.Element {
  return <button className={`device-item ${active ? 'active' : ''}`} onClick={onSelect}>
    <span className="avatar"><DeviceIcon mobile={device.platform === 'android'}/></span>
    <span className="device-copy"><strong>{device.alias || device.lastName}</strong><small><i className="status-dot offline"/>{device.blocked ? 'Blocked' : 'Offline'} · {device.platform}</small></span>
    {device.blocked ? <Ban size={14} className="muted"/> : <ShieldCheck size={14} className="trusted"/>}
  </button>;
}

export function Sidebar({ snapshot, selectedId, onSelect, onRefresh, onSettings, onDiagnostics, onManual, onAbout }: Props): JSX.Element {
  const known = new Set(snapshot.devices.map((device) => device.deviceId));
  const offline = snapshot.trustedDevices.filter((device) => !known.has(device.deviceId));
  const onlineCount = snapshot.devices.filter((device) => device.status !== 'offline' && device.status !== 'failed').length;
  return <aside className="sidebar">
    <div className="brand-row"><div className="brand-mark">L</div><div><h1>LANVIA</h1><p>Your network. Nowhere else.</p></div></div>
    <div className="self-card">
      <span className="avatar self"><Laptop size={19}/></span>
      <div><strong>{snapshot.identity.deviceName}</strong><small><i className={`status-dot ${snapshot.diagnostics.control.state === 'running' ? 'connected' : 'failed'}`}/>{snapshot.diagnostics.control.state === 'running' ? 'Ready on LAN' : 'Network issue'}</small></div>
    </div>
    <div className="section-title"><span>Devices <b>{onlineCount}</b></span><button className="icon-button small" title="Refresh" onClick={onRefresh}><RefreshCw size={15}/></button></div>
    <div className="device-list">
      {snapshot.devices.map((device) => <DeviceItem key={device.deviceId} device={device} active={selectedId === device.deviceId} onSelect={() => onSelect(device.deviceId)}/>)}
      {offline.map((device) => <OfflineTrusted key={device.deviceId} device={device} active={selectedId === device.deviceId} onSelect={() => onSelect(device.deviceId)}/>)}
      {!snapshot.devices.length && !offline.length && <div className="sidebar-empty"><Network size={24}/><span>No devices yet</span></div>}
    </div>
    <nav className="sidebar-nav">
      <button onClick={onManual}><Radio size={17}/><span>Connect manually</span></button>
      <button onClick={onDiagnostics}><Network size={17}/><span>Network diagnostics</span></button>
      <button onClick={onSettings}><Settings size={17}/><span>Settings</span></button>
      <button onClick={onAbout}><CircleHelp size={17}/><span>About</span></button>
    </nav>
  </aside>;
}
