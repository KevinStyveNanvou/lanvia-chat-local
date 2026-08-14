import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lanvia_mobile/core/constants/protocol_generated.dart';
import 'package:lanvia_mobile/network/protocol/envelope.dart';

void main() {
  test('generated constants match the common source and fixed ports', () async {
    final raw = await File('../protocol/lanvia-protocol.json').readAsString();
    expect(
      sha256.convert(utf8.encode(raw)).toString(),
      LanviaProtocol.sourceSha256,
    );
    expect(LanviaProtocol.controlPort, 53211);
    expect(LanviaProtocol.transferPort, 53212);
    expect(LanviaProtocol.discoveryPort, 53213);
  });
  test('golden message envelope parses and serializes', () async {
    final raw = await File('../protocol/examples/message-send.json')
        .readAsString();
    final envelope = Envelope.tryParse(raw);
    expect(envelope?.type, 'message_send');
    expect(
      Envelope.tryParse(envelope!.encode())?.payload['text'],
      'Hello from LANVIA',
    );
    expect((envelope.payload['id'] as String).isNotEmpty, true);
  });
  test('invalid version and binary oversize are rejected', () {
    expect(
      Envelope.tryParse(jsonEncode(<String, Object?>{'version': 2})),
      isNull,
    );
    expect(
      Envelope.tryParse(
        List<int>.filled(
          LanviaProtocol.limits['webSocketMessageBytes']! + 1,
          0,
        ),
      ),
      isNull,
    );
  });
}
