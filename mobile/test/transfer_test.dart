import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lanvia_mobile/core/utils/file_utils.dart';
import 'package:lanvia_mobile/discovery/network_bridge.dart';
import 'package:lanvia_mobile/settings/settings_model.dart';
import 'package:lanvia_mobile/transfers/transfer_manager.dart';
import 'package:lanvia_mobile/transfers/transfer_model.dart';

void main() {
  test('transfer state machine permits resume but not terminal rewind', () {
    expect(validTransferTransition('transferring', 'paused'), true);
    expect(validTransferTransition('paused', 'transferring'), true);
    expect(validTransferTransition('completed', 'transferring'), false);
  });
  test(
    'occupied transfer port falls back and reports its actual port',
    () async {
      final blocker = await HttpServer.bind(InternetAddress.anyIPv4, 0);
      final configuredPort = blocker.port;
      var announcedPort = 0;
      final settings = LanviaSettings.defaults.copyWith(
        transferPort: configuredPort,
      );
      final manager = TransferManager(
        settings: () => settings,
        send: (peerId, type, payload) {},
        peerAddress: (peerId) => null,
        persist: (record) async {},
        bridge: NetworkBridge(),
        onPortChanged: (port) => announcedPort = port,
      );
      try {
        await manager.start();
        expect(manager.status, 'running');
        expect(manager.boundPort, isNot(configuredPort));
        expect(announcedPort, manager.boundPort);
      } finally {
        await manager.stop();
        await blocker.close(force: true);
      }
    },
  );

  test('SHA-256 and safe names match common behavior', () async {
    final root = await Directory.systemTemp.createTemp('lanvia-dart-');
    try {
      final file = File('${root.path}/hello.txt');
      await file.writeAsString('Hello from LANVIA');
      expect(
        await sha256File(file.path),
        '9ceff3bb9dd4c27c505abe71cb808abaa96214f1e75af6a5dc915d29a6b80f17',
      );
      expect(sanitizeFileName('../../evil<>.txt'), 'evil__.txt');
      final destination = await safeDestination(root, '../../evil.txt');
      expect(destination.finalPath.startsWith(root.path), true);
    } finally {
      await root.delete(recursive: true);
    }
  });
}
