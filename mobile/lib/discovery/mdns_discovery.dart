import 'dart:async';

import '../devices/models/device.dart';
import '../settings/settings_model.dart';
import 'network_bridge.dart';

class MdnsDiscovery {
  MdnsDiscovery({
    required this.bridge,
    required this.identity,
    required this.settings,
  });
  final NetworkBridge bridge;
  final DeviceIdentity Function() identity;
  final LanviaSettings Function() settings;
  StreamSubscription<MdnsEvent>? _subscription;
  final StreamController<DiscoveredDevice> _devices =
      StreamController<DiscoveredDevice>.broadcast();
  Stream<DiscoveredDevice> get devices => _devices.stream;
  String status = 'stopped';
  String? error;

  Future<void> start() async {
    status = 'starting';
    error = null;
    _subscription ??= bridge.mdnsEvents.listen((event) {
      if (event.device != null &&
          event.device!.identity.deviceId != identity().deviceId)
        _devices.add(event.device!);
      if (event.status != null) status = event.status!;
      if (event.error != null) error = event.error;
    });
    try {
      await bridge.startMdns(identity(), settings());
      status = 'running';
    } on Exception catch (exception) {
      status = 'error';
      error = '$exception';
    }
  }

  Future<void> stop() async {
    await bridge.stopMdns();
    status = 'stopped';
  }

  Future<void> dispose() async {
    await stop();
    await _subscription?.cancel();
    await _devices.close();
  }
}
