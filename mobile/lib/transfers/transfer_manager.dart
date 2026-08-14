import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:mime/mime.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

import '../core/constants/protocol_generated.dart';
import '../core/utils/file_utils.dart';
import '../discovery/network_bridge.dart';
import '../network/protocol/envelope.dart';
import '../settings/settings_model.dart';
import 'transfer_model.dart';

class TransferEvent {
  const TransferEvent(this.kind, this.record);
  final String kind;
  final TransferRecord record;
}

class _Source {
  _Source({
    required this.id,
    required this.peerId,
    required this.path,
    required this.token,
    required this.size,
    required this.expiresAt,
  });
  final String id;
  final String peerId;
  final String path;
  final String token;
  final int size;
  final int expiresAt;
  bool accepted = false;
}

class _Incoming {
  _Incoming({
    required this.id,
    required this.peerId,
    required this.address,
    required this.port,
    required this.token,
  });
  final String id;
  final String peerId;
  String address;
  final int port;
  final String token;
  String finalPath = '';
  String partPath = '';
  HttpClientRequest? request;
  String? intentionalStop;
}

class TransferManager {
  TransferManager({
    required LanviaSettings Function() settings,
    required void Function(String, String, Map<String, Object?>) send,
    required String? Function(String) peerAddress,
    required Future<void> Function(TransferRecord) persist,
    required NetworkBridge bridge,
    required void Function(int) onPortChanged,
  })  : _settings = settings,
        _send = send,
        _peerAddress = peerAddress,
        _persist = persist,
        _bridge = bridge,
        _onPortChanged = onPortChanged;
  final LanviaSettings Function() _settings;
  final void Function(String, String, Map<String, Object?>) _send;
  final String? Function(String) _peerAddress;
  final Future<void> Function(TransferRecord) _persist;
  final NetworkBridge _bridge;
  final void Function(int) _onPortChanged;
  final Map<String, TransferRecord> _records = <String, TransferRecord>{};
  final Map<String, _Source> _sources = <String, _Source>{};
  final Map<String, _Incoming> _incoming = <String, _Incoming>{};
  final StreamController<TransferEvent> _events =
      StreamController<TransferEvent>.broadcast();
  HttpServer? _server;
  String status = 'stopped';
  String? error;
  int boundPort = 0;
  int _active = 0;
  final Map<String, ({DateTime startedAt, int count})> _requestRates =
      <String, ({DateTime startedAt, int count})>{};
  Stream<TransferEvent> get events => _events.stream;
  List<TransferRecord> get records => _records.values.toList()
    ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  void seed(Iterable<TransferRecord> values) {
    for (final value in values) {
      _records[value.transferId] = value;
    }
  }

  Future<void> start() async {
    if (_server != null) return;
    status = 'starting';
    error = null;
    final configuredPort = _settings().transferPort;
    SocketException? lastError;

    for (var offset = 0;
        offset <= LanviaProtocol.limits['transferPortFallbackAttempts']!;
        offset++) {
      final candidate = configuredPort + offset;
      if (candidate > 65535) break;
      if (candidate == _settings().controlPort ||
          candidate == _settings().discoveryPort) {
        continue;
      }
      try {
        _server = await HttpServer.bind(InternetAddress.anyIPv4, candidate);
        boundPort = _server!.port;
        break;
      } on SocketException catch (exception) {
        lastError = exception;
        if (!_isAddressInUse(exception)) rethrow;
      }
    }

    if (_server == null && lastError != null && _isAddressInUse(lastError)) {
      _server = await HttpServer.bind(InternetAddress.anyIPv4, 0);
      boundPort = _server!.port;
    }
    if (_server == null) {
      status = 'error';
      error =
          'Transfer port $configuredPort unavailable: ${lastError?.message ?? 'bind failed'}';
      throw lastError ??
          const SocketException('Unable to bind transfer server');
    }

    status = 'running';
    _onPortChanged(boundPort);
    if (boundPort != configuredPort) {
      error =
          'Configured transfer port $configuredPort was occupied; using $boundPort';
    }
    _server!.listen(
      _handleHttp,
      onError: (Object value) {
        status = 'error';
        error = '$value';
      },
    );
  }

  Future<TransferRecord> createOutgoing(String peerId, String filePath) async {
    final file = File(filePath);
    final stat = await file.stat();
    if (stat.type != FileSystemEntityType.file)
      throw const FileSystemException('Selected path is not a file');
    if (stat.size > LanviaProtocol.limits['fileBytes']!)
      throw const FileSystemException('File exceeds LANVIA limit');
    final now = DateTime.now().millisecondsSinceEpoch;
    final id = const Uuid().v4();
    var record = TransferRecord(
      transferId: id,
      peerId: peerId,
      direction: 'outgoing',
      fileName: sanitizeFileName(p.basename(filePath)),
      mimeType: lookupMimeType(filePath) ?? 'application/octet-stream',
      size: stat.size,
      sha256: '',
      state: 'hashing',
      bytesTransferred: 0,
      speed: 0,
      remainingTime: null,
      createdAt: now,
      updatedAt: now,
      localPath: filePath,
    );
    await _save(record);
    try {
      final hash = await sha256File(filePath);
      final token = _token();
      final expires = DateTime.now().millisecondsSinceEpoch +
          LanviaProtocol.timeoutsMs['transferDecision']!;
      record = record.copyWith(sha256: hash, state: 'pending');
      _sources[id] = _Source(
        id: id,
        peerId: peerId,
        path: filePath,
        token: token,
        size: stat.size,
        expiresAt: expires,
      );
      await _save(record);
      _send(peerId, 'transfer_request', <String, Object?>{
        'transferId': id,
        'fileName': record.fileName,
        'mimeType': record.mimeType,
        'size': stat.size,
        'sha256': hash,
        'transferPort': boundPort == 0 ? _settings().transferPort : boundPort,
        'transferToken': token,
        'expiresAt': expires,
      });
      return record;
    } catch (exception) {
      record = record.copyWith(state: 'failed', error: '$exception');
      await _save(record);
      rethrow;
    }
  }

  Future<TransferRecord> registerIncoming(
    String peerId,
    Map<String, Object?> payload,
  ) async {
    final id = payload['transferId'];
    final fileName = payload['fileName'];
    final mimeType = payload['mimeType'];
    final size = payload['size'];
    final hash = payload['sha256'];
    final port = payload['transferPort'];
    final token = payload['transferToken'];
    final expires = payload['expiresAt'];
    if (id is! String ||
        !RegExp(r'^[0-9a-f-]{36}$', caseSensitive: false).hasMatch(id) ||
        fileName is! String ||
        fileName.isEmpty ||
        fileName.length > 255 ||
        mimeType is! String ||
        size is! int ||
        size < 0 ||
        size > LanviaProtocol.limits['fileBytes']! ||
        hash is! String ||
        !RegExp(r'^[0-9a-f]{64}$').hasMatch(hash) ||
        port is! int ||
        port < 1 ||
        port > 65535 ||
        token is! String ||
        token.length < 20 ||
        expires is! int ||
        expires < DateTime.now().millisecondsSinceEpoch)
      throw const FormatException('Invalid transfer request');
    final existing = _records[id];
    if (existing != null) return existing;
    final address = _peerAddress(peerId);
    if (address == null)
      throw const SocketException('Peer address unavailable');
    final now = DateTime.now().millisecondsSinceEpoch;
    final record = TransferRecord(
      transferId: id,
      peerId: peerId,
      direction: 'incoming',
      fileName: fileName,
      mimeType: mimeType,
      size: size,
      sha256: hash,
      state: 'pending',
      bytesTransferred: 0,
      speed: 0,
      remainingTime: null,
      createdAt: now,
      updatedAt: now,
    );
    _incoming[id] = _Incoming(
      id: id,
      peerId: peerId,
      address: address,
      port: port,
      token: token,
    );
    await _save(record, kind: 'incoming');
    return record;
  }

  Future<void> accept(String id) async {
    var record = _requireIncomingRecord(id);
    final context = _requireIncoming(id);
    if (_active >= LanviaProtocol.limits['concurrentTransfers']!)
      throw StateError('Concurrent transfer limit reached');
    if (context.finalPath.isEmpty) {
      final root = await _downloadDirectory();
      final destination = await safeDestination(root, record.fileName);
      context.finalPath = destination.finalPath;
      context.partPath = destination.partPath;
    }
    _send(record.peerId, 'transfer_accept', <String, Object?>{
      'transferId': id,
      'offset': 0,
    });
    record = record.copyWith(state: 'accepted', localPath: context.finalPath);
    await _save(record);
    await _download(id);
  }

  Future<void> reject(String id) async {
    final record = _requireIncomingRecord(id);
    _send(record.peerId, 'transfer_reject', <String, Object?>{
      'transferId': id,
      'reason': 'user_rejected',
    });
    await _save(record.copyWith(state: 'rejected'));
    _incoming.remove(id);
  }

  Future<void> pause(String id) async {
    final context = _requireIncoming(id);
    final record = _requireIncomingRecord(id);
    context.intentionalStop = 'pause';
    context.request?.abort();
    _send(record.peerId, 'transfer_pause', <String, Object?>{'transferId': id});
    await _save(record.copyWith(state: 'paused'));
  }

  Future<void> resume(String id) async {
    final record = _requireIncomingRecord(id);
    if (record.state != 'paused' && record.state != 'failed')
      throw StateError('Transfer is not resumable');
    final context = _requireIncoming(id);
    context.intentionalStop = null;
    context.address = _peerAddress(record.peerId) ?? context.address;
    final offset =
        context.partPath.isNotEmpty && await File(context.partPath).exists()
            ? await File(context.partPath).length()
            : 0;
    _send(record.peerId, 'transfer_resume', <String, Object?>{
      'transferId': id,
      'offset': offset,
    });
    await _download(id);
  }

  Future<void> cancel(String id) async {
    final record = _records[id];
    if (record == null) throw StateError('Transfer not found');
    final context = _incoming.remove(id);
    if (context != null) {
      context.intentionalStop = 'cancel';
      context.request?.abort();
      if (context.partPath.isNotEmpty)
        await File(context.partPath)
            .delete()
            .catchError((Object _) => File(context.partPath));
    }
    _sources.remove(id);
    _send(record.peerId, 'transfer_cancel', <String, Object?>{
      'transferId': id,
    });
    await _save(record.copyWith(state: 'cancelled'));
  }

  Future<void> handleControl(String peerId, Envelope envelope) async {
    final id = envelope.payload['transferId'];
    if (id is! String) return;
    final record = _records[id];
    switch (envelope.type) {
      case 'transfer_accept':
        final source = _sources[id];
        if (source != null && source.peerId == peerId && record != null) {
          source.accepted = true;
          await _save(record.copyWith(state: 'accepted'));
        }
        break;
      case 'transfer_reject':
        if (record != null) await _save(record.copyWith(state: 'rejected'));
        _sources.remove(id);
        break;
      case 'transfer_progress':
        if (record != null && record.peerId == peerId) {
          final bytes = _boundedInt(
            envelope.payload['bytesTransferred'],
            0,
            record.size,
          );
          final speed = _boundedInt(envelope.payload['speed'], 0, 1 << 53);
          final remaining = envelope.payload['remainingTime'];
          await _save(
            record.copyWith(
              state: 'transferring',
              bytesTransferred: bytes,
              speed: speed,
              remainingTime: remaining is int ? max(0, remaining) : null,
            ),
          );
        }
        break;
      case 'transfer_pause':
        if (record != null) await _save(record.copyWith(state: 'paused'));
        break;
      case 'transfer_resume':
        if (record != null) await _save(record.copyWith(state: 'transferring'));
        break;
      case 'transfer_cancel':
        if (record != null) await _save(record.copyWith(state: 'cancelled'));
        final context = _incoming.remove(id);
        if (context != null) {
          context.intentionalStop = 'cancel';
          context.request?.abort();
          if (context.partPath.isNotEmpty) {
            await File(context.partPath)
                .delete()
                .catchError((Object _) => File(context.partPath));
          }
        }
        _sources.remove(id);
        break;
      case 'transfer_complete':
        if (record != null &&
            envelope.payload['sha256'] == record.sha256 &&
            envelope.payload['size'] == record.size) {
          await _save(
            record.copyWith(
              state: 'completed',
              bytesTransferred: record.size,
              speed: 0,
              remainingTime: 0,
            ),
          );
          _sources.remove(id);
        }
        break;
      case 'transfer_error':
        if (record != null)
          await _save(
            record.copyWith(
              state: 'failed',
              error: '${envelope.payload['message'] ?? 'Transfer failed'}',
            ),
          );
        break;
      default:
        break;
    }
  }

  Future<void> _handleHttp(HttpRequest request) async {
    try {
      final remote = request.connectionInfo?.remoteAddress.address ?? 'unknown';
      if (!_allowRequest(remote)) {
        request.response.statusCode = HttpStatus.tooManyRequests;
        request.response.headers.set(HttpHeaders.retryAfterHeader, '60');
        await request.response.close();
        return;
      }
      if (request.method != 'GET') {
        request.response.statusCode = HttpStatus.methodNotAllowed;
        await request.response.close();
        return;
      }
      final match = RegExp(
        r'^/v1/transfers/([0-9a-f-]{36})$',
        caseSensitive: false,
      ).firstMatch(request.uri.path);
      final id = match?.group(1);
      final source = id == null ? null : _sources[id];
      if (source == null) {
        request.response.statusCode = HttpStatus.notFound;
        await request.response.close();
        return;
      }
      if (!source.accepted &&
          source.expiresAt < DateTime.now().millisecondsSinceEpoch) {
        request.response.statusCode = HttpStatus.gone;
        _sources.remove(source.id);
        await request.response.close();
        return;
      }
      if (!source.accepted ||
          request.headers.value('x-lanvia-receiver') != source.peerId) {
        request.response.statusCode = HttpStatus.forbidden;
        await request.response.close();
        return;
      }
      final token =
          (request.headers.value(HttpHeaders.authorizationHeader) ?? '')
              .replaceFirst(RegExp(r'^Bearer\s+', caseSensitive: false), '');
      if (!_safeEqual(token, source.token)) {
        request.response.statusCode = HttpStatus.unauthorized;
        await request.response.close();
        return;
      }
      final file = File(source.path);
      if (!await file.exists() || await file.length() != source.size) {
        request.response.statusCode = HttpStatus.gone;
        await request.response.close();
        return;
      }
      var start = 0;
      final range = request.headers.value(HttpHeaders.rangeHeader);
      if (range != null) {
        final match = RegExp(r'^bytes=(\d+)-$').firstMatch(range);
        start = int.tryParse(match?.group(1) ?? '') ?? -1;
        if (start < 0 || start >= source.size) {
          request.response.statusCode = HttpStatus.requestedRangeNotSatisfiable;
          request.response.headers.set(
            HttpHeaders.contentRangeHeader,
            'bytes */${source.size}',
          );
          await request.response.close();
          return;
        }
      }
      request.response.statusCode =
          start > 0 ? HttpStatus.partialContent : HttpStatus.ok;
      request.response.headers.set(
        HttpHeaders.contentTypeHeader,
        'application/octet-stream',
      );
      request.response.headers.set(HttpHeaders.acceptRangesHeader, 'bytes');
      request.response.headers.contentLength = source.size - start;
      if (start > 0)
        request.response.headers.set(
          HttpHeaders.contentRangeHeader,
          'bytes $start-${source.size - 1}/${source.size}',
        );
      await request.response.addStream(file.openRead(start));
      await request.response.close();
    } catch (_) {
      try {
        request.response.statusCode = HttpStatus.internalServerError;
      } on StateError {
        /* headers already sent */
      }
      try {
        await request.response.close();
      } on StateError {
        /* response already closed */
      }
    }
  }

  Future<void> _download(String id) async {
    final context = _requireIncoming(id);
    var record = _requireIncomingRecord(id);
    final part = File(context.partPath);
    if (!await part.exists()) await part.create(recursive: true);
    final existing = await part.length();
    if (existing > record.size)
      throw const FileSystemException('Partial file exceeds expected size');
    if (existing == record.size) {
      await _verify(context, record);
      return;
    }
    _active++;
    context.intentionalStop = null;
    var bytes = existing;
    var lastBytes = existing;
    var lastAt = DateTime.now();
    record = record.copyWith(
      state: 'transferring',
      bytesTransferred: existing,
      clearError: true,
    );
    await _save(record);
    await _bridge.startForeground(
      text: 'Receiving ${record.fileName}',
      progress: record.size == 0 ? 0 : (existing * 100 ~/ record.size),
    );
    final client = HttpClient()
      ..connectionTimeout = Duration(
        milliseconds: LanviaProtocol.timeoutsMs['httpIdle']!,
      );
    try {
      final host =
          context.address.contains(':') && !context.address.startsWith('[')
              ? '[${context.address}]'
              : context.address;
      final request = await client.getUrl(
        Uri.parse('http://$host:${context.port}/v1/transfers/$id'),
      );
      context.request = request;
      request.followRedirects = false;
      request.headers.set(
        HttpHeaders.authorizationHeader,
        'Bearer ${context.token}',
      );
      request.headers.set('X-LANVIA-Receiver', _localDeviceId ?? 'unknown');
      if (existing > 0)
        request.headers.set(HttpHeaders.rangeHeader, 'bytes=$existing-');
      final response = await request.close().timeout(
            Duration(milliseconds: LanviaProtocol.timeoutsMs['httpIdle']!),
          );
      final expected = existing > 0 ? HttpStatus.partialContent : HttpStatus.ok;
      if (response.statusCode != expected) {
        await response.drain<void>();
        throw HttpException('Transfer status ${response.statusCode}');
      }
      final sink = part.openWrite(
        mode: existing > 0 ? FileMode.append : FileMode.write,
      );
      await for (final chunk in response.timeout(
        Duration(milliseconds: LanviaProtocol.timeoutsMs['httpIdle']!),
      )) {
        sink.add(chunk);
        bytes += chunk.length;
        final now = DateTime.now();
        if (now.difference(lastAt).inMilliseconds >=
            LanviaProtocol.intervalsMs['progressNotification']!) {
          final speed = ((bytes - lastBytes) *
                  1000 /
                  max(1, now.difference(lastAt).inMilliseconds))
              .round();
          final remaining =
              speed > 0 ? ((record.size - bytes) / speed).ceil() : null;
          record = record.copyWith(
            bytesTransferred: bytes,
            speed: speed,
            remainingTime: remaining,
          );
          await _save(record);
          _send(record.peerId, 'transfer_progress', <String, Object?>{
            'transferId': id,
            'bytesTransferred': bytes,
            'totalBytes': record.size,
            'speed': speed,
            'remainingTime': remaining,
          });
          await _bridge.startForeground(
            text: 'Receiving ${record.fileName}',
            progress:
                record.size == 0 ? 100 : min(100, bytes * 100 ~/ record.size),
          );
          lastAt = now;
          lastBytes = bytes;
        }
      }
      await sink.flush();
      await sink.close();
      if (bytes != record.size)
        throw const FileSystemException('Transfer ended before expected size');
      record = record.copyWith(
        state: 'verifying',
        bytesTransferred: bytes,
        speed: 0,
        remainingTime: 0,
      );
      await _save(record);
      await _verify(context, record);
    } catch (exception) {
      if (context.intentionalStop == null) {
        record = record.copyWith(
          state: 'failed',
          bytesTransferred: bytes,
          error: '$exception',
        );
        await _save(record);
        _send(record.peerId, 'transfer_error', <String, Object?>{
          'transferId': id,
          'code': 'internal_error',
          'message': '$exception',
          'retryable': true,
        });
        rethrow;
      }
    } finally {
      context.request = null;
      client.close(force: true);
      _active = max(0, _active - 1);
      if (_active == 0) await _bridge.stopForeground();
    }
  }

  String? _localDeviceId;
  void setLocalDeviceId(String value) {
    _localDeviceId = value;
  }

  Future<void> _verify(_Incoming context, TransferRecord record) async {
    final actual = await sha256File(context.partPath);
    if (actual != record.sha256) {
      final failed = record.copyWith(
        state: 'failed',
        error: 'SHA-256 integrity verification failed',
      );
      await _save(failed);
      _send(record.peerId, 'transfer_error', <String, Object?>{
        'transferId': record.transferId,
        'code': 'hash_mismatch',
        'message': failed.error,
        'retryable': true,
      });
      throw const FileSystemException('SHA-256 mismatch');
    }
    await File(context.partPath).rename(context.finalPath);
    await _save(
      record.copyWith(
        state: 'completed',
        bytesTransferred: record.size,
        speed: 0,
        remainingTime: 0,
        localPath: context.finalPath,
      ),
    );
    _send(record.peerId, 'transfer_complete', <String, Object?>{
      'transferId': record.transferId,
      'sha256': actual,
      'size': record.size,
    });
    _incoming.remove(record.transferId);
  }

  Future<Directory> _downloadDirectory() async {
    if (_settings().downloadFolder != null)
      return Directory(_settings().downloadFolder!);
    final root = await getExternalStorageDirectory() ??
        await getApplicationDocumentsDirectory();
    return Directory(p.join(root.path, 'LANVIA'));
  }

  Future<void> _save(TransferRecord record, {String kind = 'changed'}) async {
    _records[record.transferId] = record;
    await _persist(record);
    _events.add(TransferEvent(kind, record));
  }

  TransferRecord _requireIncomingRecord(String id) {
    final value = _records[id];
    if (value == null || value.direction != 'incoming')
      throw StateError('Incoming transfer not found');
    return value;
  }

  _Incoming _requireIncoming(String id) {
    final value = _incoming[id];
    if (value == null)
      throw StateError('Transfer session expired; ask sender to retry');
    return value;
  }

  String _token() {
    final random = Random.secure();
    return base64Url
        .encode(List<int>.generate(32, (_) => random.nextInt(256)))
        .replaceAll('=', '');
  }

  bool _isAddressInUse(SocketException exception) {
    final code = exception.osError?.errorCode;
    final message = '${exception.message} ${exception.osError?.message ?? ''}'
        .toLowerCase();

    return code == 98 ||
        code == 48 ||
        code == 10048 ||
        message.contains('address already in use') ||
        message.contains('shared flag to bind') ||
        message.contains('binding multiple times');
  }

  bool _allowRequest(String address) {
    final now = DateTime.now();
    final current = _requestRates[address];
    if (current == null || now.difference(current.startedAt).inSeconds >= 60) {
      _requestRates[address] = (startedAt: now, count: 1);
      return true;
    }
    final count = current.count + 1;
    _requestRates[address] = (startedAt: current.startedAt, count: count);
    return count <= LanviaProtocol.limits['requestsPerMinute']!;
  }

  bool _safeEqual(String a, String b) {
    final left = utf8.encode(a);
    final right = utf8.encode(b);
    var diff = left.length ^ right.length;
    for (var i = 0; i < max(left.length, right.length); i++) {
      diff |=
          (i < left.length ? left[i] : 0) ^ (i < right.length ? right[i] : 0);
    }
    return diff == 0;
  }

  int _boundedInt(Object? value, int minValue, int maxValue) =>
      value is int ? value.clamp(minValue, maxValue) : minValue;
  Future<void> stop() async {
    for (final value in _incoming.values) {
      value.request?.abort();
    }
    await _server?.close(force: true);
    _server = null;
    status = 'stopped';
  }

  Future<void> dispose() async {
    await stop();
    await _events.close();
  }
}
