import 'package:flutter_test/flutter_test.dart';
import 'package:lanvia_mobile/chat/message.dart';

void main() {
  test('message serialization and conversation IDs are identical in both directions', () {
    const message = ChatMessage(
      id: '123e4567-e89b-12d3-a456-426614174000',
      conversationId: 'a:b',
      senderId: 'a-device',
      receiverId: 'b-device',
      text: 'Hello from LANVIA',
      timestamp: 1786723200000,
      status: 'sent',
    );
    expect(ChatMessage.tryParse(message.toJson())?.text, 'Hello from LANVIA');
    expect(conversationId('b', 'a'), 'a:b');
  });
}
