import { Copy, Network, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PORTS } from '../shared/constants/protocol.generated';
import type { AppEvent, AppSnapshot, Settings } from '../shared/types/models';
import { ChatPane, type PeerView } from './components/ChatPane';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { Modal } from './components/Modal';
import { SettingsPanel } from './components/SettingsPanel';
import { Sidebar } from './components/Sidebar';

type Dialog = 'settings' | 'diagnostics' | 'manual' | 'about' | null;

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error:\s*/, '');
}

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [manualHost, setManualHost] = useState('');
  const [manualPort, setManualPort] = useState<number>(PORTS.control);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void window.lanvia.getSnapshot().then((value) => { if (active) setSnapshot(value); }).catch((error) => setToast(errorMessage(error)));
    const unsubscribe = window.lanvia.onEvent((event: AppEvent) => {
      if (event.kind === 'snapshot') setSnapshot(event.snapshot);
      if (event.kind === 'network_changed') setToast(event.message);
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!snapshot) return;
    document.documentElement.dataset.theme = snapshot.settings.theme;
    if (!selectedId && snapshot.devices[0]) setSelectedId(snapshot.devices[0].deviceId);
  }, [snapshot, selectedId]);

  const peer = useMemo<PeerView | null>(() => {
    if (!snapshot || !selectedId) return null;
    const found = snapshot.devices.find((device) => device.deviceId === selectedId);
    if (found) return { deviceId: found.deviceId, name: found.alias || found.deviceName, platform: found.platform, deviceType: found.deviceType, status: found.status, trusted: found.trusted, blocked: found.blocked };
    const known = snapshot.trustedDevices.find((device) => device.deviceId === selectedId);
    return known ? { deviceId: known.deviceId, name: known.alias || known.lastName, platform: known.platform, deviceType: known.platform === 'android' ? 'mobile' : 'desktop', status: 'offline', trusted: true, blocked: known.blocked } : null;
  }, [snapshot, selectedId]);

  async function run(action: () => Promise<unknown> | unknown, success?: string): Promise<void> {
    try {
      setBusy(true);
      await action();
      if (success) setToast(success);
    } catch (error) {
      setToast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) return <div className="loading-screen"><div className="brand-mark large">L</div><strong>Starting LANVIA</strong><span>Preparing local network services…</span></div>;

  const messages = peer ? snapshot.messages.filter((message) => message.senderId === peer.deviceId || message.receiverId === peer.deviceId) : [];
  const transfers = peer ? snapshot.transfers.filter((transfer) => transfer.peerId === peer.deviceId) : [];
  const prompt = snapshot.pendingPairings[0];

  return <div className={`app-shell ${busy ? 'busy' : ''}`}>
    <Sidebar snapshot={snapshot} selectedId={selectedId} onSelect={setSelectedId} onRefresh={() => void run(() => window.lanvia.refreshDiscovery(), 'Searching for devices…')} onSettings={() => setDialog('settings')} onDiagnostics={() => setDialog('diagnostics')} onManual={() => setDialog('manual')} onAbout={() => setDialog('about')}/>
    <ChatPane
      peer={peer}
      ownId={snapshot.identity.deviceId}
      messages={messages}
      transfers={transfers}
      onConnect={() => run(() => window.lanvia.connectDevice(peer!.deviceId))}
      onPair={() => run(() => window.lanvia.pairDevice(peer!.deviceId), 'Pairing request sent')}
      onSend={(text) => run(() => window.lanvia.sendMessage(peer!.deviceId, text))}
      onRetry={(id) => run(() => window.lanvia.retryMessage(id))}
      onChoose={(category) => run(() => window.lanvia.chooseAndSendFiles(peer!.deviceId, category))}
      onDropFiles={(files) => run(() => window.lanvia.sendDroppedFiles(peer!.deviceId, files))}
      onTransfer={(action, id) => run(() => {
        if (action === 'accept') return window.lanvia.acceptTransfer(id);
        if (action === 'reject') return window.lanvia.rejectTransfer(id);
        if (action === 'pause') return window.lanvia.pauseTransfer(id);
        if (action === 'resume') return window.lanvia.resumeTransfer(id);
        if (action === 'cancel') return window.lanvia.cancelTransfer(id);
        return window.lanvia.revealTransfer(id);
      })}
      onRemoveTrust={() => run(() => window.lanvia.removeTrustedDevice(peer!.deviceId), 'Trusted device removed')}
      onBlock={(blocked) => run(() => window.lanvia.setDeviceBlocked(peer!.deviceId, blocked), blocked ? 'Device blocked' : 'Device unblocked')}
    />

    {prompt && <Modal title="Pairing request" subtitle="Confirm this request on this device" onClose={() => void run(() => window.lanvia.respondPairing(prompt.pairId, false))}>
      <div className="pairing-prompt"><span className="pair-icon"><ShieldCheck size={30}/></span><h3>{prompt.peerName}</h3><p>wants to connect with this device. Accept only if you recognize it on your local network.</p><div className="modal-actions"><button className="secondary-button" onClick={() => void run(() => window.lanvia.respondPairing(prompt.pairId, false))}>Reject</button><button className="primary-button" onClick={() => void run(() => window.lanvia.respondPairing(prompt.pairId, true), `${prompt.peerName} is now trusted`)}>Accept</button></div></div>
    </Modal>}

    {dialog === 'settings' && <Modal title="Settings" subtitle="Identity, storage and local network" onClose={() => setDialog(null)} wide><SettingsPanel identity={snapshot.identity} settings={snapshot.settings} onName={(name) => run(() => window.lanvia.updateDeviceName(name), 'Device name updated')} onSettings={(patch: Partial<Settings>) => run(() => window.lanvia.updateSettings(patch), 'Settings saved')} onFolder={() => run(() => window.lanvia.chooseDownloadFolder(), 'Download folder updated')}/></Modal>}
    {dialog === 'diagnostics' && <Modal title="Network diagnostics" subtitle="Everything needed to debug LAN discovery" onClose={() => setDialog(null)} wide><DiagnosticsPanel diagnostics={snapshot.diagnostics} onCopyLogs={() => void run(async () => { const logs = await window.lanvia.getLogs(); await navigator.clipboard.writeText(logs); }, 'Diagnostic logs copied')}/></Modal>}
    {dialog === 'manual' && <Modal title="Connect manually" subtitle="Use this when mDNS and UDP broadcast are blocked" onClose={() => setDialog(null)}>
      <div className="manual-form"><div className="manual-illustration"><Network size={28}/></div><label>IP address or LAN hostname<input autoFocus placeholder="192.168.2.152" value={manualHost} onChange={(event) => setManualHost(event.target.value)}/></label><label>Control port<input type="number" min={1} max={65535} value={manualPort} onChange={(event) => setManualPort(Number(event.target.value))}/></label><div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" onClick={() => void run(async () => { await window.lanvia.connectManual(manualHost, manualPort); setDialog(null); }, 'Device connected')}>Connect</button></div></div>
    </Modal>}
    {dialog === 'about' && <Modal title="About LANVIA" subtitle="Local-first peer-to-peer transfer" onClose={() => setDialog(null)}><div className="about-panel"><div className="brand-mark about">L</div><h2>LANVIA</h2><p>Your files. Your network. Nowhere else.</p><div className="about-facts"><span>Desktop {snapshot.identity.appVersion}</span><span>Protocol v{snapshot.identity.protocolVersion}</span><span>No cloud · No account · No Internet</span></div></div></Modal>}

    {toast && <div className="toast"><span>{toast.toLowerCase().includes('error') || toast.toLowerCase().includes('failed') ? <WifiOff size={17}/> : <Copy size={17}/>}</span>{toast}<button onClick={() => setToast(null)}>×</button></div>}
  </div>;
}
