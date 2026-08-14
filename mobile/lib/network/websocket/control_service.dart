import 'dart:async';
import 'dart:io';

import 'package:uuid/uuid.dart';

import '../../core/constants/protocol_generated.dart';
import '../../devices/models/device.dart';
import '../../settings/settings_model.dart';
import '../protocol/envelope.dart';

class ControlEvent {
  const ControlEvent({
    required this.kind,
    this.peerId,
    this.envelope,
    this.device,
    this.error,
  });
  final String kind;
  final String? peerId;
  final Envelope? envelope;
  final DiscoveredDevice? device;
  final String? error;
}

class _Connection {
  _Connection({
    required this.socket,
    required this.address,
    required this.isClient,
    required this.nonce,
    this.peerId,
    required this.controlPort,
  });
  final WebSocket socket;
  final String address;
  final bool isClient;
  String nonce;
  String? peerId;
  DeviceIdentity? identity;
  int controlPort;
  int transferPort = 0;
  String? initiatorId;
  bool authorized = false;
  bool tokenHelloSent = false;
  Timer? handshakeTimer;
  DateTime lastPong = DateTime.now();
  DateTime rateWindowStartedAt = DateTime.now();
  int rateCount = 0;
}

class ControlService {
  ControlService({
    required DeviceIdentity Function() identity,
    required LanviaSettings Function() settings,
    required TrustedDevice? Function(String) trusted,
    required void Function(DiscoveredDevice) onDevice,
  }) : _identity = identity,
       _settings = settings,
       _trusted = trusted,
       _onDevice = onDevice;
  final DeviceIdentity Function() _identity;
  final LanviaSettings Function() _settings;
  final TrustedDevice? Function(String) _trusted;
  final void Function(DiscoveredDevice) _onDevice;
  final StreamController<ControlEvent> _events =
      StreamController<ControlEvent>.broadcast();
  final Map<String, _Connection> _connections = <String, _Connection>{};
  final Set<_Connection> _all = <_Connection>{};
  final Map<String, DiscoveredDevice> _known = <String, DiscoveredDevice>{};
  final Map<String, int> _attempts = <String, int>{};
  final Map<String, Timer> _reconnect = <String, Timer>{};
  HttpServer? _server;
  Timer? _pingTimer;
  bool _stopping = false;
  String status = 'stopped';
  String? error;
  Stream<ControlEvent> get events => _events.stream;
  int get connectionCount => _connections.length;
  bool isConnected(String id) =>
      _connections[id]?.socket.readyState == WebSocket.open;
  bool isAuthorized(String id) => _connections[id]?.authorized ?? false;
  String? peerAddress(String id) =>
      _connections[id]?.address ?? _known[id]?.address;

  Future<void> start() async {
    if (_server != null) return;
    _stopping = false;
    status = 'starting';
    error = null;
    try {
      _server = await HttpServer.bind(
        InternetAddress.anyIPv4,
        _settings().controlPort,
        shared: false,
      );
      status = 'running';
      _server!.listen(
        (request) async {
          if (request.uri.path != LanviaProtocol.controlPath ||
              !WebSocketTransformer.isUpgradeRequest(request)) {
            request.response.statusCode = HttpStatus.notFound;
            await request.response.close();
            return;
          }
          try {
            final socket = await WebSocketTransformer.upgrade(request);
            _attach(
              socket,
              request.connectionInfo?.remoteAddress.address ?? '',
              false,
              null,
              _settings().controlPort,
            );
          } on WebSocketException {
            request.response.statusCode = HttpStatus.badRequest;
            await request.response.close();
          }
        },
        onError: (Object value) {
          status = 'error';
          error = '$value';
          _events.add(ControlEvent(kind: 'status', error: error));
        },
      );
      _pingTimer = Timer.periodic(
        Duration(milliseconds: LanviaProtocol.intervalsMs['ping']!),
        (_) => _pingAll(),
      );
    } on SocketException catch (exception) {
      status = 'error';
      error =
          'Control port ${_settings().controlPort} unavailable: ${exception.message}';
      rethrow;
    }
  }

  Future<String> connectDevice(DiscoveredDevice device) async {
    _known[device.identity.deviceId] = device;
    if (isConnected(device.identity.deviceId)) return device.identity.deviceId;
    return connect(
      device.address,
      device.controlPort,
      expectedPeerId: device.identity.deviceId,
    );
  }

  Future<String> connect(
    String host,
    int port, {
    String? expectedPeerId,
  }) async {
    if (expectedPeerId != null && isConnected(expectedPeerId))
      return expectedPeerId;
    final uriHost = host.contains(':') && !host.startsWith('[')
        ? '[$host]'
        : host;
    final socket =
        await WebSocket.connect(
          'ws://$uriHost:$port${LanviaProtocol.controlPath}',
        ).timeout(
          Duration(
            milliseconds: LanviaProtocol.timeoutsMs['webSocketConnect']!,
          ),
        );
    final connection = _attach(socket, host, true, expectedPeerId, port);
    final completer = Completer<String>();
    late StreamSubscription<ControlEvent> subscription;
    subscription = events.listen((event) {
      if (event.kind == 'connected' &&
          (expectedPeerId == null || event.peerId == expectedPeerId) &&
          !completer.isCompleted) {
        completer.complete(event.peerId);
        unawaited(subscription.cancel());
      }
    });
    _sendHello(connection);
    return completer.future.timeout(
      Duration(milliseconds: LanviaProtocol.timeoutsMs['webSocketHandshake']!),
      onTimeout: () {
        unawaited(subscription.cancel());
        socket.close(1002, 'Hello timeout');
        throw TimeoutException('WebSocket hello timed out');
      },
    );
  }

  String send(String peerId, String type, Map<String, Object?> payload) {
    final connection = _connections[peerId];
    if (connection == null || connection.socket.readyState != WebSocket.open)
      throw const SocketException('Device offline');
    const preAuth = <String>{
      'device_hello',
      'device_info',
      'pair_request',
      'pair_accept',
      'pair_reject',
      'ping',
      'pong',
    };
    if (!connection.authorized && !preAuth.contains(type))
      throw StateError('Device is not paired');
    final envelope = Envelope.create(
      type: type,
      senderId: _identity().deviceId,
      receiverId: peerId,
      payload: payload,
    );
    connection.socket.add(envelope.encode());
    return envelope.requestId;
  }

  void markAuthorized(String peerId, bool value) {
    final connection = _connections[peerId];
    if (connection != null) connection.authorized = value;
  }

  void disconnect(String peerId) {
    unawaited(_connections[peerId]?.socket.close(1000, 'Disconnected locally'));
  }

  void networkChanged() {
    for (final timer in _reconnect.values) {
      timer.cancel();
    }
    _reconnect.clear();
    _attempts.clear();
    for (final connection in _all) {
      unawaited(connection.socket.close(4002, 'Network changed'));
    }
  }

  _Connection _attach(
    WebSocket socket,
    String address,
    bool client,
    String? peerId,
    int port,
  ) {
    final connection = _Connection(
      socket: socket,
      address: address,
      isClient: client,
      nonce: const Uuid().v4(),
      peerId: peerId,
      controlPort: port,
    )..initiatorId = client ? _identity().deviceId : null;
    _all.add(connection);
    connection.handshakeTimer = Timer(
      Duration(milliseconds: LanviaProtocol.timeoutsMs['webSocketHandshake']!),
      () {
        if (connection.identity == null)
          unawaited(socket.close(1002, 'Hello required'));
      },
    );
    socket.listen(
      (Object? raw) => _onMessage(connection, raw),
      onDone: () => _onDone(connection),
      onError: (Object value) => _events.add(
        ControlEvent(kind: 'error', peerId: connection.peerId, error: '$value'),
      ),
      cancelOnError: false,
    );
    return connection;
  }

  void _sendHello(_Connection connection) {
    final trust = connection.peerId == null
        ? null
        : _trusted(connection.peerId!);
    final payload = <String, Object?>{
      'identity': _identity().toJson(),
      'controlPort': _settings().controlPort,
      'transferPort': _settings().transferPort,
      'connectionNonce': connection.nonce,
    };
    if (trust != null && !trust.blocked) {
      payload['trustToken'] = trust.sharedToken;
      connection.tokenHelloSent = true;
    }
    connection.socket.add(
      Envelope.create(
        type: 'device_hello',
        senderId: _identity().deviceId,
        receiverId: connection.peerId ?? 'unknown-peer',
        payload: payload,
      ).encode(),
    );
  }

  void _onMessage(_Connection connection, Object? raw) {
    final now = DateTime.now();
    if (now.difference(connection.rateWindowStartedAt).inSeconds >= 60) {
      connection.rateWindowStartedAt = now;
      connection.rateCount = 0;
    }
    connection.rateCount++;
    if (connection.rateCount > LanviaProtocol.limits['requestsPerMinute']!) {
      unawaited(connection.socket.close(1008, 'Rate limit exceeded'));
      return;
    }
    final envelope = Envelope.tryParse(raw);
    if (envelope == null) {
      unawaited(connection.socket.close(1002, 'Invalid envelope'));
      return;
    }
    if (envelope.receiverId != _identity().deviceId &&
        envelope.receiverId != 'unknown-peer') {
      unawaited(connection.socket.close(1008, 'Wrong receiver'));
      return;
    }
    if (connection.peerId != null && envelope.senderId != connection.peerId) {
      unawaited(connection.socket.close(1008, 'Sender changed'));
      return;
    }
    if (envelope.type == 'device_hello') {
      _handleHello(connection, envelope);
      return;
    }
    if (envelope.type == 'device_info') {
      _handleInfo(connection, envelope);
      return;
    }
    if (connection.identity == null || connection.peerId == null) {
      unawaited(connection.socket.close(1002, 'Hello required'));
      return;
    }
    const preAuth = <String>{
      'pair_request',
      'pair_accept',
      'pair_reject',
      'ping',
      'pong',
    };
    if (!connection.authorized && !preAuth.contains(envelope.type)) return;
    if (envelope.type == 'ping') {
      send(connection.peerId!, 'pong', <String, Object?>{
        'nonce': envelope.payload['nonce'],
      });
      return;
    }
    if (envelope.type == 'pong') {
      connection.lastPong = DateTime.now();
      return;
    }
    _events.add(
      ControlEvent(
        kind: 'envelope',
        peerId: connection.peerId,
        envelope: envelope,
      ),
    );
  }

  void _handleHello(_Connection connection, Envelope envelope) {
    final identity = DeviceIdentity.tryParse(envelope.payload['identity']);
    final control = envelope.payload['controlPort'];
    final transfer = envelope.payload['transferPort'];
    final nonce = envelope.payload['connectionNonce'];
    if (identity == null ||
        identity.deviceId != envelope.senderId ||
        control is! int ||
        transfer is! int ||
        nonce is! String ||
        !_validPort(control) ||
        !_validPort(transfer)) {
      unawaited(connection.socket.close(1002, 'Invalid hello'));
      return;
    }
    if (identity.deviceId == _identity().deviceId) {
      unawaited(connection.socket.close(1008, 'Self identity'));
      return;
    }
    final trust = _trusted(identity.deviceId);
    if (trust?.blocked ?? false) {
      unawaited(connection.socket.close(1008, 'Blocked'));
      return;
    }
    connection.peerId = identity.deviceId;
    connection.identity = identity;
    connection.controlPort = control;
    connection.transferPort = transfer;
    connection.nonce = nonce;
    connection.initiatorId = identity.deviceId;
    connection.authorized =
        trust != null && envelope.payload['trustToken'] == trust.sharedToken;
    connection.handshakeTimer?.cancel();
    _register(connection);
    _publishDevice(connection);
    connection.socket.add(
      Envelope.create(
        type: 'device_info',
        requestId: envelope.requestId,
        senderId: _identity().deviceId,
        receiverId: identity.deviceId,
        payload: <String, Object?>{
          'identity': _identity().toJson(),
          'controlPort': _settings().controlPort,
          'transferPort': _settings().transferPort,
          'connectionNonce': nonce,
          'trusted': connection.authorized,
        },
      ).encode(),
    );
  }

  void _handleInfo(_Connection connection, Envelope envelope) {
    final identity = DeviceIdentity.tryParse(envelope.payload['identity']);
    final control = envelope.payload['controlPort'];
    final transfer = envelope.payload['transferPort'];
    if (identity == null ||
        identity.deviceId != envelope.senderId ||
        control is! int ||
        transfer is! int ||
        !_validPort(control) ||
        !_validPort(transfer)) {
      unawaited(connection.socket.close(1002, 'Invalid device info'));
      return;
    }
    if (identity.deviceId == _identity().deviceId) {
      unawaited(connection.socket.close(1008, 'Self identity'));
      return;
    }
    final trust = _trusted(identity.deviceId);
    if (trust?.blocked ?? false) {
      unawaited(connection.socket.close(1008, 'Blocked'));
      return;
    }
    connection.peerId = identity.deviceId;
    connection.identity = identity;
    connection.controlPort = control;
    connection.transferPort = transfer;
    connection.authorized =
        trust != null && envelope.payload['trusted'] == true;
    connection.handshakeTimer?.cancel();
    _register(connection);
    _publishDevice(connection);
    if (trust != null && !connection.authorized && !connection.tokenHelloSent)
      _sendHello(connection);
  }

  void _register(_Connection connection) {
    final peerId = connection.peerId!;
    final old = _connections[peerId];
    if (old != null &&
        old != connection &&
        old.socket.readyState == WebSocket.open) {
      final oldKey = '${old.initiatorId}:${old.nonce}';
      final newKey = '${connection.initiatorId}:${connection.nonce}';
      if (oldKey.compareTo(newKey) <= 0) {
        unawaited(connection.socket.close(4001, 'Duplicate'));
        return;
      }
      unawaited(old.socket.close(4001, 'Duplicate'));
    }
    _connections[peerId] = connection;
    _attempts.remove(peerId);
    _reconnect.remove(peerId)?.cancel();
    _events.add(ControlEvent(kind: 'connected', peerId: peerId));
  }

  void _publishDevice(_Connection connection) {
    final identity = connection.identity!;
    final prior = _known[identity.deviceId];
    final device = DiscoveredDevice(
      identity: identity,
      address: connection.address,
      controlPort: connection.controlPort,
      transferPort: connection.transferPort,
      status: 'connected',
      trusted: connection.authorized || _trusted(identity.deviceId) != null,
      blocked: false,
      methods: <String>{...prior?.methods ?? <String>{}, 'manual'},
      lastSeenAt: DateTime.now(),
    );
    _known[identity.deviceId] = device;
    _onDevice(device);
  }

  void _onDone(_Connection connection) {
    connection.handshakeTimer?.cancel();
    _all.remove(connection);
    final peerId = connection.peerId;
    if (peerId == null) return;
    if (_connections[peerId] == connection) {
      _connections.remove(peerId);
      _events.add(ControlEvent(kind: 'disconnected', peerId: peerId));
      if (!_stopping) _scheduleReconnect(peerId);
    }
  }

  void _scheduleReconnect(String peerId) {
    if (_reconnect.containsKey(peerId)) return;
    final device = _known[peerId];
    if (device == null || device.blocked) return;
    final attempt = _attempts[peerId] ?? 0;
    final delays = LanviaProtocol.reconnectBackoffMs;
    final delay = delays[attempt.clamp(0, delays.length - 1)];
    _attempts[peerId] = attempt + 1;
    _reconnect[peerId] = Timer(Duration(milliseconds: delay), () {
      _reconnect.remove(peerId);
      if (!isConnected(peerId)) {
        connectDevice(device).catchError((Object _) {
          _scheduleReconnect(peerId);
          return peerId;
        });
      }
    });
  }

  void _pingAll() {
    final now = DateTime.now();
    for (final entry in _connections.entries) {
      if (now.difference(entry.value.lastPong).inMilliseconds >
          LanviaProtocol.intervalsMs['ping']! +
              LanviaProtocol.timeoutsMs['pong']!) {
        unawaited(entry.value.socket.close(1001, 'Pong timeout'));
      } else {
        try {
          send(entry.key, 'ping', <String, Object?>{
            'nonce': const Uuid().v4(),
          });
        } on StateError catch (exception) {
          _events.add(
            ControlEvent(
              kind: 'error',
              peerId: entry.key,
              error: 'Ping failed: $exception',
            ),
          );
        }
      }
    }
  }

  bool _validPort(int port) => port > 0 && port <= 65535;
  Future<void> stop() async {
    _stopping = true;
    _pingTimer?.cancel();
    for (final timer in _reconnect.values) {
      timer.cancel();
    }
    _reconnect.clear();
    for (final connection in _all.toList()) {
      await connection.socket.close(1000, 'Stopping');
    }
    _all.clear();
    _connections.clear();
    await _server?.close(force: true);
    _server = null;
    status = 'stopped';
  }

  Future<void> dispose() async {
    await stop();
    await _events.close();
  }
}
