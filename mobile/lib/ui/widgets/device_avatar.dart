import 'package:flutter/material.dart';

class DeviceAvatar extends StatelessWidget {
  const DeviceAvatar({required this.mobile, this.size = 48, super.key});
  final bool mobile;
  final double size;
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(size * .3),
      gradient: const LinearGradient(
        colors: <Color>[Color(0x553B0764), Color(0x445B21B6)],
      ),
      border: Border.all(color: const Color(0x337C3AED)),
    ),
    child: Icon(
      mobile ? Icons.smartphone_rounded : Icons.laptop_windows_rounded,
      color: const Color(0xFFC4B5FD),
      size: size * .45,
    ),
  );
}
