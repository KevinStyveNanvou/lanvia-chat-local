import { BrowserWindow, Menu, Tray, nativeImage } from 'electron';

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#5B21B6"/><path d="M8 8h5v12h11v5H8z" fill="#fff"/><circle cx="22" cy="10" r="3" fill="#A78BFA"/></svg>`;

export class SystemTray {
  private readonly tray: Tray;
  private deviceCount = 0;

  constructor(private readonly window: BrowserWindow, private readonly onQuit: () => void) {
    const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(ICON_SVG)}`);
    this.tray = new Tray(image.resize({ width: 20, height: 20 }));
    this.tray.setToolTip('LANVIA');
    this.tray.on('double-click', () => this.open());
    this.rebuild();
  }

  updateDeviceCount(count: number): void { this.deviceCount = count; this.rebuild(); }
  destroy(): void { this.tray.destroy(); }

  private open(): void {
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  private rebuild(): void {
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'LANVIA', enabled: false },
      { type: 'separator' },
      { label: 'Open LANVIA', click: () => this.open() },
      { label: `Devices (${this.deviceCount})`, enabled: false },
      { label: 'Settings', click: () => this.open() },
      { type: 'separator' },
      { label: 'Quit', click: this.onQuit },
    ]));
  }
}
