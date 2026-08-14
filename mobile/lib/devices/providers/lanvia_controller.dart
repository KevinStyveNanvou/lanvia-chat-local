import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:open_filex/open_filex.dart';
import 'package:uuid/uuid.dart';

import '../../chat/message.dart';
import '../../core/constants/protocol_generated.dart';
import '../../core/utils/notifications.dart';
import '../../discovery/mdns_discovery.dart';
import '../../discovery/network_bridge.dart';
import '../../discovery/udp_discovery.dart';
import '../../network/protocol/envelope.dart';
import '../../network/websocket/control_service.dart';
import '../../pairing/pairing_prompt.dart';
import '../../settings/settings_model.dart';
import '../../settings/settings_repository.dart';
import '../../storage/database.dart';
import '../../transfers/transfer_manager.dart';
import '../../transfers/transfer_model.dart';
import '../models/device.dart';
import '../repositories/identity_repository.dart';

class LanviaController extends ChangeNotifier {
  LanviaController({required this.notifications});
  final NotificationService notifications;
  final LanviaDatabase database = LanviaDatabase();
  final IdentityRepository identityRepository = IdentityRepository();
  final SettingsRepository settingsRepository = SettingsRepository();
  final NetworkBridge bridge = NetworkBridge();
  late DeviceIdentity identity;
  LanviaSettings settings = LanviaSettings.defaults;
  int _effectiveTransferPort = 0;
  LanviaSettings get networkSettings => settings.copyWith(
    transferPort: _effectiveTransferPort == 0
        ? settings.transferPort
        : _effectiveTransferPort,
  );
  int get actualTransferPort => networkSettings.transferPort;
  final Map<String, DiscoveredDevice> _devices = <String, DiscoveredDevice>{};
  final Map<String, TrustedDevice> _trusted = <String, TrustedDevice>{};
  final Set<String> _connecting = <String>{};
  List<ChatMessage> messages = <ChatMessage>[];
  List<TransferRecord> transfers = <TransferRecord>[];
  final List<PairingPrompt> pendingPairings = <PairingPrompt>[];
  TransferRecord? latestIncomingTransfer;
  final Map<String, ({String peerId, int expiresAt})> _outgoingPairings =
      <String, ({String peerId, int expiresAt})>{};
  final List<String> logs = <String>[];
  late UdpDiscovery udp;
  late MdnsDiscovery mdns;
  late ControlService control;
  late TransferManager transferManager;
  final List<StreamSubscription<Object?>> _subscriptions =
      <StreamSubscription<Object?>>[];
  Timer? _expiry;
  Timer? _networkDebounce;
  List<NetworkInterfaceInfo> interfaces = <NetworkInterfaceInfo>[];
  bool initialized = false;
  String? notice;
  int noticeVersion = 0;

  List<DiscoveredDevice> get devices {
    final values = _devices.values.toList();
    values.sort((a, b) {
      int rank(String value) => value == 'connected'
          ? 0
          : value == 'available'
          ? 1
          : 2;
      return rank(a.status) - rank(b.status) != 0
          ? rank(a.status) - rank(b.status)
          : a.identity.deviceName.compareTo(b.identity.deviceName);
    });
    return values;
  }

  List<TrustedDevice> get trustedDevices => _trusted.values.toList();
  TrustedDevice? trusted(String id) => _trusted[id];
  DiscoveredDevice? device(String id) => _devices[id];

  Future<void> start() async {
    await database.open();
    identity = await identityRepository.load();
    settings = await settingsRepository.load();
    _effectiveTransferPort = settings.transferPort;
    if (settings.notifications) await notifications.requestPermission();
    for (final value in await database.trustedDevices()) {
      _trusted[value.deviceId] = value;
    }
    messages = await database.messages();
    final oldTransfers = await database.transfers();
    udp = UdpDiscovery(
      identity: () => identity,
      settings: () => networkSettings,
      bridge: bridge,
    );
    mdns = MdnsDiscovery(
      bridge: bridge,
      identity: () => identity,
      settings: () => networkSettings,
    );
    control = ControlService(
      identity: () => identity,
      settings: () => networkSettings,
      trusted: trusted,
      onDevice: _mergeDevice,
    );
    transferManager =
        TransferManager(
            settings: () => settings,
            send: (peer, type, payload) => control.send(peer, type, payload),
            peerAddress: control.peerAddress,
            persist: database.saveTransfer,
            bridge: bridge,
            onPortChanged: (port) {
              _effectiveTransferPort = port;
              _log(
                'TRANSFER',
                port == settings.transferPort
                    ? 'HTTP transfer server listening on 0.0.0.0:$port'
                    : 'Port ${settings.transferPort} occupied; transfer server using $port',
              );
            },
          )
          ..setLocalDeviceId(identity.deviceId)
          ..seed(oldTransfers);
    transfers = transferManager.records;
    _subscriptions.add(
      udp.devices.listen((event) {
        if (event.packet.identity.deviceId != identity.deviceId)
          _mergeDevice(
            DiscoveredDevice(
              identity: event.packet.identity,
              address: event.address,
              controlPort: event.packet.controlPort,
              transferPort: event.packet.transferPort,
              status: 'available',
              trusted: false,
              blocked: false,
              methods: <String>{'udp'},
              lastSeenAt: DateTime.now(),
            ),
          );
      }),
    );
    _subscriptions.add(mdns.devices.listen(_mergeDevice));
    _subscriptions.add(control.events.listen(_onControl));
    _subscriptions.add(
      transferManager.events.listen((event) {
        transfers = transferManager.records;
        if (event.kind == 'incoming') {
          latestIncomingTransfer = event.record;
          final sender =
              _devices[event.record.peerId]?.identity.deviceName ?? 'A device';
          if (settings.notifications)
            unawaited(
              notifications.incomingTransfer(
                notificationId: event.record.transferId.hashCode & 0x7fffffff,
                sender: sender,
                fileName: event.record.fileName,
                transferId: event.record.transferId,
              ),
            );
        }
        notifyListeners();
      }),
    );
    _subscriptions.add(
      Connectivity().onConnectivityChanged.listen((_) {
        _networkDebounce?.cancel();
        _networkDebounce = Timer(const Duration(milliseconds: 700), () {
          unawaited(_networkChanged());
        });
      }),
    );
    notifications.onTransferAction = (action, id) =>
        action == 'accept' ? acceptTransfer(id) : rejectTransfer(id);
    await transferManager.start().catchError((Object error) {
      _log('TRANSFER', '$error');
    });
    await control.start().catchError((Object error) {
      _log('WS', '$error');
    });
    await udp.start().catchError((Object error) {
      _log('DISCOVERY', '$error');
    });
    await mdns.start();
    interfaces = await bridge.interfaces();
    _expiry = Timer.periodic(const Duration(seconds: 1), (_) => _expire());
    initialized = true;
    _log('APP', 'LANVIA ready as ${identity.deviceName}');
    notifyListeners();
  }

  void _mergeDevice(DiscoveredDevice incoming) {
    if (incoming.identity.deviceId == identity.deviceId) return;
    final trust = _trusted[incoming.identity.deviceId];
    final existing = _devices[incoming.identity.deviceId];
    final merged = incoming.copyWith(
      status: existing?.status == 'connected' ? 'connected' : incoming.status,
      trusted: trust != null && !trust.blocked,
      blocked: trust?.blocked ?? false,
      methods: <String>{
        ...existing?.methods ?? <String>{},
        ...incoming.methods,
      },
      lastSeenAt: DateTime.now(),
    );
    _devices[incoming.identity.deviceId] = merged;
    if (existing == null)
      _log(
        'DISCOVERY',
        'Device found: ${incoming.identity.deviceName} at ${incoming.address}:${incoming.controlPort} via ${incoming.methods.join('+')}',
      );
    notifyListeners();
    if (!merged.blocked &&
        identity.deviceId.compareTo(merged.identity.deviceId) < 0 &&
        !control.isConnected(merged.identity.deviceId) &&
        !_connecting.contains(merged.identity.deviceId))
      unawaited(connectDevice(merged.identity.deviceId, quiet: true));
  }

  Future<void> connectDevice(String id, {bool quiet = false}) async {
    if (_connecting.contains(id)) return;
    final value = _devices[id];
    if (value == null) throw StateError('Device is offline');
    if (value.blocked) throw StateError('Device is blocked');
    _connecting.add(id);
    _devices[id] = value.copyWith(status: 'connecting');
    notifyListeners();
    try {
      await control.connectDevice(value);
      _setStatus(id, 'connected');
    } catch (error) {
      _setStatus(id, 'failed');
      if (!quiet) _notice('$error');
      rethrow;
    } finally {
      _connecting.remove(id);
    }
  }

  Future<void> connectManual(String host, int port) async {
    final value = host.trim();
    if (!_isLanHost(value) || port < 1 || port > 65535)
      throw ArgumentError('Enter a valid local IP or LAN hostname and port');
    var target = value;
    if (InternetAddress.tryParse(value) == null) {
      final addresses = await InternetAddress.lookup(value);
      final local = addresses.where((address) => _isLanHost(address.address));
      if (local.isEmpty)
        throw ArgumentError(
          'The hostname does not resolve to a local network address',
        );
      target = local.first.address;
    }
    final id = await control.connect(target, port);
    _setStatus(id, 'connected');
    _notice('Connected to ${_devices[id]?.identity.deviceName ?? id}');
  }

  Future<void> pair(String peerId) async {
    if (!control.isConnected(peerId)) await connectDevice(peerId);
    final pairId = const Uuid().v4();
    final expires =
        DateTime.now().millisecondsSinceEpoch +
        LanviaProtocol.timeoutsMs['pairing']!;
    _outgoingPairings[pairId] = (peerId: peerId, expiresAt: expires);
    _setStatus(peerId, 'pairing');
    control.send(peerId, 'pair_request', <String, Object?>{
      'pairId': pairId,
      'identity': identity.toJson(),
      'expiresAt': expires,
    });
    _notice('Pairing request sent');
  }

  Future<void> respondPairing(String pairId, bool accept) async {
    final index = pendingPairings.indexWhere((value) => value.pairId == pairId);
    if (index < 0) throw StateError('Pairing request expired');
    final prompt = pendingPairings.removeAt(index);
    if (!accept) {
      control.send(prompt.peerId, 'pair_reject', <String, Object?>{
        'pairId': pairId,
        'reason': 'user_rejected',
      });
      _setStatus(prompt.peerId, 'connected');
      return;
    }
    final peer = _devices[prompt.peerId];
    if (peer == null) throw StateError('Device went offline');
    final token = _randomToken();
    final now = DateTime.now().millisecondsSinceEpoch;
    final value = TrustedDevice(
      deviceId: peer.identity.deviceId,
      lastName: peer.identity.deviceName,
      platform: peer.identity.platform,
      sharedToken: token,
      blocked: false,
      pairedAt: now,
      lastSeenAt: now,
    );
    _trusted[value.deviceId] = value;
    await database.saveTrusted(value);
    control.markAuthorized(value.deviceId, true);
    control.send(value.deviceId, 'pair_accept', <String, Object?>{
      'pairId': pairId,
      'trustToken': token,
      'deviceName': identity.deviceName,
    });
    _refreshTrust(value.deviceId);
    _setStatus(value.deviceId, 'connected');
    _notice('${value.lastName} is now trusted');
  }

  Future<void> removeTrusted(String id) async {
    _trusted.remove(id);
    await database.removeTrusted(id);
    control.markAuthorized(id, false);
    control.disconnect(id);
    _refreshTrust(id);
    notifyListeners();
  }

  Future<void> setBlocked(String id, bool blocked) async {
    final old = _trusted[id];
    if (old == null) throw StateError('Device is not trusted');
    final value = TrustedDevice(
      deviceId: old.deviceId,
      lastName: old.lastName,
      platform: old.platform,
      sharedToken: old.sharedToken,
      blocked: blocked,
      pairedAt: old.pairedAt,
      lastSeenAt: old.lastSeenAt,
    );
    _trusted[id] = value;
    await database.saveTrusted(value);
    if (blocked) control.disconnect(id);
    _refreshTrust(id);
    notifyListeners();
  }

  Future<void> sendMessage(String peerId, String text) async {
    final value = text.trim();
    if (value.isEmpty) return;
    if (utf8.encode(value).length > LanviaProtocol.limits['textMessageBytes']!)
      throw ArgumentError('Message exceeds 64 KiB');
    final trust = _trusted[peerId];
    if (trust == null || trust.blocked)
      throw StateError('Pair before sending messages');
    var message = ChatMessage(
      id: const Uuid().v4(),
      conversationId: conversationId(identity.deviceId, peerId),
      senderId: identity.deviceId,
      receiverId: peerId,
      text: value,
      timestamp: DateTime.now().millisecondsSinceEpoch,
      status: 'sending',
    );
    messages.add(message);
    await database.saveMessage(message);
    notifyListeners();
    try {
      control.send(peerId, 'message_send', <String, Object?>{
        ...message.toJson(),
        'status': 'sent',
      });
      message = message.copyWith(status: 'sent');
    } catch (_) {
      message = message.copyWith(status: 'failed');
      rethrow;
    } finally {
      _replaceMessage(message);
      await database.saveMessage(message);
      notifyListeners();
    }
  }

  Future<void> retryMessage(String id) async {
    final message = messages.firstWhere((value) => value.id == id);
    control.send(message.receiverId, 'message_send', <String, Object?>{
      ...message.toJson(),
      'status': 'sent',
    });
    final updated = message.copyWith(status: 'sent');
    _replaceMessage(updated);
    await database.saveMessage(updated);
    notifyListeners();
  }

  Future<void> chooseFiles(String peerId, String category) async {
    if (!control.isAuthorized(peerId))
      throw StateError('Pair and connect before sending files');
    final type = switch (category) {
      'image' => FileType.image,
      'video' => FileType.video,
      'audio' => FileType.audio,
      _ => FileType.any,
    };
    final result = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      type: type,
      withData: false,
    );
    if (result == null) return;
    for (final file in result.files.take(20)) {
      if (file.path != null)
        await transferManager.createOutgoing(peerId, file.path!);
    }
  }

  Future<void> acceptTransfer(String id) => transferManager.accept(id);
  Future<void> rejectTransfer(String id) => transferManager.reject(id);
  Future<void> pauseTransfer(String id) => transferManager.pause(id);
  Future<void> resumeTransfer(String id) => transferManager.resume(id);
  Future<void> cancelTransfer(String id) => transferManager.cancel(id);
  Future<void> openTransfer(String id) async {
    final value = transfers.firstWhere((item) => item.transferId == id);
    if (value.localPath == null || value.state != 'completed')
      throw StateError('File is not available');
    await OpenFilex.open(value.localPath!);
  }

  Future<void> refresh() async {
    await udp.announce();
    _notice('Searching for LANVIA devices…');
    interfaces = await bridge.interfaces();
    notifyListeners();
  }

  Future<void> rename(String name) async {
    identity = await identityRepository.rename(identity, name);
    await mdns.stop();
    await mdns.start();
    notifyListeners();
  }

  Future<void> updateSettings(LanviaSettings value) async {
    for (final port in <int>[
      value.controlPort,
      value.transferPort,
      value.discoveryPort,
    ]) {
      if (port < 1 || port > 65535)
        throw ArgumentError('Ports must be between 1 and 65535');
    }
    if (value.controlPort == value.transferPort)
      throw ArgumentError('Control and transfer TCP ports must be different');
    settings = value;
    await settingsRepository.save(value);
    if (value.notifications) await notifications.requestPermission();
    _notice('Settings saved. Restart LANVIA to apply port changes.');
    notifyListeners();
  }

  bool get hasActiveTransfers => transfers.any(
    (value) =>
        <String>{'accepted', 'transferring', 'verifying'}.contains(value.state),
  );
  Future<void> keepAliveInBackground(bool enabled) => enabled
      ? bridge.startForeground(text: 'Available on your local network')
      : hasActiveTransfers
      ? Future<void>.value()
      : bridge.stopForeground();

  void _onControl(ControlEvent event) {
    if (event.kind == 'connected' && event.peerId != null)
      _setStatus(event.peerId!, 'connected');
    else if (event.kind == 'disconnected' && event.peerId != null)
      _setStatus(event.peerId!, 'available');
    else if (event.kind == 'envelope' &&
        event.peerId != null &&
        event.envelope != null)
      unawaited(_onEnvelope(event.peerId!, event.envelope!));
    else if (event.error != null)
      _log('WS', event.error!);
  }

  Future<void> _onEnvelope(String peerId, Envelope envelope) async {
    try {
      switch (envelope.type) {
        case 'pair_request':
          final id = envelope.payload['pairId'];
          final expires = envelope.payload['expiresAt'];
          if (id is! String ||
              expires is! int ||
              expires < DateTime.now().millisecondsSinceEpoch)
            throw const FormatException('Invalid pair request');
          final peer = _devices[peerId];
          if (peer == null) throw StateError('Unknown peer');
          pendingPairings.removeWhere((value) => value.pairId == id);
          pendingPairings.add(
            PairingPrompt(
              pairId: id,
              peerId: peerId,
              peerName: peer.identity.deviceName,
              expiresAt: expires,
            ),
          );
          _setStatus(peerId, 'pairing');
          _notice('${peer.identity.deviceName} wants to pair');
          break;
        case 'pair_accept':
          final pairId = envelope.payload['pairId'];
          final token = envelope.payload['trustToken'];
          final pending = pairId is String ? _outgoingPairings[pairId] : null;
          if (pending == null ||
              pending.peerId != peerId ||
              token is! String ||
              token.length < 32)
            throw const FormatException('Unexpected pair acceptance');
          final peer = _devices[peerId]!;
          final now = DateTime.now().millisecondsSinceEpoch;
          final trusted = TrustedDevice(
            deviceId: peerId,
            lastName: peer.identity.deviceName,
            platform: peer.identity.platform,
            sharedToken: token,
            blocked: false,
            pairedAt: now,
            lastSeenAt: now,
          );
          _trusted[peerId] = trusted;
          _outgoingPairings.remove(pairId);
          await database.saveTrusted(trusted);
          control.markAuthorized(peerId, true);
          _refreshTrust(peerId);
          _setStatus(peerId, 'connected');
          _notice('${trusted.lastName} is now trusted');
          break;
        case 'pair_reject':
          _outgoingPairings.remove(envelope.payload['pairId']);
          _setStatus(peerId, 'connected');
          _notice('Pairing rejected');
          break;
        case 'message_send':
          final parsed = ChatMessage.tryParse(envelope.payload);
          if (parsed == null ||
              parsed.senderId != peerId ||
              parsed.receiverId != identity.deviceId ||
              utf8.encode(parsed.text).length >
                  LanviaProtocol.limits['textMessageBytes']!)
            throw const FormatException('Invalid message');
          final received = ChatMessage(
            id: parsed.id,
            conversationId: conversationId(identity.deviceId, peerId),
            senderId: peerId,
            receiverId: identity.deviceId,
            text: parsed.text,
            timestamp: parsed.timestamp,
            status: 'delivered',
          );
          if (!messages.any((value) => value.id == received.id)) {
            messages.add(received);
            await database.saveMessage(received);
            if (settings.notifications)
              unawaited(
                notifications.message(
                  notificationId: received.id.hashCode & 0x7fffffff,
                  sender: _devices[peerId]?.identity.deviceName ?? 'LANVIA',
                  text: received.text,
                ),
              );
          }
          control.send(peerId, 'message_ack', <String, Object?>{
            'messageId': received.id,
            'status': 'delivered',
          });
          break;
        case 'message_ack':
          final id = envelope.payload['messageId'];
          if (id is String) {
            final index = messages.indexWhere(
              (value) => value.id == id && value.receiverId == peerId,
            );
            if (index >= 0) {
              final updated = messages[index].copyWith(status: 'delivered');
              messages[index] = updated;
              await database.saveMessage(updated);
            }
          }
          break;
        case 'transfer_request':
          await transferManager.registerIncoming(peerId, envelope.payload);
          break;
        case 'transfer_accept' ||
            'transfer_reject' ||
            'transfer_progress' ||
            'transfer_pause' ||
            'transfer_resume' ||
            'transfer_cancel' ||
            'transfer_complete' ||
            'transfer_error':
          await transferManager.handleControl(peerId, envelope);
          break;
        default:
          break;
      }
    } catch (error) {
      _log('APP', 'Rejected ${envelope.type}: $error');
    }
    transfers = transferManager.records;
    notifyListeners();
  }

  void _replaceMessage(ChatMessage value) {
    final index = messages.indexWhere((item) => item.id == value.id);
    if (index >= 0) messages[index] = value;
  }

  void _setStatus(String id, String status) {
    final old = _devices[id];
    if (old != null) _devices[id] = old.copyWith(status: status);
    notifyListeners();
  }

  void _refreshTrust(String id) {
    final old = _devices[id];
    if (old != null) {
      final value = _trusted[id];
      _devices[id] = old.copyWith(
        trusted: value != null && !value.blocked,
        blocked: value?.blocked ?? false,
      );
    }
  }

  void _expire() {
    final now = DateTime.now();
    var changed = false;
    for (final entry in _devices.entries.toList()) {
      if (entry.value.status != 'connected' &&
          now.difference(entry.value.lastSeenAt).inMilliseconds >
              LanviaProtocol.intervalsMs['peerExpiry']! &&
          entry.value.status != 'offline') {
        _devices[entry.key] = entry.value.copyWith(status: 'offline');
        changed = true;
      }
    }
    pendingPairings.removeWhere(
      (value) => value.expiresAt < now.millisecondsSinceEpoch,
    );
    if (changed) notifyListeners();
  }

  Future<void> _networkChanged() async {
    control.networkChanged();
    await udp.stop();
    await mdns.stop();
    await udp.start().catchError((Object error) {
      _log('DISCOVERY', '$error');
    });
    await mdns.start();
    interfaces = await bridge.interfaces();
    _notice('Network changed. Searching for devices…');
  }

  bool _isLanHost(String host) {
    final address = InternetAddress.tryParse(host);
    if (address == null)
      return RegExp(
        r'^[a-z0-9][a-z0-9.-]{0,252}$',
        caseSensitive: false,
      ).hasMatch(host);
    if (address.isLoopback || address.isLinkLocal) return true;
    if (address.type == InternetAddressType.IPv4) {
      final parts = host.split('.').map(int.parse).toList();
      return parts[0] == 10 ||
          parts[0] == 127 ||
          (parts[0] == 192 && parts[1] == 168) ||
          (parts[0] == 172 && parts[1] >= 16 && parts[1] <= 31);
    }
    return host.toLowerCase().startsWith('fc') ||
        host.toLowerCase().startsWith('fd') ||
        host.toLowerCase().startsWith('fe80');
  }

  String _randomToken() {
    final random = Random.secure();
    return base64Url
        .encode(List<int>.generate(32, (_) => random.nextInt(256)))
        .replaceAll('=', '');
  }

  void _notice(String value) {
    notice = value;
    noticeVersion++;
    notifyListeners();
  }

  void _log(String scope, String value) {
    final line = '${DateTime.now().toIso8601String()} [$scope] $value';
    logs.add(line);
    if (logs.length > 1000) logs.removeAt(0);
    debugPrint(line);
  }

  @override
  void dispose() {
    unawaited(_disposeAsync());
    super.dispose();
  }

  Future<void> _disposeAsync() async {
    _expiry?.cancel();
    _networkDebounce?.cancel();
    for (final value in _subscriptions) {
      await value.cancel();
    }
    await udp.dispose();
    await mdns.dispose();
    await control.dispose();
    await transferManager.dispose();
    await database.close();
  }
}
