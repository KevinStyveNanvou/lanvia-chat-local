import { Check, Clipboard, Radio, TriangleAlert, X } from 'lucide-react';
import { PORTS } from '../../shared/constants/protocol.generated';
import type { Diagnostics } from '../../shared/types/models';

function Status({ ok }: { ok: boolean }): JSX.Element { return ok ? <Check className="ok" size={17}/> : <X className="bad" size={17}/>; }

export function DiagnosticsPanel({ diagnostics, onCopyLogs }: { diagnostics: Diagnostics; onCopyLogs: () => void }): JSX.Element {
  const first = diagnostics.localIps[0];
  return <div className="diagnostics">
    <div className="diag-hero"><span><Radio size={22}/></span><div><strong>LANVIA Network Diagnostics</strong><small>Updated {new Date(diagnostics.updatedAt).toLocaleTimeString()}</small></div></div>
    <div className="diag-grid">
      <div><small>Local IP</small><strong>{first?.address ?? 'No active LAN interface'}</strong><em>{first?.name ?? 'Connect to Wi-Fi or Ethernet'}</em></div>
      <div><small>Broadcast</small><strong>{first?.broadcast ?? 'Unavailable'}</strong><em>{first?.netmask ?? '—'}</em></div>
      <div><small>Control</small><strong>{diagnostics.control.port ?? PORTS.control} <Status ok={diagnostics.control.state === 'running'}/></strong><em>WebSocket · {diagnostics.control.state}</em></div>
      <div><small>Transfer</small><strong>{diagnostics.transfer.port ?? PORTS.transfer} <Status ok={diagnostics.transfer.state === 'running'}/></strong><em>HTTP · {diagnostics.transfer.state}</em></div>
      <div><small>Discovery</small><strong>{diagnostics.discovery.port ?? PORTS.discovery} <Status ok={diagnostics.discovery.state === 'running'}/></strong><em>UDP broadcast</em></div>
      <div><small>mDNS</small><strong>{diagnostics.mdns.state} <Status ok={diagnostics.mdns.state === 'running'}/></strong><em>_lanvia._tcp</em></div>
      <div><small>WebSocket peers</small><strong>{diagnostics.webSocketConnections}</strong><em>Active connections</em></div>
      <div><small>Devices</small><strong>{diagnostics.devicesDiscovered}</strong><em>Currently visible</em></div>
    </div>
    {[diagnostics.control.error, diagnostics.transfer.error, diagnostics.discovery.error, diagnostics.mdns.error].filter(Boolean).map((error) => <div className="warning" key={error}><TriangleAlert size={17}/>{error}</div>)}
    {diagnostics.firewallHint && <div className="warning"><TriangleAlert size={17}/>{diagnostics.firewallHint}</div>}
    <button className="secondary-button" onClick={onCopyLogs}><Clipboard size={16}/> Copy diagnostic logs</button>
  </div>;
}
