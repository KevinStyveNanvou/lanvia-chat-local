const Map<String, Set<String>> transferTransitions = <String, Set<String>>{
  'hashing': <String>{'pending', 'failed'},
  'pending': <String>{'accepted', 'rejected', 'cancelled', 'failed'},
  'accepted': <String>{'transferring', 'cancelled', 'failed'},
  'transferring': <String>{'paused', 'verifying', 'cancelled', 'failed'},
  'paused': <String>{'transferring', 'cancelled', 'failed'},
  'verifying': <String>{'completed', 'failed'},
};
bool validTransferTransition(String from, String to) =>
    from == to || (transferTransitions[from]?.contains(to) ?? false);

class TransferRecord {
  const TransferRecord({
    required this.transferId,
    required this.peerId,
    required this.direction,
    required this.fileName,
    required this.mimeType,
    required this.size,
    required this.sha256,
    required this.state,
    required this.bytesTransferred,
    required this.speed,
    required this.remainingTime,
    required this.createdAt,
    required this.updatedAt,
    this.localPath,
    this.error,
  });
  final String transferId;
  final String peerId;
  final String direction;
  final String fileName;
  final String mimeType;
  final int size;
  final String sha256;
  final String? localPath;
  final String state;
  final int bytesTransferred;
  final int speed;
  final int? remainingTime;
  final int createdAt;
  final int updatedAt;
  final String? error;

  TransferRecord copyWith({
    String? state,
    int? bytesTransferred,
    int? speed,
    int? remainingTime,
    String? localPath,
    String? sha256,
    String? error,
    bool clearError = false,
  }) => TransferRecord(
    transferId: transferId,
    peerId: peerId,
    direction: direction,
    fileName: fileName,
    mimeType: mimeType,
    size: size,
    sha256: sha256 ?? this.sha256,
    localPath: localPath ?? this.localPath,
    state: state ?? this.state,
    bytesTransferred: bytesTransferred ?? this.bytesTransferred,
    speed: speed ?? this.speed,
    remainingTime: remainingTime ?? this.remainingTime,
    createdAt: createdAt,
    updatedAt: DateTime.now().millisecondsSinceEpoch,
    error: clearError ? null : error ?? this.error,
  );
}
