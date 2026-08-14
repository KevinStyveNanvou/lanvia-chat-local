import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../chat/message.dart';
import '../devices/providers/lanvia_controller.dart';
import '../transfers/transfer_model.dart';
import 'widgets/device_avatar.dart';
import 'widgets/status_dot.dart';

class _Item {
  const _Item(this.at, {this.message, this.transfer});
  final int at;
  final ChatMessage? message;
  final TransferRecord? transfer;
}

class ConversationScreen extends StatefulWidget {
  const ConversationScreen({required this.peerId, super.key});
  final String peerId;
  @override
  State<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends State<ConversationScreen> {
  final TextEditingController _text = TextEditingController();
  final ScrollController _scroll = ScrollController();
  String? _lastTimelineKey;
  bool _didInitialScroll = false;
  @override
  void dispose() {
    _text.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = context.watch<LanviaController>();
    final discovered = controller.device(widget.peerId);
    final trusted = controller.trusted(widget.peerId);
    final name =
        discovered?.identity.deviceName ??
        trusted?.lastName ??
        'Unknown device';
    final platform =
        discovered?.identity.platform ?? trusted?.platform ?? 'unknown';
    final mobile =
        discovered?.identity.deviceType == 'mobile' || platform == 'android';
    final status = discovered?.status ?? 'offline';
    final isTrusted = trusted != null && !trusted.blocked;
    final blocked = trusted?.blocked ?? false;
    final items = <_Item>[
      ...controller.messages
          .where(
            (value) =>
                value.senderId == widget.peerId ||
                value.receiverId == widget.peerId,
          )
          .map((value) => _Item(value.timestamp, message: value)),
      ...controller.transfers
          .where((value) => value.peerId == widget.peerId)
          .map((value) => _Item(value.createdAt, transfer: value)),
    ]..sort((a, b) => a.at.compareTo(b.at));
    final lastTimelineKey = items.isEmpty
        ? '${widget.peerId}:empty'
        : '${widget.peerId}:${items.last.message?.id ?? items.last.transfer?.transferId}:${items.length}';
    _scheduleScrollToLatest(lastTimelineKey);
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 4,
        title: Row(
          children: <Widget>[
            DeviceAvatar(mobile: mobile, size: 40),
            const SizedBox(width: 11),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  name,
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                  ),
                ),
                const SizedBox(height: 3),
                Row(
                  children: <Widget>[
                    StatusDot(status),
                    const SizedBox(width: 5),
                    Text(
                      '$status · $platform',
                      style: const TextStyle(
                        color: Color(0xFFA8A0B8),
                        fontSize: 10,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
        actions: <Widget>[
          if (!blocked && status != 'connected')
            IconButton(
              tooltip: 'Connect',
              icon: const Icon(Icons.add_link_rounded),
              onPressed: discovered == null
                  ? null
                  : () => _run(controller.connectDevice(widget.peerId)),
            ),
          if (!blocked && status == 'connected' && !isTrusted)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 3),
              child: FilledButton.icon(
                onPressed: () => _run(controller.pair(widget.peerId)),
                icon: const Icon(Icons.verified_user_outlined, size: 17),
                label: const Text('Pair'),
              ),
            ),
          PopupMenuButton<String>(
            onSelected: (value) {
              if (value == 'remove')
                _run(controller.removeTrusted(widget.peerId));
              if (value == 'block')
                _run(controller.setBlocked(widget.peerId, !blocked));
            },
            itemBuilder: (_) => <PopupMenuEntry<String>>[
              if (trusted != null)
                PopupMenuItem<String>(
                  value: 'block',
                  child: Row(
                    children: <Widget>[
                      const Icon(Icons.block, size: 18),
                      const SizedBox(width: 9),
                      Text(blocked ? 'Unblock device' : 'Block device'),
                    ],
                  ),
                ),
              if (trusted != null)
                const PopupMenuItem<String>(
                  value: 'remove',
                  child: Row(
                    children: <Widget>[
                      Icon(
                        Icons.delete_outline,
                        color: Color(0xFFEF4444),
                        size: 18,
                      ),
                      SizedBox(width: 9),
                      Text('Remove trust'),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          Expanded(
            child: items.isEmpty
                ? const _ConversationStart()
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(14, 20, 14, 12),
                    itemCount: items.length,
                    itemBuilder: (context, index) {
                      final item = items[index];
                      if (item.message != null)
                        return _MessageBubble(
                          message: item.message!,
                          outgoing:
                              item.message!.senderId ==
                              controller.identity.deviceId,
                          onRetry: () =>
                              _run(controller.retryMessage(item.message!.id)),
                        );
                      return _TransferCard(
                        transfer: item.transfer!,
                        onAction: (action) => _transferAction(
                          controller,
                          action,
                          item.transfer!.transferId,
                        ),
                      );
                    },
                  ),
          ),
          if (!isTrusted)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 16),
              color: const Color(0x223B0764),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  const Icon(
                    Icons.verified_user_outlined,
                    size: 17,
                    color: Color(0xFFA78BFA),
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      status == 'connected'
                          ? 'Pair this device before sending.'
                          : 'Connect, then pair to begin.',
                      style: const TextStyle(
                        color: Color(0xFFA8A0B8),
                        fontSize: 11,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          SafeArea(
            top: false,
            child: Container(
              padding: const EdgeInsets.fromLTRB(10, 10, 10, 9),
              decoration: const BoxDecoration(
                color: Color(0xFF181126),
                border: Border(top: BorderSide(color: Color(0x12FFFFFF))),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  _FormattingToolbar(
                    enabled: status == 'connected' && isTrusted && !blocked,
                    onFormat: _wrapSelection,
                  ),
                  const SizedBox(height: 5),
                  Row(
                    children: <Widget>[
                      IconButton.filledTonal(
                        onPressed:
                            status == 'connected' && isTrusted && !blocked
                            ? () => _attachments(controller)
                            : null,
                        icon: const Icon(Icons.add_rounded),
                      ),
                      const SizedBox(width: 7),
                      Expanded(
                        child: TextField(
                          controller: _text,
                          enabled:
                              status == 'connected' && isTrusted && !blocked,
                          minLines: 1,
                          maxLines: 4,
                          textCapitalization: TextCapitalization.sentences,
                          decoration: InputDecoration(
                            hintText: isTrusted
                                ? 'Write a message…'
                                : 'Pair to start messaging',
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 15,
                              vertical: 11,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 7),
                      IconButton.filled(
                        onPressed:
                            status == 'connected' && isTrusted && !blocked
                            ? () {
                                final value = _text.text;
                                if (value.trim().isEmpty) return;
                                _text.clear();
                                _run(
                                  controller.sendMessage(widget.peerId, value),
                                );
                              }
                            : null,
                        icon: const Icon(Icons.send_rounded, size: 19),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _scheduleScrollToLatest(String timelineKey) {
    if (_lastTimelineKey == timelineKey) return;
    _lastTimelineKey = timelineKey;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final target = _scroll.position.maxScrollExtent;
      if (_didInitialScroll) {
        _scroll.animateTo(
          target,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
        );
      } else {
        _scroll.jumpTo(target);
        _didInitialScroll = true;
      }
    });
  }

  void _wrapSelection(String open, [String? close]) {
    final selection = _text.selection;
    final start = selection.isValid ? selection.start : _text.text.length;
    final end = selection.isValid ? selection.end : _text.text.length;
    final closing = close ?? open;
    final selected = _text.text.substring(start, end);
    final next =
        '${_text.text.substring(0, start)}$open$selected$closing${_text.text.substring(end)}';
    _text.value = TextEditingValue(
      text: next,
      selection: TextSelection(
        baseOffset: start + open.length,
        extentOffset: start + open.length + selected.length,
      ),
    );
  }

  Future<void> _run(Future<void> action) async {
    try {
      await action;
    } on Object catch (error) {
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  Future<void> _transferAction(
    LanviaController controller,
    String action,
    String id,
  ) => _run(switch (action) {
    'accept' => controller.acceptTransfer(id),
    'reject' => controller.rejectTransfer(id),
    'pause' => controller.pauseTransfer(id),
    'resume' => controller.resumeTransfer(id),
    'cancel' => controller.cancelTransfer(id),
    _ => controller.openTransfer(id),
  });
  Future<void> _attachments(LanviaController controller) async {
    await showModalBottomSheet<void>(
      context: context,
      builder: (context) => Padding(
        padding: const EdgeInsets.fromLTRB(18, 4, 18, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Text(
              'Send with LANVIA',
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 9,
              runSpacing: 9,
              children: <Widget>[
                _Attach(
                  icon: Icons.insert_drive_file_outlined,
                  label: 'Files',
                  onTap: () => _choose(context, controller, 'file'),
                ),
                _Attach(
                  icon: Icons.image_outlined,
                  label: 'Photos',
                  onTap: () => _choose(context, controller, 'image'),
                ),
                _Attach(
                  icon: Icons.video_file_outlined,
                  label: 'Videos',
                  onTap: () => _choose(context, controller, 'video'),
                ),
                _Attach(
                  icon: Icons.audio_file_outlined,
                  label: 'Audio',
                  onTap: () => _choose(context, controller, 'audio'),
                ),
                _Attach(
                  icon: Icons.description_outlined,
                  label: 'Documents',
                  onTap: () => _choose(context, controller, 'document'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _choose(
    BuildContext sheetContext,
    LanviaController controller,
    String kind,
  ) {
    Navigator.pop(sheetContext);
    _run(controller.chooseFiles(widget.peerId, kind));
  }
}

class _FormattingToolbar extends StatelessWidget {
  const _FormattingToolbar({required this.enabled, required this.onFormat});
  final bool enabled;
  final void Function(String open, [String? close]) onFormat;

  @override
  Widget build(BuildContext context) => Row(
    children: <Widget>[
      _FormatButton(
        tooltip: 'Bold',
        icon: Icons.format_bold,
        enabled: enabled,
        onPressed: () => onFormat('**'),
      ),
      _FormatButton(
        tooltip: 'Italic',
        icon: Icons.format_italic,
        enabled: enabled,
        onPressed: () => onFormat('*'),
      ),
      _FormatButton(
        tooltip: 'Underline',
        icon: Icons.format_underlined,
        enabled: enabled,
        onPressed: () => onFormat('__'),
      ),
      _FormatButton(
        tooltip: 'Strikethrough',
        icon: Icons.format_strikethrough,
        enabled: enabled,
        onPressed: () => onFormat('~~'),
      ),
      _FormatButton(
        tooltip: 'Code',
        icon: Icons.code,
        enabled: enabled,
        onPressed: () => onFormat('`'),
      ),
      const Spacer(),
      const Text(
        'FORMAT',
        style: TextStyle(
          color: Color(0xFF716979),
          fontSize: 8,
          fontWeight: FontWeight.w700,
          letterSpacing: .8,
        ),
      ),
    ],
  );
}

class _FormatButton extends StatelessWidget {
  const _FormatButton({
    required this.tooltip,
    required this.icon,
    required this.enabled,
    required this.onPressed,
  });
  final String tooltip;
  final IconData icon;
  final bool enabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: tooltip,
    visualDensity: VisualDensity.compact,
    constraints: const BoxConstraints.tightFor(width: 34, height: 28),
    padding: EdgeInsets.zero,
    iconSize: 17,
    color: const Color(0xFFA8A0B8),
    onPressed: enabled ? onPressed : null,
    icon: Icon(icon),
  );
}

class _Attach extends StatelessWidget {
  const _Attach({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(14),
    child: Container(
      width: 95,
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(14),
        color: const Color(0xFF21183A),
      ),
      child: Column(
        children: <Widget>[
          Icon(icon, color: const Color(0xFFA78BFA)),
          const SizedBox(height: 7),
          Text(label, style: const TextStyle(fontSize: 11)),
        ],
      ),
    ),
  );
}

class _ConversationStart extends StatelessWidget {
  const _ConversationStart();
  @override
  Widget build(BuildContext context) => const Center(
    child: Padding(
      padding: EdgeInsets.all(30),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.lock_outline_rounded, color: Color(0xFF7C3AED), size: 30),
          SizedBox(height: 12),
          Text(
            'Direct LAN conversation',
            style: TextStyle(fontWeight: FontWeight.w700),
          ),
          SizedBox(height: 6),
          Text(
            'Messages and files stay on your local network.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Color(0xFFA8A0B8), fontSize: 11),
          ),
        ],
      ),
    ),
  );
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    required this.message,
    required this.outgoing,
    required this.onRetry,
  });
  final ChatMessage message;
  final bool outgoing;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) => Align(
    alignment: outgoing ? Alignment.centerRight : Alignment.centerLeft,
    child: Container(
      margin: const EdgeInsets.only(bottom: 6),
      constraints: BoxConstraints(
        maxWidth: MediaQuery.sizeOf(context).width * .76,
      ),
      padding: const EdgeInsets.fromLTRB(12, 9, 10, 6),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.only(
          topLeft: Radius.circular(outgoing ? 17 : 6),
          topRight: Radius.circular(outgoing ? 6 : 17),
          bottomLeft: const Radius.circular(17),
          bottomRight: const Radius.circular(17),
        ),
        gradient: outgoing
            ? const LinearGradient(
                colors: <Color>[Color(0xFF5B21B6), Color(0xFF4C1D95)],
              )
            : null,
        color: outgoing ? null : const Color(0xFF211A2D),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: <Widget>[
          Align(
            alignment: Alignment.centerLeft,
            child: Text.rich(
              TextSpan(children: _formattedSpans(message.text)),
              style: const TextStyle(fontSize: 13.5, height: 1.4),
            ),
          ),
          const SizedBox(height: 3),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              IconButton(
                tooltip: 'Copy message',
                visualDensity: VisualDensity.compact,
                constraints: const BoxConstraints.tightFor(
                  width: 25,
                  height: 22,
                ),
                padding: EdgeInsets.zero,
                iconSize: 13,
                color: const Color(0xB0F5F3FF),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: message.text));
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(
                      content: Text('Message copied'),
                      duration: Duration(milliseconds: 900),
                    ),
                  );
                },
                icon: const Icon(Icons.copy_rounded),
              ),
              const SizedBox(width: 2),
              Text(
                TimeOfDay.fromDateTime(
                  DateTime.fromMillisecondsSinceEpoch(message.timestamp),
                ).format(context),
                style: const TextStyle(color: Color(0xB0F5F3FF), fontSize: 9),
              ),
              const SizedBox(width: 4),
              Icon(
                message.status == 'delivered'
                    ? Icons.done_all_rounded
                    : message.status == 'failed'
                    ? Icons.error_outline
                    : message.status == 'sending'
                    ? Icons.schedule
                    : Icons.done_rounded,
                size: 13,
                color: message.status == 'failed'
                    ? const Color(0xFFFCA5A5)
                    : const Color(0xB0F5F3FF),
              ),
              if (message.status == 'failed')
                TextButton(
                  onPressed: onRetry,
                  style: TextButton.styleFrom(
                    minimumSize: Size.zero,
                    padding: const EdgeInsets.only(left: 5),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: const Text('Retry', style: TextStyle(fontSize: 9)),
                ),
            ],
          ),
        ],
      ),
    ),
  );

  static List<InlineSpan> _formattedSpans(String text) {
    final expression = RegExp(
      r'(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\*[^*\n]+\*)',
    );
    final spans = <InlineSpan>[];
    var cursor = 0;
    for (final match in expression.allMatches(text)) {
      if (match.start > cursor) {
        spans.add(TextSpan(text: text.substring(cursor, match.start)));
      }
      final token = match.group(0)!;
      if (token.startsWith('**')) {
        spans.add(
          TextSpan(
            text: token.substring(2, token.length - 2),
            style: const TextStyle(fontWeight: FontWeight.w800),
          ),
        );
      } else if (token.startsWith('__')) {
        spans.add(
          TextSpan(
            text: token.substring(2, token.length - 2),
            style: const TextStyle(decoration: TextDecoration.underline),
          ),
        );
      } else if (token.startsWith('~~')) {
        spans.add(
          TextSpan(
            text: token.substring(2, token.length - 2),
            style: const TextStyle(decoration: TextDecoration.lineThrough),
          ),
        );
      } else if (token.startsWith('`')) {
        spans.add(
          TextSpan(
            text: token.substring(1, token.length - 1),
            style: const TextStyle(
              fontFamily: 'monospace',
              backgroundColor: Color(0x26000000),
            ),
          ),
        );
      } else {
        spans.add(
          TextSpan(
            text: token.substring(1, token.length - 1),
            style: const TextStyle(fontStyle: FontStyle.italic),
          ),
        );
      }
      cursor = match.end;
    }
    if (cursor < text.length) spans.add(TextSpan(text: text.substring(cursor)));
    return spans;
  }
}

class _TransferCard extends StatelessWidget {
  const _TransferCard({required this.transfer, required this.onAction});
  final TransferRecord transfer;
  final void Function(String) onAction;
  @override
  Widget build(BuildContext context) {
    final outgoing = transfer.direction == 'outgoing';
    final percent = transfer.size == 0
        ? (transfer.state == 'completed' ? 100 : 0)
        : (transfer.bytesTransferred * 100 / transfer.size).round().clamp(
            0,
            100,
          );
    final active = <String>{
      'accepted',
      'transferring',
      'paused',
      'verifying',
    }.contains(transfer.state);
    return Align(
      alignment: outgoing ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        width: min(MediaQuery.sizeOf(context).width * .8, 350.0),
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.all(11),
        decoration: BoxDecoration(
          color: outgoing ? const Color(0xFF342054) : const Color(0xFF211A2D),
          borderRadius: BorderRadius.circular(15),
          border: Border.all(color: const Color(0x227C3AED)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (transfer.state == 'completed' &&
                transfer.mimeType.startsWith('image/') &&
                transfer.localPath != null)
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.file(
                  File(transfer.localPath!),
                  width: double.infinity,
                  height: 180,
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => const SizedBox.shrink(),
                ),
              ),
            if (transfer.state == 'completed' &&
                transfer.mimeType.startsWith('image/'))
              const SizedBox(height: 9),
            Row(
              children: <Widget>[
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: const Color(0x227C3AED),
                    borderRadius: BorderRadius.circular(11),
                  ),
                  child: Icon(
                    _fileIcon(transfer.mimeType),
                    color: const Color(0xFFC4B5FD),
                    size: 21,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        transfer.fileName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontWeight: FontWeight.w700,
                          fontSize: 12.5,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        '${_bytes(transfer.size)} · ${transfer.state}',
                        style: const TextStyle(
                          color: Color(0xFFA8A0B8),
                          fontSize: 10,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (active) ...<Widget>[
              const SizedBox(height: 11),
              LinearProgressIndicator(
                value: percent / 100,
                minHeight: 4,
                borderRadius: BorderRadius.circular(3),
                backgroundColor: const Color(0x22FFFFFF),
              ),
              const SizedBox(height: 5),
              Row(
                children: <Widget>[
                  Text(
                    '$percent%',
                    style: const TextStyle(
                      fontSize: 9,
                      color: Color(0xFFA8A0B8),
                    ),
                  ),
                  const Spacer(),
                  Text(
                    transfer.speed > 0
                        ? '${_bytes(transfer.speed)}/s${transfer.remainingTime != null ? ' · ${transfer.remainingTime}s' : ''}'
                        : transfer.state,
                    style: const TextStyle(
                      fontSize: 9,
                      color: Color(0xFFA8A0B8),
                    ),
                  ),
                ],
              ),
            ],
            if (transfer.error != null)
              Padding(
                padding: const EdgeInsets.only(top: 7),
                child: Text(
                  transfer.error!,
                  style: const TextStyle(
                    color: Color(0xFFFCA5A5),
                    fontSize: 10,
                  ),
                ),
              ),
            Wrap(
              spacing: 5,
              children: <Widget>[
                if (!outgoing && transfer.state == 'pending') ...<Widget>[
                  TextButton(
                    onPressed: () => onAction('accept'),
                    child: const Text('Accept'),
                  ),
                  TextButton(
                    onPressed: () => onAction('reject'),
                    child: const Text('Reject'),
                  ),
                ],
                if (!outgoing && transfer.state == 'transferring')
                  TextButton.icon(
                    onPressed: () => onAction('pause'),
                    icon: const Icon(Icons.pause, size: 14),
                    label: const Text('Pause'),
                  ),
                if (!outgoing &&
                    (transfer.state == 'paused' || transfer.state == 'failed'))
                  TextButton.icon(
                    onPressed: () => onAction('resume'),
                    icon: const Icon(Icons.play_arrow, size: 14),
                    label: const Text('Resume'),
                  ),
                if (active)
                  TextButton.icon(
                    onPressed: () => onAction('cancel'),
                    icon: const Icon(Icons.close, size: 14),
                    label: const Text('Cancel'),
                  ),
                if (transfer.state == 'completed')
                  TextButton.icon(
                    onPressed: () => onAction('open'),
                    icon: const Icon(Icons.open_in_new, size: 14),
                    label: const Text('Open'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  static IconData _fileIcon(String mime) => mime.startsWith('image/')
      ? Icons.image_outlined
      : mime.startsWith('video/')
      ? Icons.video_file_outlined
      : mime.startsWith('audio/')
      ? Icons.audio_file_outlined
      : Icons.insert_drive_file_outlined;
  static String _bytes(int value) {
    if (value < 1024) return '$value B';
    if (value < 1048576) return '${(value / 1024).toStringAsFixed(1)} KB';
    if (value < 1073741824) return '${(value / 1048576).toStringAsFixed(1)} MB';
    return '${(value / 1073741824).toStringAsFixed(1)} GB';
  }
}
