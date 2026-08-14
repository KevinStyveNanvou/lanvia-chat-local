// GENERATED from protocol/lanvia-protocol.json. Do not edit. Source SHA-256: e501d13c0f5902b6b130ddb370c6f49347d70820f93108f2fad4ea5043ce9f24
export const PROTOCOL_VERSION = 1 as const;
export const SERVICE_TYPE = "_lanvia._tcp" as const;
export const CONTROL_PATH = "/v1/control" as const;
export const TRANSFER_PATH_TEMPLATE = "/v1/transfers/{transferId}" as const;
export const PORTS = {
  "control": 53211,
  "transfer": 53212,
  "discovery": 53213
} as const;
export const LIMITS = {
  "udpPacketBytes": 16384,
  "webSocketMessageBytes": 1048576,
  "textMessageBytes": 65536,
  "fileBytes": 1099511627776,
  "concurrentTransfers": 3,
  "requestsPerMinute": 600,
  "transferPortFallbackAttempts": 20
} as const;
export const INTERVALS_MS = {
  "discoveryAnnouncement": 5000,
  "peerExpiry": 15000,
  "ping": 15000,
  "networkCheck": 5000,
  "progressNotification": 500
} as const;
export const TIMEOUTS_MS = {
  "webSocketConnect": 5000,
  "webSocketHandshake": 5000,
  "request": 10000,
  "pairing": 60000,
  "transferDecision": 120000,
  "httpIdle": 30000,
  "pong": 10000
} as const;
export const RECONNECT_BACKOFF_MS = [1000,2000,4000,8000,16000] as const;
export const MESSAGE_TYPES = [
  "device_hello",
  "device_info",
  "pair_request",
  "pair_accept",
  "pair_reject",
  "message_send",
  "message_ack",
  "transfer_request",
  "transfer_accept",
  "transfer_reject",
  "transfer_progress",
  "transfer_pause",
  "transfer_resume",
  "transfer_cancel",
  "transfer_complete",
  "transfer_error",
  "ping",
  "pong"
] as const;
export type MessageType = typeof MESSAGE_TYPES[number];
export const DEVICE_TYPES = ["desktop","mobile"] as const;
export const PLATFORMS = ["windows","macos","linux","android"] as const;
export const MESSAGE_STATUSES = ["sending","sent","delivered","failed"] as const;
export const TRANSFER_STATES = [
  "hashing",
  "pending",
  "accepted",
  "transferring",
  "paused",
  "verifying",
  "completed",
  "rejected",
  "cancelled",
  "failed"
] as const;
export const ERROR_CODES = [
  "invalid_envelope",
  "unsupported_version",
  "unauthorized",
  "not_paired",
  "not_found",
  "invalid_request",
  "port_unavailable",
  "timeout",
  "offline",
  "permission_denied",
  "file_not_found",
  "file_too_large",
  "hash_mismatch",
  "network_changed",
  "connection_refused",
  "cancelled",
  "internal_error"
] as const;
export const PROTOCOL_SOURCE_SHA256 = "e501d13c0f5902b6b130ddb370c6f49347d70820f93108f2fad4ea5043ce9f24" as const;
