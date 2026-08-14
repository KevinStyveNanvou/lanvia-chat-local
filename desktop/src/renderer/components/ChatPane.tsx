import {
  Ban, Bold, Check, CheckCheck, CircleX, Clock3, Code2, Copy, File, FileAudio,
  FileImage, FileText, FileVideo, FolderOpen, Italic, Laptop, Link, MoreVertical,
  Paperclip, Pause, Play, Plus, RotateCcw, Send, ShieldCheck, Smartphone,
  Strikethrough, Underline, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, TransferRecord } from '../../shared/types/models';

export interface PeerView {
  deviceId: string;
  name: string;
  platform: string;
  deviceType: 'desktop' | 'mobile';
  status: string;
  trusted: boolean;
  blocked: boolean;
}

interface Props {
  peer: PeerView | null;
  ownId: string;
  messages: ChatMessage[];
  transfers: TransferRecord[];
  onConnect: () => Promise<void>;
  onPair: () => Promise<void>;
  onSend: (text: string) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
  onChoose: (category: 'file' | 'image' | 'video' | 'audio' | 'document') => Promise<void>;
  onDropFiles: (files: File[]) => Promise<void>;
  onTransfer: (action: 'accept' | 'reject' | 'pause' | 'resume' | 'cancel' | 'reveal', id: string) => Promise<void>;
  onRemoveTrust: () => Promise<void>;
  onBlock: (blocked: boolean) => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function renderFormattedText(text: string): JSX.Element[] {
  const expression = /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\*[^*\n]+\*)/g;
  const output: JSX.Element[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    if (match.index > cursor) output.push(<span key={`plain-${cursor}`}>{text.slice(cursor, match.index)}</span>);
    const token = match[0];
    if (token.startsWith('**')) output.push(<strong key={`bold-${match.index}`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('__')) output.push(<u key={`underline-${match.index}`}>{token.slice(2, -2)}</u>);
    else if (token.startsWith('~~')) output.push(<s key={`strike-${match.index}`}>{token.slice(2, -2)}</s>);
    else if (token.startsWith('`')) output.push(<code key={`code-${match.index}`}>{token.slice(1, -1)}</code>);
    else output.push(<em key={`italic-${match.index}`}>{token.slice(1, -1)}</em>);
    cursor = expression.lastIndex;
  }
  if (cursor < text.length) output.push(<span key={`plain-${cursor}`}>{text.slice(cursor)}</span>);
  return output;
}

function FileGlyph({ mime }: { mime: string }): JSX.Element {
  if (mime.startsWith('image/')) return <FileImage/>;
  if (mime.startsWith('video/')) return <FileVideo/>;
  if (mime.startsWith('audio/')) return <FileAudio/>;
  if (mime.includes('pdf') || mime.includes('document') || mime.startsWith('text/')) return <FileText/>;
  return <File/>;
}

function MessageStatus({ message }: { message: ChatMessage }): JSX.Element {
  if (message.status === 'failed') return <CircleX size={13}/>;
  if (message.status === 'delivered') return <CheckCheck size={14}/>;
  if (message.status === 'sent') return <Check size={14}/>;
  return <Clock3 size={12}/>;
}

function TransferCard({ transfer, onAction }: { transfer: TransferRecord; onAction: Props['onTransfer'] }): JSX.Element {
  const percent = transfer.size === 0 ? (transfer.state === 'completed' ? 100 : 0) : Math.min(100, Math.round((transfer.bytesTransferred / transfer.size) * 100));
  const mediaUrl = `lanvia-media://transfer/${transfer.transferId}`;
  const active = ['accepted', 'transferring', 'paused', 'verifying'].includes(transfer.state);
  return <article className={`transfer-card ${transfer.direction}`}>
    {transfer.state === 'completed' && transfer.mimeType.startsWith('image/') && <img className="media-preview" src={mediaUrl} alt={transfer.fileName}/>} 
    {transfer.state === 'completed' && transfer.mimeType.startsWith('video/') && <video className="media-preview" src={mediaUrl} controls preload="metadata"/>}
    {transfer.state === 'completed' && transfer.mimeType.startsWith('audio/') && <audio className="audio-preview" src={mediaUrl} controls preload="metadata"/>}
    <div className="file-row"><span className="file-glyph"><FileGlyph mime={transfer.mimeType}/></span><div><strong title={transfer.fileName}>{transfer.fileName}</strong><small>{formatBytes(transfer.size)} · {transfer.state}</small></div></div>
    {active && <><div className="progress-track"><span style={{ width: `${percent}%` }}/></div><div className="progress-copy"><span>{percent}%</span><span>{transfer.speed > 0 ? `${formatBytes(transfer.speed)}/s` : transfer.state}{transfer.remainingTime !== null && transfer.remainingTime > 0 ? ` · ${transfer.remainingTime}s left` : ''}</span></div></>}
    {transfer.error && <p className="transfer-error">{transfer.error}</p>}
    <div className="transfer-actions">
      {transfer.direction === 'incoming' && transfer.state === 'pending' && <><button className="mini primary" onClick={() => void onAction('accept', transfer.transferId)}>Accept</button><button className="mini" onClick={() => void onAction('reject', transfer.transferId)}>Reject</button></>}
      {transfer.direction === 'incoming' && transfer.state === 'transferring' && <button className="mini" onClick={() => void onAction('pause', transfer.transferId)}><Pause size={13}/> Pause</button>}
      {transfer.direction === 'incoming' && (transfer.state === 'paused' || transfer.state === 'failed') && <button className="mini" onClick={() => void onAction('resume', transfer.transferId)}><Play size={13}/> Resume</button>}
      {active && <button className="mini danger" onClick={() => void onAction('cancel', transfer.transferId)}><X size={13}/> Cancel</button>}
      {transfer.state === 'completed' && <button className="mini" onClick={() => void onAction('reveal', transfer.transferId)}><FolderOpen size={13}/> Show in folder</button>}
    </div>
  </article>;
}

export function ChatPane(props: Props): JSX.Element {
  const { peer, ownId, messages, transfers } = props;
  const [text, setText] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const timelineElement = useRef<HTMLElement>(null);
  const timeline = useMemo(() => [
    ...messages.map((value) => ({ type: 'message' as const, value, at: value.timestamp })),
    ...transfers.map((value) => ({ type: 'transfer' as const, value, at: value.createdAt })),
  ].sort((a, b) => a.at - b.at), [messages, transfers]);
  const lastTimelineKey = timeline.length === 0 ? 'empty' : (() => {
    const last = timeline[timeline.length - 1]!;
    return last.type === 'message' ? `m:${last.value.id}:${last.value.status}` : `t:${last.value.transferId}:${last.value.state}`;
  })();

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = timelineElement.current;
      if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [peer?.deviceId, lastTimelineKey]);

  async function send(): Promise<void> {
    if (!text.trim()) return;
    const value = text;
    setText('');
    try { await props.onSend(value); } catch { setText(value); }
    composer.current?.focus();
  }

  function wrapSelection(open: string, close = open): void {
    const input = composer.current;
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = text.slice(start, end);
    const next = `${text.slice(0, start)}${open}${selected}${close}${text.slice(end)}`;
    setText(next);
    requestAnimationFrame(() => {
      input.focus();
      const selectionStart = start + open.length;
      input.setSelectionRange(selectionStart, selectionStart + selected.length);
    });
  }

  if (!peer) return <main className="empty-chat">
    <div className="empty-orbit"><span>L</span></div>
    <h2>Your files. Your network.<br/>Nowhere else.</h2>
    <p>Select a device to start a direct, private LAN conversation.</p>
  </main>;

  const connected = peer.status === 'connected';
  const composerEnabled = connected && peer.trusted && !peer.blocked;
  return <main className="chat-pane" onDragEnter={(e) => { e.preventDefault(); setDragging(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={(e) => { e.preventDefault(); setDragging(false); void props.onDropFiles(Array.from(e.dataTransfer.files)); }}>
    <header className="chat-header">
      <span className="avatar large">{peer.deviceType === 'mobile' ? <Smartphone size={21}/> : <Laptop size={22}/>}</span>
      <div><strong>{peer.name}</strong><small><i className={`status-dot ${peer.status}`}/>{peer.blocked ? 'Blocked' : peer.status} · {peer.platform}</small></div>
      <div className="header-actions">
        {!peer.blocked && !connected && <button className="secondary-button compact" onClick={() => void props.onConnect()}><Link size={15}/> Connect</button>}
        {!peer.blocked && connected && !peer.trusted && <button className="primary-button compact" onClick={() => void props.onPair()}><ShieldCheck size={15}/> Pair</button>}
        <div className="menu-anchor"><button className="icon-button" onClick={() => setMoreOpen(!moreOpen)}><MoreVertical size={18}/></button>{moreOpen && <div className="popover right">{peer.trusted && <button onClick={() => { setMoreOpen(false); void props.onBlock(!peer.blocked); }}><Ban size={15}/>{peer.blocked ? 'Unblock device' : 'Block device'}</button>}{peer.trusted && <button className="danger-text" onClick={() => { setMoreOpen(false); void props.onRemoveTrust(); }}><CircleX size={15}/>Remove trusted device</button>}</div>}</div>
      </div>
    </header>
    <section className="timeline" ref={timelineElement}>
      {!timeline.length && <div className="conversation-start"><ShieldCheck size={22}/><strong>Direct LAN conversation</strong><span>Messages and files stay on your local network.</span></div>}
      {timeline.map((item) => item.type === 'message' ? <div key={`m-${item.value.id}`} className={`message-row ${item.value.senderId === ownId ? 'outgoing' : 'incoming'}`}>
        <div className="bubble">
          <p>{renderFormattedText(item.value.text)}</p>
          <small><button className="copy-message" title="Copy message" onClick={() => void navigator.clipboard.writeText(item.value.text)}><Copy size={11}/></button>{new Date(item.value.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<MessageStatus message={item.value}/></small>
          {item.value.status === 'failed' && item.value.senderId === ownId && <button className="retry" onClick={() => void props.onRetry(item.value.id)}><RotateCcw size={12}/> Retry</button>}
        </div>
      </div> : <div key={`t-${item.value.transferId}`} className={`message-row ${item.value.direction === 'outgoing' ? 'outgoing' : 'incoming'}`}><TransferCard transfer={item.value} onAction={props.onTransfer}/></div>)}
    </section>
    {!peer.trusted && <div className="trust-banner"><ShieldCheck size={18}/><span>{connected ? 'Pair this device before sending messages or files.' : 'Connect, then pair this device to begin.'}</span></div>}
    <footer className="composer-shell">
      <div className="format-toolbar" aria-label="Text formatting">
        <button title="Bold" disabled={!composerEnabled} onClick={() => wrapSelection('**')}><Bold size={14}/></button>
        <button title="Italic" disabled={!composerEnabled} onClick={() => wrapSelection('*')}><Italic size={14}/></button>
        <button title="Underline" disabled={!composerEnabled} onClick={() => wrapSelection('__')}><Underline size={14}/></button>
        <button title="Strikethrough" disabled={!composerEnabled} onClick={() => wrapSelection('~~')}><Strikethrough size={14}/></button>
        <button title="Code" disabled={!composerEnabled} onClick={() => wrapSelection('`')}><Code2 size={14}/></button>
      </div>
      <div className="composer">
        <div className="menu-anchor"><button className="attach-button" disabled={!composerEnabled} onClick={() => setAttachOpen(!attachOpen)}><Plus size={21}/></button>{attachOpen && <div className="popover attachments">
          {([['file', File, 'File'], ['image', FileImage, 'Image'], ['video', FileVideo, 'Video'], ['audio', FileAudio, 'Audio'], ['document', FileText, 'Document']] as const).map(([kind, Icon, label]) => <button key={kind} onClick={() => { setAttachOpen(false); void props.onChoose(kind); }}><Icon size={17}/>{label}</button>)}
        </div>}</div>
        <Paperclip className="composer-paperclip" size={17}/>
        <textarea ref={composer} value={text} disabled={!composerEnabled} rows={1} maxLength={65_536} placeholder={peer.trusted ? 'Write a message…' : 'Pair to start messaging'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}/>
        <button className="send-button" disabled={!text.trim() || !composerEnabled} onClick={() => void send()}><Send size={18}/></button>
      </div>
    </footer>
    {dragging && <div className="drop-overlay"><div><Paperclip size={30}/><strong>Drop to send with LANVIA</strong><span>Files transfer directly over your local network</span></div></div>}
  </main>;
}
