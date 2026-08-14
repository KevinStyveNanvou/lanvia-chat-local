import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../devices/providers/lanvia_controller.dart';
import '../settings/settings_model.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController name;
  late final TextEditingController control;
  late final TextEditingController transfer;
  late final TextEditingController discovery;
  @override
  void initState() {
    super.initState();
    final c = context.read<LanviaController>();
    name = TextEditingController(text: c.identity.deviceName);
    control = TextEditingController(text: '${c.settings.controlPort}');
    transfer = TextEditingController(text: '${c.settings.transferPort}');
    discovery = TextEditingController(text: '${c.settings.discoveryPort}');
  }

  @override
  void dispose() {
    name.dispose();
    control.dispose();
    transfer.dispose();
    discovery.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<LanviaController>();
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(17),
        children: <Widget>[
          const _Title('Identity'),
          TextField(
            controller: name,
            maxLength: 80,
            decoration: const InputDecoration(
              labelText: 'Device name',
              helperText: 'Visible to LANVIA devices on this network',
            ),
            onSubmitted: (value) => _run(c.rename(value)),
          ),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: () => _run(c.rename(name.text)),
            child: const Text('Save device name'),
          ),
          const _Title('Appearance & notifications'),
          DropdownButtonFormField<String>(
            initialValue: c.settings.theme,
            decoration: const InputDecoration(labelText: 'Theme'),
            items: const <DropdownMenuItem<String>>[
              DropdownMenuItem(value: 'dark', child: Text('Dark')),
              DropdownMenuItem(value: 'light', child: Text('Light')),
              DropdownMenuItem(value: 'system', child: Text('System')),
            ],
            onChanged: (value) {
              if (value != null)
                _run(c.updateSettings(c.settings.copyWith(theme: value)));
            },
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Notifications'),
            subtitle: const Text('Pairing, messages and file requests'),
            value: c.settings.notifications,
            onChanged: (value) => _run(
              c.updateSettings(c.settings.copyWith(notifications: value)),
            ),
          ),
          const ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.folder_outlined),
            title: Text('Download folder'),
            subtitle: Text(
              'App-specific external storage/LANVIA\nNo broad storage permission is requested.',
            ),
          ),
          const _Title('Network ports'),
          const Text(
            'Both clients share the same defaults. Custom local listener ports apply after restarting LANVIA and are advertised to peers.',
            style: TextStyle(
              color: Color(0xFFA8A0B8),
              fontSize: 10,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: <Widget>[
              Expanded(
                child: TextField(
                  controller: control,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Control'),
                ),
              ),
              const SizedBox(width: 7),
              Expanded(
                child: TextField(
                  controller: transfer,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Transfer'),
                ),
              ),
              const SizedBox(width: 7),
              Expanded(
                child: TextField(
                  controller: discovery,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: 'Discovery'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          OutlinedButton(
            onPressed: () {
              final value = LanviaSettings(
                theme: c.settings.theme,
                notifications: c.settings.notifications,
                controlPort: int.tryParse(control.text) ?? 0,
                transferPort: int.tryParse(transfer.text) ?? 0,
                discoveryPort: int.tryParse(discovery.text) ?? 0,
                downloadFolder: c.settings.downloadFolder,
              );
              _run(c.updateSettings(value));
            },
            child: const Text('Save network ports'),
          ),
          const _Title('Trusted devices'),
          if (c.trustedDevices.isEmpty)
            const Text(
              'No trusted devices',
              style: TextStyle(color: Color(0xFFA8A0B8)),
            )
          else
            ...c.trustedDevices.map(
              (device) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(
                  device.platform == 'android'
                      ? Icons.smartphone
                      : Icons.laptop,
                ),
                title: Text(device.lastName),
                subtitle: Text(
                  device.blocked
                      ? 'Blocked'
                      : 'Trusted since ${DateTime.fromMillisecondsSinceEpoch(device.pairedAt).toLocal().toString().split(' ').first}',
                ),
                trailing: PopupMenuButton<String>(
                  onSelected: (action) {
                    if (action == 'block')
                      _run(c.setBlocked(device.deviceId, !device.blocked));
                    if (action == 'remove')
                      _run(c.removeTrusted(device.deviceId));
                  },
                  itemBuilder: (_) => <PopupMenuEntry<String>>[
                    PopupMenuItem(
                      value: 'block',
                      child: Text(device.blocked ? 'Unblock' : 'Block'),
                    ),
                    const PopupMenuItem(value: 'remove', child: Text('Remove')),
                  ],
                ),
              ),
            ),
          const _Title('About'),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.info_outline),
            title: const Text('LANVIA 1.0.1'),
            subtitle: Text(
              'Protocol v${c.identity.protocolVersion}\nYour files. Your network. Nowhere else.',
            ),
          ),
          SelectableText(
            'Device ID: ${c.identity.deviceId}',
            style: const TextStyle(color: Color(0xFFA8A0B8), fontSize: 9),
          ),
        ],
      ),
    );
  }

  Future<void> _run(Future<void> action) async {
    try {
      await action;
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Saved')));
    } on Object catch (error) {
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$error')));
    }
  }
}

class _Title extends StatelessWidget {
  const _Title(this.value);
  final String value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 23, bottom: 10),
    child: Text(
      value.toUpperCase(),
      style: const TextStyle(
        color: Color(0xFFA78BFA),
        letterSpacing: 1,
        fontSize: 10,
        fontWeight: FontWeight.w800,
      ),
    ),
  );
}
