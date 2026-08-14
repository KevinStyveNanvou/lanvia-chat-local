import '../core/constants/protocol_generated.dart';

class LanviaSettings {
  const LanviaSettings({
    required this.theme,
    required this.notifications,
    required this.controlPort,
    required this.transferPort,
    required this.discoveryPort,
    this.downloadFolder,
  });
  final String theme;
  final bool notifications;
  final int controlPort;
  final int transferPort;
  final int discoveryPort;
  final String? downloadFolder;

  static const defaults = LanviaSettings(
    theme: 'dark',
    notifications: true,
    controlPort: LanviaProtocol.controlPort,
    transferPort: LanviaProtocol.transferPort,
    discoveryPort: LanviaProtocol.discoveryPort,
  );

  LanviaSettings copyWith({
    String? theme,
    bool? notifications,
    int? controlPort,
    int? transferPort,
    int? discoveryPort,
    String? downloadFolder,
  }) => LanviaSettings(
    theme: theme ?? this.theme,
    notifications: notifications ?? this.notifications,
    controlPort: controlPort ?? this.controlPort,
    transferPort: transferPort ?? this.transferPort,
    discoveryPort: discoveryPort ?? this.discoveryPort,
    downloadFolder: downloadFolder ?? this.downloadFolder,
  );
}
