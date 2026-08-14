import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;

String sanitizeFileName(String value) {
  var name = p
      .basename(value)
      .replaceAll(RegExp(r'[<>:"/\\|?*\x00-\x1F]'), '_')
      .replaceAll(RegExp(r'[. ]+$'), '')
      .trim();
  if (name.isEmpty || name == '.' || name == '..') name = 'LANVIA-file';
  return name.length > 180 ? name.substring(0, 180) : name;
}

Future<String> sha256File(String path) async {
  final digest = await sha256.bind(File(path).openRead()).first;
  return digest.toString();
}

Future<({String finalPath, String partPath})> safeDestination(
  Directory root,
  String requestedName,
) async {
  await root.create(recursive: true);
  final safe = sanitizeFileName(requestedName);
  final extension = p.extension(safe);
  final base = p.basenameWithoutExtension(safe);
  for (var index = 0; index < 10000; index++) {
    final suffix = index == 0 ? '' : ' ($index)';
    final finalPath = p.join(root.path, '$base$suffix$extension');
    final partPath = '$finalPath.lanvia.part';
    if (!p.isWithin(root.path, finalPath) || !p.isWithin(root.path, partPath))
      throw const FileSystemException('Unsafe destination');
    if (!await File(finalPath).exists() && !await File(partPath).exists())
      return (finalPath: finalPath, partPath: partPath);
  }
  throw const FileSystemException('No destination name available');
}
