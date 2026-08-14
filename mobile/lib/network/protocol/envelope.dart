import 'dart:convert';
import 'dart:typed_data';

import 'package:uuid/uuid.dart';

import '../../core/constants/protocol_generated.dart';

class Envelope {
  const Envelope({
    required this.version,
    required this.type,
    required this.requestId,
    required this.senderId,
    required this.receiverId,
    required this.timestamp,
    required this.payload,
  });
  final int version;
  final String type;
  final String requestId;
  final String senderId;
  final String receiverId;
  final int timestamp;
  final Map<String, Object?> payload;

  Map<String, Object?> toJson() => <String, Object?>{
    'version': version,
    'type': type,
    'requestId': requestId,
    'senderId': senderId,
    'receiverId': receiverId,
    'timestamp': timestamp,
    'payload': payload,
  };
  String encode() => jsonEncode(toJson());

  static Envelope create({
    required String type,
    required String senderId,
    required String receiverId,
    required Map<String, Object?> payload,
    String? requestId,
  }) => Envelope(
    version: LanviaProtocol.version,
    type: type,
    requestId: requestId ?? const Uuid().v4(),
    senderId: senderId,
    receiverId: receiverId,
    timestamp: DateTime.now().millisecondsSinceEpoch,
    payload: payload,
  );

  static Envelope? tryParse(Object? raw) {
    try {
      final Uint8List bytes;
      if (raw is String)
        bytes = Uint8List.fromList(utf8.encode(raw));
      else if (raw is List<int>)
        bytes = Uint8List.fromList(raw);
      else
        return null;
      if (bytes.length > LanviaProtocol.limits['webSocketMessageBytes']!)
        return null;
      final Object? decoded = jsonDecode(utf8.decode(bytes));
      if (decoded is! Map<Object?, Object?>) return null;
      final map = Map<String, Object?>.from(decoded);
      final version = map['version'];
      final type = map['type'];
      final requestId = map['requestId'];
      final sender = map['senderId'];
      final receiver = map['receiverId'];
      final timestamp = map['timestamp'];
      final payload = map['payload'];
      if (version != LanviaProtocol.version ||
          type is! String ||
          !LanviaProtocol.messageTypes.contains(type) ||
          requestId is! String ||
          requestId.length < 8 ||
          sender is! String ||
          sender.length < 8 ||
          receiver is! String ||
          receiver.length < 8 ||
          timestamp is! int ||
          payload is! Map<Object?, Object?>)
        return null;
      return Envelope(
        version: LanviaProtocol.version,
        type: type,
        requestId: requestId,
        senderId: sender,
        receiverId: receiver,
        timestamp: timestamp,
        payload: Map<String, Object?>.from(payload),
      );
    } on FormatException {
      return null;
    }
  }
}
