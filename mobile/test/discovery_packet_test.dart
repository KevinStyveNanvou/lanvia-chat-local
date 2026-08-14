import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lanvia_mobile/devices/models/device.dart';
import 'package:lanvia_mobile/discovery/discovery_packet.dart';

void main() {
  const identity = DeviceIdentity(
    deviceId: '123e4567-e89b-12d3-a456-426614174000',
    deviceName: 'Kevin Phone',
    deviceType: 'mobile',
    platform: 'android',
    appVersion: '1.0.0',
    protocolVersion: '1',
  );
  test('discovery packet round-trips exact common fields', () {
    final packet = DiscoveryPacket(
      identity: identity,
      controlPort: 53211,
      transferPort: 53212,
      timestamp: 1786723200000,
    );
    final parsed = DiscoveryPacket.tryParse(utf8.encode(packet.encode()));
    expect(parsed?.identity.deviceId, identity.deviceId);
    expect(parsed?.controlPort, 53211);
    expect(parsed?.transferPort, 53212);
  });
  test('rejects malformed ports and protocol', () {
    final value = jsonDecode(
      DiscoveryPacket(
        identity: identity,
        controlPort: 53211,
        transferPort: 53212,
        timestamp: 1,
      ).encode(),
    ) as Map<String, Object?>;
    value['controlPort'] = 70000;
    expect(DiscoveryPacket.tryParse(utf8.encode(jsonEncode(value))), isNull);
  });
}
