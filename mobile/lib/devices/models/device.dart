import '../../core/constants/protocol_generated.dart';

class DeviceIdentity {
  const DeviceIdentity({
    required this.deviceId,
    required this.deviceName,
    required this.deviceType,
    required this.platform,
    required this.appVersion,
    required this.protocolVersion,
  });

  final String deviceId;
  final String deviceName;
  final String deviceType;
  final String platform;
  final String appVersion;
  final String protocolVersion;

  Map<String, Object?> toJson() => <String, Object?>{
    'deviceId': deviceId,
    'deviceName': deviceName,
    'deviceType': deviceType,
    'platform': platform,
    'appVersion': appVersion,
    'protocolVersion': protocolVersion,
  };

  static DeviceIdentity? tryParse(Object? value) {
    if (value is! Map<Object?, Object?>) return null;
    final map = Map<String, Object?>.from(value);
    final id = map['deviceId'];
    final name = map['deviceName'];
    final type = map['deviceType'];
    final platform = map['platform'];
    final appVersion = map['appVersion'];
    final protocol = map['protocolVersion'];
    if (id is! String ||
        id.length < 8 ||
        name is! String ||
        name.trim().isEmpty ||
        name.length > 80 ||
        (type != 'desktop' && type != 'mobile') ||
        !<String>{'windows', 'macos', 'linux', 'android'}.contains(platform) ||
        appVersion is! String ||
        protocol != '${LanviaProtocol.version}')
      return null;
    return DeviceIdentity(
      deviceId: id,
      deviceName: name,
      deviceType: type as String,
      platform: platform! as String,
      appVersion: appVersion,
      protocolVersion: '${LanviaProtocol.version}',
    );
  }
}

class DiscoveredDevice {
  const DiscoveredDevice({
    required this.identity,
    required this.address,
    required this.controlPort,
    required this.transferPort,
    required this.status,
    required this.trusted,
    required this.blocked,
    required this.methods,
    required this.lastSeenAt,
  });
  final DeviceIdentity identity;
  final String address;
  final int controlPort;
  final int transferPort;
  final String status;
  final bool trusted;
  final bool blocked;
  final Set<String> methods;
  final DateTime lastSeenAt;

  DiscoveredDevice copyWith({
    String? address,
    int? controlPort,
    int? transferPort,
    String? status,
    bool? trusted,
    bool? blocked,
    Set<String>? methods,
    DateTime? lastSeenAt,
    DeviceIdentity? identity,
  }) => DiscoveredDevice(
    identity: identity ?? this.identity,
    address: address ?? this.address,
    controlPort: controlPort ?? this.controlPort,
    transferPort: transferPort ?? this.transferPort,
    status: status ?? this.status,
    trusted: trusted ?? this.trusted,
    blocked: blocked ?? this.blocked,
    methods: methods ?? this.methods,
    lastSeenAt: lastSeenAt ?? this.lastSeenAt,
  );
}

class TrustedDevice {
  const TrustedDevice({
    required this.deviceId,
    required this.lastName,
    required this.platform,
    required this.sharedToken,
    required this.blocked,
    required this.pairedAt,
    required this.lastSeenAt,
  });
  final String deviceId;
  final String lastName;
  final String platform;
  final String sharedToken;
  final bool blocked;
  final int pairedAt;
  final int lastSeenAt;
}
