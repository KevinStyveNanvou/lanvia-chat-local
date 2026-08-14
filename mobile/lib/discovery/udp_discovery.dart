import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../core/constants/protocol_generated.dart';
import '../devices/models/device.dart';
import '../settings/settings_model.dart';
import 'discovery_packet.dart';
import 'network_bridge.dart';

class UdpDeviceEvent {
  const UdpDeviceEvent(this.packet, this.address);
  final DiscoveryPacket packet;
  final String address;
}

class UdpDiscovery {
  UdpDiscovery({
    required DeviceIdentity Function() identity,
    required LanviaSettings Function() settings,
    required NetworkBridge bridge,
  }) : _identity = identity,
       _settings = settings,
       _bridge = bridge;
  final DeviceIdentity Function() _identity;
  final LanviaSettings Function() _settings;
  final NetworkBridge _bridge;
  final StreamController<UdpDeviceEvent> _devices =
      StreamController<UdpDeviceEvent>.broadcast();
  RawDatagramSocket? _socket;
  Timer? _timer;
  final Map<String, DateTime> _lastReply = <String, DateTime>{};
  Stream<UdpDeviceEvent> get devices => _devices.stream;
  String status = 'stopped';
  String? error;

  Future<void> start() async {
    if (_socket != null) return;
    status = 'starting';
    error = null;
    try {
      final socket = await RawDatagramSocket.bind(
        InternetAddress.anyIPv4,
        _settings().discoveryPort,
        reuseAddress: true,
      );
      _socket = socket;
      socket.broadcastEnabled = true;
      status = 'running';
      socket.listen(
        _onSocket,
        onError: (Object value) {
          status = 'error';
          error = '$value';
        },
      );
      await announce();
      _timer = Timer.periodic(
        Duration(
          milliseconds: LanviaProtocol.intervalsMs['discoveryAnnouncement']!,
        ),
        (_) {
          unawaited(announce());
        },
      );
    } on SocketException catch (exception) {
      status = 'error';
      error = exception.message;
      rethrow;
    }
  }

  Future<void> announce() async {
    final socket = _socket;
    if (socket == null) return;
    final packet = DiscoveryPacket(
      identity: _identity(),
      controlPort: _settings().controlPort,
      transferPort: _settings().transferPort,
      timestamp: DateTime.now().millisecondsSinceEpoch,
    );
    final bytes = utf8.encode(packet.encode());
    final targets = <String>{
      '255.255.255.255',
      ...(await _bridge.interfaces()).map((value) => value.broadcast),
    };
    for (final target in targets) {
      try {
        socket.send(bytes, InternetAddress(target), _settings().discoveryPort);
      } on SocketException {
        /* another interface may have disappeared */
      }
    }
  }

  void _onSocket(RawSocketEvent event) {
    if (event != RawSocketEvent.read) return;
    Datagram? datagram;
    while ((datagram = _socket?.receive()) != null) {
      final value = datagram!;
      final packet = DiscoveryPacket.tryParse(value.data);
      if (packet == null || packet.identity.deviceId == _identity().deviceId)
        continue;
      _devices.add(UdpDeviceEvent(packet, value.address.address));
      final now = DateTime.now();
      final last = _lastReply[packet.identity.deviceId];
      if (last == null ||
          now.difference(last).inMilliseconds >=
              LanviaProtocol.intervalsMs['discoveryAnnouncement']!) {
        _lastReply[packet.identity.deviceId] = now;
        final own = DiscoveryPacket(
          identity: _identity(),
          controlPort: _settings().controlPort,
          transferPort: _settings().transferPort,
          timestamp: now.millisecondsSinceEpoch,
        );
        _socket?.send(
          utf8.encode(own.encode()),
          value.address,
          _settings().discoveryPort,
        );
      }
    }
  }

  Future<void> stop() async {
    _timer?.cancel();
    _timer = null;
    _socket?.close();
    _socket = null;
    status = 'stopped';
    _lastReply.clear();
  }

  Future<void> dispose() async {
    await stop();
    await _devices.close();
  }
}
