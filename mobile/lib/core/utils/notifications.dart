import 'dart:async';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class NotificationService {
  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  Future<void> Function(String action, String transferId)? onTransferAction;

  Future<void> initialize() async {
    const settings = InitializationSettings(
      android: AndroidInitializationSettings('ic_stat_lanvia'),
    );
    await _plugin.initialize(
      settings,
      onDidReceiveNotificationResponse: (response) {
        final payload = response.payload;
        if (payload == null) return;
        final action = response.actionId;
        if (action != null && (action == 'accept' || action == 'reject')) {
          final handler = onTransferAction;
          if (handler != null) unawaited(handler(action, payload));
        }
      },
    );
  }

  Future<void> requestPermission() async {
    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.requestNotificationsPermission();
  }

  Future<void> incomingTransfer({
    required int notificationId,
    required String sender,
    required String fileName,
    required String transferId,
  }) => _plugin.show(
    notificationId,
    'LANVIA',
    '$sender wants to send $fileName',
    const NotificationDetails(
      android: AndroidNotificationDetails(
        'lanvia_requests',
        'Incoming LANVIA requests',
        channelDescription: 'Pairing and file transfer requests',
        importance: Importance.high,
        priority: Priority.high,
        actions: <AndroidNotificationAction>[
          AndroidNotificationAction(
            'reject',
            'Reject',
            cancelNotification: true,
            showsUserInterface: true,
          ),
          AndroidNotificationAction(
            'accept',
            'Accept',
            cancelNotification: true,
            showsUserInterface: true,
          ),
        ],
      ),
    ),
    payload: transferId,
  );

  Future<void> message({
    required int notificationId,
    required String sender,
    required String text,
  }) => _plugin.show(
    notificationId,
    sender,
    text,
    const NotificationDetails(
      android: AndroidNotificationDetails(
        'lanvia_messages',
        'LANVIA messages',
        channelDescription: 'Messages received over the local network',
        importance: Importance.high,
        priority: Priority.high,
      ),
    ),
  );
}
