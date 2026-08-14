import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:lanvia_mobile/devices/repositories/identity_repository.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('identity persists its UUID and permits only name changes', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final repository = IdentityRepository();
    final first = await repository.load();
    final second = await repository.load();
    expect(second.deviceId, first.deviceId);
    final renamed = await repository.rename(second, 'Kevin Phone');
    expect(renamed.deviceId, first.deviceId);
    expect(renamed.deviceName, 'Kevin Phone');
  });
}
