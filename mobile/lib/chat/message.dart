class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.conversationId,
    required this.senderId,
    required this.receiverId,
    required this.text,
    required this.timestamp,
    required this.status,
  });
  final String id;
  final String conversationId;
  final String senderId;
  final String receiverId;
  final String text;
  final int timestamp;
  final String status;

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'conversationId': conversationId,
    'senderId': senderId,
    'receiverId': receiverId,
    'text': text,
    'timestamp': timestamp,
    'status': status,
  };
  ChatMessage copyWith({String? status}) => ChatMessage(
    id: id,
    conversationId: conversationId,
    senderId: senderId,
    receiverId: receiverId,
    text: text,
    timestamp: timestamp,
    status: status ?? this.status,
  );

  static ChatMessage? tryParse(Map<String, Object?> map) {
    final id = map['id'];
    final conversation = map['conversationId'];
    final sender = map['senderId'];
    final receiver = map['receiverId'];
    final text = map['text'];
    final timestamp = map['timestamp'];
    final status = map['status'];
    if (id is! String ||
        id.length < 8 ||
        conversation is! String ||
        sender is! String ||
        receiver is! String ||
        text is! String ||
        text.isEmpty ||
        timestamp is! int ||
        status is! String)
      return null;
    return ChatMessage(
      id: id,
      conversationId: conversation,
      senderId: sender,
      receiverId: receiver,
      text: text,
      timestamp: timestamp,
      status: status,
    );
  }
}

String conversationId(String a, String b) {
  final ids = <String>[a, b]..sort();
  return ids.join(':');
}
