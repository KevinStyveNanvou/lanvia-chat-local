import 'package:shared_preferences/shared_preferences.dart';

import 'settings_model.dart';

class SettingsRepository {
  Future<LanviaSettings> load() async {
    final p = await SharedPreferences.getInstance();
    return LanviaSettings(
      theme: p.getString('settings.theme') ?? 'dark',
      notifications: p.getBool('settings.notifications') ?? true,
      controlPort:
          p.getInt('settings.controlPort') ??
          LanviaSettings.defaults.controlPort,
      transferPort:
          p.getInt('settings.transferPort') ??
          LanviaSettings.defaults.transferPort,
      discoveryPort:
          p.getInt('settings.discoveryPort') ??
          LanviaSettings.defaults.discoveryPort,
      downloadFolder: p.getString('settings.downloadFolder'),
    );
  }

  Future<void> save(LanviaSettings settings) async {
    final p = await SharedPreferences.getInstance();
    await Future.wait(<Future<bool>>[
      p.setString('settings.theme', settings.theme),
      p.setBool('settings.notifications', settings.notifications),
      p.setInt('settings.controlPort', settings.controlPort),
      p.setInt('settings.transferPort', settings.transferPort),
      p.setInt('settings.discoveryPort', settings.discoveryPort),
      if (settings.downloadFolder != null)
        p.setString('settings.downloadFolder', settings.downloadFolder!),
    ]);
  }
}
