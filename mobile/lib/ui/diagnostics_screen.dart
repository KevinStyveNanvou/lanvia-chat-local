import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../devices/providers/lanvia_controller.dart';

class DiagnosticsScreen extends StatelessWidget {
  const DiagnosticsScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final c = context.watch<LanviaController>();
    final interface = c.interfaces.isEmpty ? null : c.interfaces.first;
    return Scaffold(
      appBar: AppBar(title: const Text('Network diagnostics')),
      body: RefreshIndicator(
        onRefresh: c.refresh,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: <Widget>[
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: const Color(0x22181126),
                borderRadius: BorderRadius.circular(17),
                border: Border.all(color: const Color(0x227C3AED)),
              ),
              child: const Row(
                children: <Widget>[
                  CircleAvatar(
                    backgroundColor: Color(0x225B21B6),
                    child: Icon(
                      Icons.monitor_heart_outlined,
                      color: Color(0xFFA78BFA),
                    ),
                  ),
                  SizedBox(width: 12),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        'LANVIA Network Diagnostics',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      Text(
                        'Live local service state',
                        style: TextStyle(
                          color: Color(0xFFA8A0B8),
                          fontSize: 10,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            GridView.count(
              crossAxisCount: 2,
              childAspectRatio: 1.35,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              children: <Widget>[
                _Cell(
                  'Local IP',
                  interface?.address ?? 'Unavailable',
                  interface?.name ?? 'No LAN interface',
                  interface != null,
                ),
                _Cell(
                  'Broadcast',
                  interface?.broadcast ?? 'Unavailable',
                  interface == null ? '—' : '/${interface.prefixLength}',
                  interface != null,
                ),
                _Cell(
                  'Control',
                  '${c.settings.controlPort}',
                  'WebSocket · ${c.control.status}',
                  c.control.status == 'running',
                ),
                _Cell(
                  'Transfer',
                  '${c.actualTransferPort}',
                  c.actualTransferPort == c.settings.transferPort
                      ? 'HTTP · ${c.transferManager.status}'
                      : 'Fallback from ${c.settings.transferPort}',
                  c.transferManager.status == 'running',
                ),
                _Cell(
                  'Discovery',
                  '${c.settings.discoveryPort}',
                  'UDP · ${c.udp.status}',
                  c.udp.status == 'running',
                ),
                _Cell(
                  'mDNS',
                  c.mdns.status,
                  '_lanvia._tcp',
                  c.mdns.status == 'running',
                ),
                _Cell(
                  'Connections',
                  '${c.control.connectionCount}',
                  'WebSocket peers',
                  true,
                ),
                _Cell(
                  'Devices',
                  '${c.devices.where((value) => value.status != 'offline').length}',
                  'Currently visible',
                  true,
                ),
              ],
            ),
            for (final error in <String?>[
              c.control.error,
              c.transferManager.error,
              c.udp.error,
              c.mdns.error,
            ].whereType<String>())
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: ListTile(
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                  tileColor: const Color(0x18F59E0B),
                  leading: const Icon(
                    Icons.warning_amber_rounded,
                    color: Color(0xFFFCD34D),
                  ),
                  title: Text(error, style: const TextStyle(fontSize: 11)),
                ),
              ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: c.logs.join('\n')));
                if (context.mounted)
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Diagnostic logs copied')),
                  );
              },
              icon: const Icon(Icons.copy_all_outlined),
              label: const Text('Copy diagnostic logs'),
            ),
            const SizedBox(height: 20),
            const Text(
              'Hotspot troubleshooting',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            const Text(
              'If no device appears, compare the local IPs, verify both devices are on the same hotspot, try Connect manually, and allow LANVIA on Private networks in Windows Firewall. Never disable the firewall.',
              style: TextStyle(
                color: Color(0xFFA8A0B8),
                height: 1.5,
                fontSize: 11,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Cell extends StatelessWidget {
  const _Cell(this.label, this.value, this.detail, this.ok);
  final String label;
  final String value;
  final String detail;
  final bool ok;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: const Color(0xFF181126),
      borderRadius: BorderRadius.circular(13),
      border: Border.all(color: const Color(0x12FFFFFF)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label.toUpperCase(),
          style: const TextStyle(
            color: Color(0xFF81788E),
            fontSize: 8,
            letterSpacing: .7,
          ),
        ),
        const Spacer(),
        Row(
          children: <Widget>[
            Flexible(
              child: Text(
                value,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 13,
                ),
              ),
            ),
            const SizedBox(width: 4),
            Icon(
              ok ? Icons.check_circle : Icons.cancel,
              size: 14,
              color: ok ? const Color(0xFF22C55E) : const Color(0xFFEF4444),
            ),
          ],
        ),
        const SizedBox(height: 3),
        Text(
          detail,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(color: Color(0xFFA8A0B8), fontSize: 9),
        ),
      ],
    ),
  );
}
