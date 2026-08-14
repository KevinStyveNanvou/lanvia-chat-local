import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'core/utils/notifications.dart';
import 'devices/providers/lanvia_controller.dart';
import 'ui/home_screen.dart';
import 'ui/theme/lanvia_theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final notifications = NotificationService();
  await notifications.initialize();
  final controller = LanviaController(notifications: notifications);
  await controller.start();
  runApp(LanviaApp(controller: controller));
}

class LanviaApp extends StatefulWidget {
  const LanviaApp({required this.controller, super.key});
  final LanviaController controller;
  @override
  State<LanviaApp> createState() => _LanviaAppState();
}

class _LanviaAppState extends State<LanviaApp> with WidgetsBindingObserver {
  final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();
  final GlobalKey<ScaffoldMessengerState> messengerKey =
      GlobalKey<ScaffoldMessengerState>();
  int seenNotice = 0;
  final Set<String> seenPairings = <String>{};
  final Set<String> seenTransfers = <String>{};
  bool dialogOpen = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_onState);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_onState);
    widget.controller.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused)
      unawaited(widget.controller.keepAliveInBackground(true));
    if (state == AppLifecycleState.resumed)
      unawaited(widget.controller.keepAliveInBackground(false));
  }

  void _onState() {
    if (!mounted) return;
    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) => _presentEvents());
  }

  Future<void> _presentEvents() async {
    if (!mounted) return;
    final controller = widget.controller;
    if (controller.noticeVersion != seenNotice && controller.notice != null) {
      seenNotice = controller.noticeVersion;
      messengerKey.currentState?.showSnackBar(
        SnackBar(content: Text(controller.notice!)),
      );
    }
    if (dialogOpen) return;
    final prompts = controller.pendingPairings.where(
      (value) => !seenPairings.contains(value.pairId),
    );
    if (prompts.isNotEmpty) {
      final prompt = prompts.first;
      seenPairings.add(prompt.pairId);
      dialogOpen = true;
      final context = navigatorKey.currentContext;
      if (context != null) {
        final accepted = await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (context) => AlertDialog(
            icon: const Icon(
              Icons.verified_user_outlined,
              color: Color(0xFFA78BFA),
              size: 34,
            ),
            title: const Text('Pairing request'),
            content: Text(
              '${prompt.peerName} wants to connect with this device.\n\nAccept only if you recognize it on your local network.',
              textAlign: TextAlign.center,
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Reject'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Accept'),
              ),
            ],
          ),
        );
        try {
          await controller.respondPairing(prompt.pairId, accepted ?? false);
        } on Object catch (error) {
          messengerKey.currentState?.showSnackBar(
            SnackBar(content: Text('$error')),
          );
        }
      }
      dialogOpen = false;
      return;
    }
    final incoming = controller.latestIncomingTransfer;
    if (incoming != null && !seenTransfers.contains(incoming.transferId)) {
      seenTransfers.add(incoming.transferId);
      dialogOpen = true;
      final context = navigatorKey.currentContext;
      if (context != null) {
        final sender =
            controller.device(incoming.peerId)?.identity.deviceName ??
            'A device';
        final accepted = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            icon: const Icon(
              Icons.download_for_offline_outlined,
              color: Color(0xFFA78BFA),
              size: 34,
            ),
            title: const Text('Incoming file'),
            content: Text(
              '$sender wants to send\n${incoming.fileName}\n\n${_bytes(incoming.size)}',
              textAlign: TextAlign.center,
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Reject'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Accept'),
              ),
            ],
          ),
        );
        if (accepted == true) {
          unawaited(
            controller.acceptTransfer(incoming.transferId).catchError((
              Object error,
            ) {
              messengerKey.currentState?.showSnackBar(
                SnackBar(content: Text('$error')),
              );
            }),
          );
        } else {
          unawaited(controller.rejectTransfer(incoming.transferId));
        }
      }
      dialogOpen = false;
    }
  }

  static String _bytes(int value) => value < 1048576
      ? '${(value / 1024).toStringAsFixed(1)} KB'
      : '${(value / 1048576).toStringAsFixed(1)} MB';
  @override
  Widget build(BuildContext context) {
    final mode = switch (widget.controller.settings.theme) {
      'light' => ThemeMode.light,
      'system' => ThemeMode.system,
      _ => ThemeMode.dark,
    };
    return ChangeNotifierProvider<LanviaController>.value(
      value: widget.controller,
      child: MaterialApp(
        navigatorKey: navigatorKey,
        scaffoldMessengerKey: messengerKey,
        title: 'LANVIA',
        debugShowCheckedModeBanner: false,
        theme: LanviaTheme.light(),
        darkTheme: LanviaTheme.dark(),
        themeMode: mode,
        home: const HomeScreen(),
      ),
    );
  }
}
