import 'dart:convert';

import '../core/constants/protocol_generated.dart';
import '../devices/models/device.dart';

class DiscoveryPacket {
  const DiscoveryPacket({
    required this.identity,
    required this.controlPort,
    required this.transferPort,
    required this.timestamp,
  });
  final DeviceIdentity identity;
  final int controlPort;
  final int transferPort;
  final int timestamp;

  String encode() => jsonEncode(<String, Object?>{
    'lanvia': true,
    'version': LanviaProtocol.version,
    'type': 'device_hello',
    'identity': identity.toJson(),
    'controlPort': controlPort,
    'transferPort': transferPort,
    'timestamp': timestamp,
  });

  static DiscoveryPacket? tryParse(List<int> bytes) {
    try {
      if (bytes.length > LanviaProtocol.limits['udpPacketBytes']!) return null;
      final Object? decoded = jsonDecode(utf8.decode(bytes));
      if (decoded is! Map<Object?, Object?>) return null;
      final map = Map<String, Object?>.from(decoded);
      final identity = DeviceIdentity.tryParse(map['identity']);
      final control = map['controlPort'];
      final transfer = map['transferPort'];
      final timestamp = map['timestamp'];
      if (map['lanvia'] != true ||
          map['version'] != LanviaProtocol.version ||
          map['type'] != 'device_hello' ||
          identity == null ||
          control is! int ||
          transfer is! int ||
          control < 1 ||
          control > 65535 ||
          transfer < 1 ||
          transfer > 65535 ||
          timestamp is! int)
        return null;
      return DiscoveryPacket(
        identity: identity,
        controlPort: control,
        transferPort: transfer,
        timestamp: timestamp,
      );
    } on FormatException {
      return null;
    }
  }
}
