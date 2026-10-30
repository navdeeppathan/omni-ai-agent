import 'package:flutter_test/flutter_test.dart';
import 'package:omni_voice_app/main.dart';

void main() {
  testWidgets('shows permission screen first', (tester) async {
    await tester.pumpWidget(const OmniVoiceApp());
    expect(find.text('Allow microphone & continue'), findsOneWidget);
  });
}
