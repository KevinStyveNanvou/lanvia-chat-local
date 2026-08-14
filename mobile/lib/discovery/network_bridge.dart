import 'package:flutter/services.dart';

import '../core/constants/protocol_generated.dart';
import '../devices/models/device.dart';
import '../settings/settings_model.dart';

class NetworkInterfaceInfo {
  const NetworkInterfaceInfo({
    required this.name,
    required this.address,
    required this.broadcast,
    required this.prefixLength,
  });
  final String name;
  final String address;
  final String broadcast;
  final int prefixLength;
}

class MdnsEvent {
  const MdnsEvent({this.device, this.status, this.error});
  final DiscoveredDevice? device;
  final String? status;
  final String? error;
}

class NetworkBridge {
  static const MethodChannel _methods = MethodChannel(
    'ai.arena.lanvia/network',
  );
  static const EventChannel _events = EventChannel(
    'ai.arena.lanvia/mdns_events',
  );

  Stream<MdnsEvent> get mdnsEvents =>
      _events.receiveBroadcastStream().map((Object? value) {
        if (value is! Map<Object?, Object?>)
          return const MdnsEvent(
            status: 'error',
            error: 'Invalid native mDNS event',
          );
        final map = Map<String, Object?>.from(value);
        if (map['kind'] == 'status')
          return MdnsEvent(
            status: map['status'] as String?,
            error: map['error'] as String?,
          );
        final id = map['id'];
        final name = map['name'];
        final address = map['address'];
        final control = int.tryParse('${map['control'] ?? map['port']}');
        final transfer = int.tryParse('${map['transfer']}');
        if (id is! String ||
            name is! String ||
            address is! String ||
            control == null ||
            transfer == null ||
            map['protocol'] != '${LanviaProtocol.version}')
          return const MdnsEvent(
            status: 'error',
            error: 'Invalid mDNS device record',
          );
        final identity = DeviceIdentity(
          deviceId: id,
          deviceName: name,
          deviceType: map['type'] == 'mobile' ? 'mobile' : 'desktop',
          platform: map['platform'] as String? ?? 'android',
          appVersion: map['version'] as String? ?? 'unknown',
          protocolVersion: '${LanviaProtocol.version}',
        );
        return MdnsEvent(
          device: DiscoveredDevice(
            identity: identity,
            address: address,
            controlPort: control,
            transferPort: transfer,
            status: 'available',
            trusted: false,
            blocked: false,
            methods: <String>{'mdns'},
            lastSeenAt: DateTime.now(),
          ),
        );
      });

  Future<void> startMdns(DeviceIdentity identity, LanviaSettings settings) =>
      _methods.invokeMethod<void>('startMdns', <String, Object?>{
        ...identity.toJson(),
        'controlPort': settings.controlPort,
        'transferPort': settings.transferPort,
      });
  Future<void> stopMdns() => _methods.invokeMethod<void>('stopMdns');

  Future<List<NetworkInterfaceInfo>> interfaces() async {
    final Object? raw = await _methods.invokeMethod<Object?>(
      'getNetworkInterfaces',
    );
    if (raw is! List) return <NetworkInterfaceInfo>[];
    return raw
        .whereType<Map<Object?, Object?>>()
        .map((value) {
          final map = Map<String, Object?>.from(value);
          return NetworkInterfaceInfo(
            name: map['name'] as String? ?? 'Wi-Fi',
            address: map['address'] as String? ?? '',
            broadcast: map['broadcast'] as String? ?? '255.255.255.255',
            prefixLength: map['prefixLength'] as int? ?? 24,
          );
        })
        .where((value) => value.address.isNotEmpty)
        .toList();
  }

  Future<void> startForeground({required String text, int progress = -1}) =>
      _methods.invokeMethod<void>('startForeground', <String, Object?>{
        'title': 'LANVIA',
        'text': text,
        'progress': progress,
      });
  Future<void> stopForeground() =>
      _methods.invokeMethod<void>('stopForeground');
}
