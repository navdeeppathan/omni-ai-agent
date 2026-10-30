import 'package:flutter/material.dart';

import 'permission_gate.dart';

void main() => runApp(const OmniVoiceApp());

class OmniVoiceApp extends StatelessWidget {
  const OmniVoiceApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Omni Voice AI',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(colorSchemeSeed: const Color(0xFF4F46E5), useMaterial3: true),
        darkTheme: ThemeData(
            colorSchemeSeed: const Color(0xFF4F46E5), brightness: Brightness.dark, useMaterial3: true),
        home: const PermissionGate(),
      );
}
