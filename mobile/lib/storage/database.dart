import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import '../chat/message.dart';
import '../devices/models/device.dart';
import '../transfers/transfer_model.dart';

class LanviaDatabase {
  Database? _database;

  Future<void> open() async {
    final root = await getDatabasesPath();
    _database = await openDatabase(
      p.join(root, 'lanvia.db'),
      version: 1,
      onCreate: (database, _) async {
        await database.execute(
          'CREATE TABLE trusted_devices(device_id TEXT PRIMARY KEY, last_name TEXT NOT NULL, platform TEXT NOT NULL, shared_token TEXT NOT NULL, blocked INTEGER NOT NULL, paired_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)',
        );
        await database.execute(
          'CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL, text TEXT NOT NULL, timestamp INTEGER NOT NULL, status TEXT NOT NULL)',
        );
        await database.execute(
          'CREATE INDEX messages_conversation_idx ON messages(conversation_id, timestamp)',
        );
        await database.execute(
          'CREATE TABLE transfers(transfer_id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, direction TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, local_path TEXT, state TEXT NOT NULL, bytes_transferred INTEGER NOT NULL, speed INTEGER NOT NULL, remaining_time INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT)',
        );
      },
    );
  }

  Database get db {
    final value = _database;
    if (value == null) throw StateError('Database is not open');
    return value;
  }

  Future<List<TrustedDevice>> trustedDevices() async =>
      (await db.query('trusted_devices'))
          .map(
            (row) => TrustedDevice(
              deviceId: row['device_id']! as String,
              lastName: row['last_name']! as String,
              platform: row['platform']! as String,
              sharedToken: row['shared_token']! as String,
              blocked: (row['blocked']! as int) == 1,
              pairedAt: row['paired_at']! as int,
              lastSeenAt: row['last_seen_at']! as int,
            ),
          )
          .toList();

  Future<void> saveTrusted(TrustedDevice value) =>
      db.insert('trusted_devices', <String, Object?>{
        'device_id': value.deviceId,
        'last_name': value.lastName,
        'platform': value.platform,
        'shared_token': value.sharedToken,
        'blocked': value.blocked ? 1 : 0,
        'paired_at': value.pairedAt,
        'last_seen_at': value.lastSeenAt,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
  Future<void> removeTrusted(String id) => db.delete(
    'trusted_devices',
    where: 'device_id = ?',
    whereArgs: <Object?>[id],
  );

  Future<List<ChatMessage>> messages() async =>
      (await db.query('messages', orderBy: 'timestamp ASC', limit: 10000))
          .map(
            (row) => ChatMessage(
              id: row['id']! as String,
              conversationId: row['conversation_id']! as String,
              senderId: row['sender_id']! as String,
              receiverId: row['receiver_id']! as String,
              text: row['text']! as String,
              timestamp: row['timestamp']! as int,
              status: row['status']! as String,
            ),
          )
          .toList();
  Future<void> saveMessage(ChatMessage value) =>
      db.insert('messages', <String, Object?>{
        'id': value.id,
        'conversation_id': value.conversationId,
        'sender_id': value.senderId,
        'receiver_id': value.receiverId,
        'text': value.text,
        'timestamp': value.timestamp,
        'status': value.status,
      }, conflictAlgorithm: ConflictAlgorithm.replace);

  Future<List<TransferRecord>> transfers() async => (await db.query(
    'transfers',
    orderBy: 'created_at ASC',
    limit: 2000,
  )).map(_transferFromRow).toList();
  Future<void> saveTransfer(TransferRecord value) =>
      db.insert('transfers', <String, Object?>{
        'transfer_id': value.transferId,
        'peer_id': value.peerId,
        'direction': value.direction,
        'file_name': value.fileName,
        'mime_type': value.mimeType,
        'size': value.size,
        'sha256': value.sha256,
        'local_path': value.localPath,
        'state': value.state,
        'bytes_transferred': value.bytesTransferred,
        'speed': value.speed,
        'remaining_time': value.remainingTime,
        'created_at': value.createdAt,
        'updated_at': value.updatedAt,
        'error': value.error,
      }, conflictAlgorithm: ConflictAlgorithm.replace);

  TransferRecord _transferFromRow(Map<String, Object?> row) => TransferRecord(
    transferId: row['transfer_id']! as String,
    peerId: row['peer_id']! as String,
    direction: row['direction']! as String,
    fileName: row['file_name']! as String,
    mimeType: row['mime_type']! as String,
    size: row['size']! as int,
    sha256: row['sha256']! as String,
    localPath: row['local_path'] as String?,
    state: row['state']! as String,
    bytesTransferred: row['bytes_transferred']! as int,
    speed: row['speed']! as int,
    remainingTime: row['remaining_time'] as int?,
    createdAt: row['created_at']! as int,
    updatedAt: row['updated_at']! as int,
    error: row['error'] as String?,
  );

  Future<void> close() async {
    await _database?.close();
    _database = null;
  }
}
