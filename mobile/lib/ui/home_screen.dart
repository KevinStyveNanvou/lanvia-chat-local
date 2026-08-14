import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../devices/models/device.dart';
import '../devices/providers/lanvia_controller.dart';
import 'conversation_screen.dart';
import 'diagnostics_screen.dart';
import 'settings_screen.dart';
import 'widgets/device_avatar.dart';
import 'widgets/status_dot.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final controller = context.watch<LanviaController>();
    final known = controller.devices
        .map((value) => value.identity.deviceId)
        .toSet();
    final offline = controller.trustedDevices
        .where((value) => !known.contains(value.deviceId))
        .toList();
    return Scaffold(
      appBar: AppBar(
        title: const Row(
          children: <Widget>[
            LanviaLogo(),
            SizedBox(width: 11),
            Text(
              'LANVIA',
              style: TextStyle(
                fontWeight: FontWeight.w800,
                letterSpacing: 2,
                fontSize: 17,
              ),
            ),
          ],
        ),
        actions: <Widget>[
          IconButton(
            tooltip: 'Network diagnostics',
            icon: const Icon(Icons.monitor_heart_outlined),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute<void>(
                builder: (_) => const DiagnosticsScreen(),
              ),
            ),
          ),
          IconButton(
            tooltip: 'Settings',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute<void>(builder: (_) => const SettingsScreen()),
            ),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: controller.refresh,
        color: const Color(0xFF8B5CF6),
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: <Widget>[
            SliverToBoxAdapter(child: _SelfCard(controller: controller)),
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(18, 10, 18, 8),
              sliver: SliverToBoxAdapter(
                child: Row(
                  children: <Widget>[
                    const Text(
                      'DEVICES',
                      style: TextStyle(
                        color: Color(0xFF81798F),
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1,
                        fontSize: 11,
                      ),
                    ),
                    const Spacer(),
                    Text(
                      '${controller.devices.where((value) => value.status != 'offline').length} available',
                      style: const TextStyle(
                        color: Color(0xFF81798F),
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (controller.devices.isEmpty && offline.isEmpty)
              SliverFillRemaining(
                hasScrollBody: false,
                child: _Empty(
                  onRefresh: controller.refresh,
                  onManual: () => _manual(context, controller),
                ),
              )
            else
              SliverPadding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                sliver: SliverList.builder(
                  itemCount: controller.devices.length + offline.length,
                  itemBuilder: (context, index) {
                    if (index < controller.devices.length)
                      return _DeviceTile(
                        device: controller.devices[index],
                        onTap: () => _open(
                          context,
                          controller.devices[index].identity.deviceId,
                        ),
                      );
                    final trusted = offline[index - controller.devices.length];
                    return _OfflineTile(
                      device: trusted,
                      onTap: () => _open(context, trusted.deviceId),
                    );
                  },
                ),
              ),
            if (controller.devices.isNotEmpty || offline.isNotEmpty)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 30),
                  child: OutlinedButton.icon(
                    onPressed: () => _manual(context, controller),
                    icon: const Icon(Icons.add_link_rounded),
                    label: const Text('Connect manually'),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  void _open(BuildContext context, String id) {
    Navigator.push(
      context,
      MaterialPageRoute<void>(builder: (_) => ConversationScreen(peerId: id)),
    );
  }

  Future<void> _manual(
    BuildContext context,
    LanviaController controller,
  ) async {
    final host = TextEditingController();
    final port = TextEditingController(
      text: '${controller.settings.controlPort}',
    );
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.fromLTRB(
          22,
          8,
          22,
          MediaQuery.viewInsetsOf(sheetContext).bottom + 24,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            const Icon(
              Icons.add_link_rounded,
              size: 34,
              color: Color(0xFFA78BFA),
            ),
            const SizedBox(height: 12),
            const Text(
              'Connect manually',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 5),
            const Text(
              'Use this if the hotspot blocks mDNS or UDP broadcast.',
              style: TextStyle(color: Color(0xFFA8A0B8), fontSize: 12),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            TextField(
              controller: host,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                labelText: 'IP address',
                hintText: '192.168.43.120',
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: port,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Control port'),
            ),
            const SizedBox(height: 18),
            FilledButton(
              onPressed: () async {
                try {
                  await controller.connectManual(
                    host.text,
                    int.tryParse(port.text) ?? 0,
                  );
                  if (sheetContext.mounted) Navigator.pop(sheetContext);
                } on Object catch (error) {
                  if (sheetContext.mounted)
                    ScaffoldMessenger.of(sheetContext)
                        .showSnackBar(SnackBar(content: Text('$error')));
                }
              },
              child: const Text('Connect'),
            ),
          ],
        ),
      ),
    );
    host.dispose();
    port.dispose();
  }
}

class LanviaLogo extends StatelessWidget {
  const LanviaLogo({super.key});
  @override
  Widget build(BuildContext context) => Container(
    width: 35,
    height: 35,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(11),
      gradient: const LinearGradient(
        colors: <Color>[Color(0xFF7C3AED), Color(0xFF3B0764)],
      ),
    ),
    child: const Text(
      'L',
      style: TextStyle(fontWeight: FontWeight.w900, color: Colors.white),
    ),
  );
}

class _SelfCard extends StatelessWidget {
  const _SelfCard({required this.controller});
  final LanviaController controller;
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.fromLTRB(16, 16, 16, 5),
    padding: const EdgeInsets.all(15),
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(17),
      gradient: const LinearGradient(
        colors: <Color>[Color(0x292B1055), Color(0x18181126)],
      ),
      border: Border.all(color: const Color(0x227C3AED)),
    ),
    child: Row(
      children: <Widget>[
        const DeviceAvatar(mobile: true),
        const SizedBox(width: 13),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                controller.identity.deviceName,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 5),
              Row(
                children: <Widget>[
                  StatusDot(
                    controller.control.status == 'running'
                        ? 'connected'
                        : 'failed',
                  ),
                  const SizedBox(width: 6),
                  Text(
                    controller.control.status == 'running'
                        ? 'Ready on LAN'
                        : 'Network service issue',
                    style: const TextStyle(
                      color: Color(0xFFA8A0B8),
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        Text(
          controller.interfaces.isEmpty
              ? 'No IP'
              : controller.interfaces.first.address,
          style: const TextStyle(color: Color(0xFFA78BFA), fontSize: 10),
        ),
      ],
    ),
  );
}

class _DeviceTile extends StatelessWidget {
  const _DeviceTile({required this.device, required this.onTap});
  final DiscoveredDevice device;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
    child: ListTile(
      onTap: onTap,
      contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 5),
      leading: DeviceAvatar(mobile: device.identity.deviceType == 'mobile'),
      title: Text(
        device.identity.deviceName,
        style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
      ),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 5),
        child: Row(
          children: <Widget>[
            StatusDot(device.status),
            const SizedBox(width: 6),
            Text(
              '${device.status} · ${device.identity.platform}',
              style: const TextStyle(fontSize: 11),
            ),
          ],
        ),
      ),
      trailing: device.blocked
          ? const Icon(Icons.block, color: Color(0xFFEF4444), size: 18)
          : device.trusted
          ? const Icon(
              Icons.verified_user_outlined,
              color: Color(0xFF22C55E),
              size: 18,
            )
          : const Icon(Icons.chevron_right_rounded),
    ),
  );
}

class _OfflineTile extends StatelessWidget {
  const _OfflineTile({required this.device, required this.onTap});
  final TrustedDevice device;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
    child: ListTile(
      onTap: onTap,
      leading: DeviceAvatar(mobile: device.platform == 'android'),
      title: Text(device.lastName),
      subtitle: const Row(
        children: <Widget>[
          StatusDot('offline'),
          SizedBox(width: 6),
          Text('Offline', style: TextStyle(fontSize: 11)),
        ],
      ),
      trailing: const Icon(
        Icons.verified_user_outlined,
        color: Color(0xFF22C55E),
        size: 18,
      ),
    ),
  );
}

class _Empty extends StatelessWidget {
  const _Empty({required this.onRefresh, required this.onManual});
  final Future<void> Function() onRefresh;
  final VoidCallback onManual;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 78,
            height: 78,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              color: Color(0x225B21B6),
            ),
            child: const Icon(
              Icons.wifi_find_rounded,
              color: Color(0xFFA78BFA),
              size: 34,
            ),
          ),
          const SizedBox(height: 20),
          const Text(
            'No devices found',
            style: TextStyle(fontWeight: FontWeight.w700, fontSize: 19),
          ),
          const SizedBox(height: 8),
          const Text(
            'Make sure both devices are connected to the same Wi-Fi network.',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Color(0xFFA8A0B8),
              fontSize: 12,
              height: 1.5,
            ),
          ),
          const SizedBox(height: 20),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              OutlinedButton.icon(
                onPressed: () => onRefresh(),
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('Refresh'),
              ),
              const SizedBox(width: 9),
              FilledButton.icon(
                onPressed: onManual,
                icon: const Icon(Icons.add_link_rounded),
                label: const Text('Connect manually'),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}
