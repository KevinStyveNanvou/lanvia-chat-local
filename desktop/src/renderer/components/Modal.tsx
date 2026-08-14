import type { PropsWithChildren, ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, subtitle, onClose, children, wide = false }: PropsWithChildren<{ title: string; subtitle?: string; onClose: () => void; wide?: boolean }>): ReactNode {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header">
        <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18}/></button>
      </header>
      <div className="modal-body">{children}</div>
    </section>
  </div>;
}
