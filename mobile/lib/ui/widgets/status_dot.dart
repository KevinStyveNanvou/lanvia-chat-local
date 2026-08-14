import 'package:flutter/material.dart';

class StatusDot extends StatelessWidget {
  const StatusDot(this.status, {super.key});
  final String status;
  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      'connected' || 'available' => const Color(0xFF22C55E),
      'failed' => const Color(0xFFEF4444),
      'connecting' || 'pairing' || 'searching' => const Color(0xFFA78BFA),
      _ => const Color(0xFF6B6477),
    };
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        boxShadow: <BoxShadow>[
          BoxShadow(color: color.withValues(alpha: .35), blurRadius: 7),
        ],
      ),
    );
  }
}
