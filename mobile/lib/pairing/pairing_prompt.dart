class PairingPrompt {
  const PairingPrompt({
    required this.pairId,
    required this.peerId,
    required this.peerName,
    required this.expiresAt,
  });
  final String pairId;
  final String peerId;
  final String peerName;
  final int expiresAt;
}
