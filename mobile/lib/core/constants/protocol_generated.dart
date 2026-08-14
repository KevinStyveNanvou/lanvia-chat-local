// GENERATED from protocol/lanvia-protocol.json. Do not edit. Source SHA-256: e501d13c0f5902b6b130ddb370c6f49347d70820f93108f2fad4ea5043ce9f24
abstract final class LanviaProtocol {
  static const int version = 1;
  static const String serviceType = '_lanvia._tcp';
  static const String controlPath = '/v1/control';
  static const String transferPathTemplate = '/v1/transfers/{transferId}';
  static const int controlPort = 53211;
  static const int transferPort = 53212;
  static const int discoveryPort = 53213;
  static const Map<String, int> limits = {'udpPacketBytes': 16384, 'webSocketMessageBytes': 1048576, 'textMessageBytes': 65536, 'fileBytes': 1099511627776, 'concurrentTransfers': 3, 'requestsPerMinute': 600, 'transferPortFallbackAttempts': 20};
  static const Map<String, int> intervalsMs = {'discoveryAnnouncement': 5000, 'peerExpiry': 15000, 'ping': 15000, 'networkCheck': 5000, 'progressNotification': 500};
  static const Map<String, int> timeoutsMs = {'webSocketConnect': 5000, 'webSocketHandshake': 5000, 'request': 10000, 'pairing': 60000, 'transferDecision': 120000, 'httpIdle': 30000, 'pong': 10000};
  static const List<int> reconnectBackoffMs = [1000,2000,4000,8000,16000];
  static const List<String> messageTypes = ['device_hello', 'device_info', 'pair_request', 'pair_accept', 'pair_reject', 'message_send', 'message_ack', 'transfer_request', 'transfer_accept', 'transfer_reject', 'transfer_progress', 'transfer_pause', 'transfer_resume', 'transfer_cancel', 'transfer_complete', 'transfer_error', 'ping', 'pong'];
  static const List<String> deviceTypes = ['desktop', 'mobile'];
  static const List<String> platforms = ['windows', 'macos', 'linux', 'android'];
  static const List<String> messageStatuses = ['sending', 'sent', 'delivered', 'failed'];
  static const List<String> transferStates = ['hashing', 'pending', 'accepted', 'transferring', 'paused', 'verifying', 'completed', 'rejected', 'cancelled', 'failed'];
  static const List<String> errorCodes = ['invalid_envelope', 'unsupported_version', 'unauthorized', 'not_paired', 'not_found', 'invalid_request', 'port_unavailable', 'timeout', 'offline', 'permission_denied', 'file_not_found', 'file_too_large', 'hash_mismatch', 'network_changed', 'connection_refused', 'cancelled', 'internal_error'];
  static const String sourceSha256 = 'e501d13c0f5902b6b130ddb370c6f49347d70820f93108f2fad4ea5043ce9f24';
}
