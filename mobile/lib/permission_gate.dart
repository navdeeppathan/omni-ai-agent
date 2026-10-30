import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:record/record.dart';

import 'voice_screen.dart';

/// Asks for microphone permission (and transcript consent) before the agent starts.
class PermissionGate extends StatefulWidget {
  const PermissionGate({super.key});

  @override
  State<PermissionGate> createState() => _PermissionGateState();
}

class _PermissionGateState extends State<PermissionGate> {
  bool _consent = false;
  bool _busy = false;
  bool _blockedForever = false;
  String? _error;

  bool get _isMobile => !kIsWeb && (Platform.isAndroid || Platform.isIOS);

  Future<void> _allow() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      bool granted;
      if (_isMobile) {
        final status = await Permission.microphone.request();
        granted = status.isGranted;
        _blockedForever = status.isPermanentlyDenied;
      } else {
        // Web / Windows: the recorder triggers the OS or browser prompt.
        final rec = AudioRecorder();
        granted = await rec.hasPermission();
        await rec.dispose();
      }
      if (!mounted) return;
      if (granted) {
        Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const VoiceScreen()));
        return;
      }
      setState(() => _error = 'Microphone access is required so the assistant can hear you.');
    } catch (e) {
      setState(() => _error = 'Could not request permission: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                CircleAvatar(
                    radius: 44,
                    backgroundColor: cs.primaryContainer,
                    child: Icon(Icons.mic, size: 44, color: cs.onPrimaryContainer)),
                const SizedBox(height: 24),
                Text('Omni Voice AI', style: Theme.of(context).textTheme.headlineMedium),
                const SizedBox(height: 12),
                const Text(
                  'Have a natural conversation with an AI about anything. '
                  'Speak in any language: it detects it automatically and replies in the same language.',
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 24),
                CheckboxListTile(
                  value: _consent,
                  onChanged: (v) => setState(() => _consent = v ?? false),
                  controlAffinity: ListTileControlAffinity.leading,
                  contentPadding: EdgeInsets.zero,
                  title: const Text(
                      'I allow microphone use and saving the text transcript of this conversation. Raw audio is not stored.'),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Text(_error!, style: TextStyle(color: cs.error), textAlign: TextAlign.center),
                ],
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: _consent && !_busy ? _allow : null,
                  icon: _busy
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.mic),
                  label: const Text('Allow microphone & continue'),
                ),
                if (_blockedForever)
                  TextButton(onPressed: openAppSettings, child: const Text('Open app settings')),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
