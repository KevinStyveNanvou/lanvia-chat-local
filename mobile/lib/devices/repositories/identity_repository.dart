import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import '../../core/constants/protocol_generated.dart';
import '../models/device.dart';

class IdentityRepository {
  static const _idKey = 'identity.deviceId';
  static const _nameKey = 'identity.deviceName';

  Future<DeviceIdentity> load() async {
    final preferences = await SharedPreferences.getInstance();
    var id = preferences.getString(_idKey);
    if (id == null || id.length < 8) {
      id = const Uuid().v4();
      await preferences.setString(_idKey, id);
    }
    final name = (preferences.getString(_nameKey) ?? 'Android Phone').trim();
    return DeviceIdentity(
      deviceId: id,
      deviceName: name.isEmpty ? 'Android Phone' : name,
      deviceType: 'mobile',
      platform: 'android',
      appVersion: '1.0.1',
      protocolVersion: '${LanviaProtocol.version}',
    );
  }

  Future<DeviceIdentity> rename(DeviceIdentity current, String value) async {
    final name = value.trim();
    if (name.isEmpty || name.length > 80)
      throw ArgumentError('Device name must contain 1 to 80 characters');
    final preferences = await SharedPreferences.getInstance();
    await preferences.setString(_nameKey, name);
    return DeviceIdentity(
      deviceId: current.deviceId,
      deviceName: name,
      deviceType: current.deviceType,
      platform: current.platform,
      appVersion: current.appVersion,
      protocolVersion: current.protocolVersion,
    );
  }
}
