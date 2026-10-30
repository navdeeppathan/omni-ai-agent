import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'api.dart';

enum _Phase { starting, idle, listening, thinking, speaking }

class _Msg {
  final bool user;
  final String text;
  _Msg(this.user, this.text);
}

const _langLabels = {
  'en': 'English', 'hi': 'हिन्दी', 'ta': 'தமிழ்', 'te': 'తెలుగు', 'bn': 'বাংলা', 'mr': 'मराठी',
  'gu': 'ગુજરાતી', 'kn': 'ಕನ್ನಡ', 'ml': 'മലയാളം', 'pa': 'ਪੰਜਾਬੀ', 'ur': 'اردو', 'es': 'Español',
  'fr': 'Français', 'de': 'Deutsch', 'pt': 'Português', 'ar': 'العربية', 'ja': '日本語', 'ko': '한국어', 'zh': '中文',
};
// Region hints so the OS picks a sensible voice; unknown codes fall back to the bare language code.
const _ttsLocales = {
  'en': 'en-IN', 'hi': 'hi-IN', 'ta': 'ta-IN', 'te': 'te-IN', 'bn': 'bn-IN', 'mr': 'mr-IN', 'gu': 'gu-IN',
  'kn': 'kn-IN', 'ml': 'ml-IN', 'pa': 'pa-IN', 'ur': 'ur-PK', 'es': 'es-ES', 'fr': 'fr-FR', 'de': 'de-DE',
  'pt': 'pt-BR', 'ar': 'ar-SA', 'ja': 'ja-JP', 'ko': 'ko-KR', 'zh': 'zh-CN',
};

// Voice-activity detection: auto-stop recording once the user stops talking.
const _voiceDb = -32.0; // amplitude (dBFS) above which we treat the mic as hearing speech
const _silenceAfterSpeech = Duration(milliseconds: 1400);
const _noSpeechTimeout = Duration(seconds: 10);
const _maxRecording = Duration(seconds: 30);

class VoiceScreen extends StatefulWidget {
  const VoiceScreen({super.key});

  @override
  State<VoiceScreen> createState() => _VoiceScreenState();
}

class _VoiceScreenState extends State<VoiceScreen> {
  final _recorder = AudioRecorder();
  final _tts = FlutterTts();
  final _scroll = ScrollController();
  final _messages = <_Msg>[];

  _Phase _phase = _Phase.starting;
  String? _error;
  String? _conversationId;
  String? _detectedLang;
  bool _handsFree = true;
  bool _resumeAfterInterrupt = false;

  Timer? _maxTimer;
  StreamSubscription<Amplitude>? _ampSub;
  bool _heardSpeech = false;
  DateTime _lastVoice = DateTime.now();
  DateTime _recStart = DateTime.now();

  @override
  void initState() {
    super.initState();
    _tts.awaitSpeakCompletion(true);
    _start();
  }

  @override
  void dispose() {
    _maxTimer?.cancel();
    _ampSub?.cancel();
    _recorder.dispose();
    _tts.stop();
    final id = _conversationId;
    if (id != null) Api.endSession(id).then((_) {}, onError: (_) {});
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    setState(() {
      _phase = _Phase.starting;
      _error = null;
    });
    try {
      final s = await Api.startSession();
      _conversationId = s.conversationId;
      _detectedLang = s.language;
      _add(_Msg(false, s.greeting));
      await _speakThenListen(s.greeting, s.language);
    } catch (e) {
      if (mounted) setState(() => _error = 'Cannot reach the backend at ${Api.baseUrl}\n$e');
    } finally {
      if (mounted && _phase == _Phase.starting) setState(() => _phase = _Phase.idle);
    }
  }

  void _add(_Msg m) {
    if (!mounted) return;
    setState(() => _messages.add(m));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent + 80,
            duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
      }
    });
  }

  /// Speaks the reply, then goes straight back to listening (hands-free) or after a tap-interrupt.
  Future<void> _speakThenListen(String text, String lang) async {
    if (!mounted) return;
    setState(() => _phase = _Phase.speaking);
    try {
      await _tts.setLanguage(_ttsLocales[lang] ?? lang);
      await _tts.speak(text);
    } catch (_) {
      // Voice missing for this language: the reply is still shown as text.
    }
    if (!mounted) return;
    setState(() => _phase = _Phase.idle);
    final interrupted = _resumeAfterInterrupt;
    _resumeAfterInterrupt = false;
    if ((_handsFree || interrupted) && _conversationId != null) _startRecording();
  }

  Future<void> _onMicTap() async {
    switch (_phase) {
      case _Phase.idle:
        return _startRecording();
      case _Phase.listening:
        return _stopAndSend(manual: true);
      case _Phase.speaking:
        _resumeAfterInterrupt = true; // barge-in: stop talking and listen
        await _tts.stop();
      default:
    }
  }

  Future<void> _startRecording() async {
    if (_phase == _Phase.listening || _phase == _Phase.thinking) return;
    try {
      if (!await _recorder.hasPermission()) {
        setState(() => _error = 'Microphone permission was revoked. Enable it in system settings.');
        return;
      }
      const cfg = RecordConfig(encoder: AudioEncoder.wav, sampleRate: 16000, numChannels: 1);
      var path = '';
      if (!kIsWeb) {
        final dir = await getTemporaryDirectory();
        path = '${dir.path}/turn_${DateTime.now().millisecondsSinceEpoch}.wav';
      }
      await _recorder.start(cfg, path: path);
      _heardSpeech = false;
      _recStart = _lastVoice = DateTime.now();
      _ampSub?.cancel();
      _ampSub = _recorder.onAmplitudeChanged(const Duration(milliseconds: 150)).listen((a) {
        final now = DateTime.now();
        if (a.current > _voiceDb) {
          _heardSpeech = true;
          _lastVoice = now;
        }
        if (_heardSpeech && now.difference(_lastVoice) > _silenceAfterSpeech) {
          _stopAndSend();
        } else if (!_heardSpeech && now.difference(_recStart) > _noSpeechTimeout) {
          _stopAndSend();
        }
      });
      setState(() {
        _error = null;
        _phase = _Phase.listening;
      });
      _maxTimer?.cancel();
      _maxTimer = Timer(_maxRecording, () => _stopAndSend(manual: true));
    } catch (e) {
      setState(() => _error = 'Could not start recording: $e');
    }
  }

  /// [manual] = the user tapped stop, so send the audio even if no speech was detected.
  Future<void> _stopAndSend({bool manual = false}) async {
    if (_phase != _Phase.listening) return;
    _maxTimer?.cancel();
    _ampSub?.cancel();
    final heard = _heardSpeech || manual;
    setState(() => _phase = heard ? _Phase.thinking : _Phase.idle);
    try {
      final path = await _recorder.stop();
      if (path == null) throw ApiException('No audio recorded.');
      final bytes = kIsWeb ? await http.readBytes(Uri.parse(path)) : await File(path).readAsBytes();
      if (!kIsWeb) File(path).delete().ignore();
      if (!heard) {
        if (mounted) setState(() => _error = 'I did not hear anything. Tap the mic when you are ready.');
        return;
      }

      final said = await Api.transcribe(bytes, 'audio/wav');
      if (said.text.trim().isEmpty) {
        if (!mounted) return;
        setState(() {
          _error = "I couldn't make that out. Please try again.";
          _phase = _Phase.idle;
        });
        if (_handsFree) _startRecording();
        return;
      }
      _detectedLang = said.language;
      _add(_Msg(true, said.text));

      final r = await Api.message(conversationId: _conversationId!, text: said.text);
      _detectedLang = r.language;
      _add(_Msg(false, r.reply));
      await _speakThenListen(r.reply, r.language);
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _phase = _Phase.idle;
        });
      }
    }
  }

  Future<void> _editServer() async {
    final c = TextEditingController(text: Api.baseUrl);
    final url = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Backend URL'),
        content: TextField(
            controller: c,
            decoration: const InputDecoration(helperText: 'e.g. http://192.168.1.10:4000/api (phone on same Wi-Fi)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, c.text.trim()), child: const Text('Save')),
        ],
      ),
    );
    if (url != null && url.isNotEmpty) {
      Api.baseUrl = url.replaceAll(RegExp(r'/+$'), '');
      _conversationId = null;
      _messages.clear();
      _start();
    }
  }

  String get _status => switch (_phase) {
        _Phase.starting => 'Connecting…',
        _Phase.idle => 'Tap the mic and talk',
        _Phase.listening => 'Listening… just talk',
        _Phase.thinking => 'Thinking…',
        _Phase.speaking => 'Speaking… tap to interrupt',
      };

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final listening = _phase == _Phase.listening;
    final busy = _phase == _Phase.starting || _phase == _Phase.thinking;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Omni Voice AI'),
        actions: [
          if (_detectedLang != null)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Chip(
                  avatar: const Icon(Icons.translate, size: 16),
                  label: Text(_langLabels[_detectedLang] ?? _detectedLang!.toUpperCase())),
            ),
          IconButton(
            onPressed: () => setState(() => _handsFree = !_handsFree),
            icon: Icon(_handsFree ? Icons.hearing : Icons.touch_app),
            tooltip: _handsFree ? 'Hands-free: on' : 'Hands-free: off (tap mic each turn)',
          ),
          IconButton(onPressed: _editServer, icon: const Icon(Icons.settings_ethernet), tooltip: 'Backend URL'),
        ],
      ),
      body: Column(children: [
        Expanded(
          child: _messages.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Text(
                      'Talk about anything, in any language.\nI will reply in yours.',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                )
              : ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.all(16),
                  itemCount: _messages.length,
                  itemBuilder: (_, i) {
                    final m = _messages[i];
                    return Align(
                      alignment: m.user ? Alignment.centerRight : Alignment.centerLeft,
                      child: Container(
                        margin: const EdgeInsets.symmetric(vertical: 4),
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
                        decoration: BoxDecoration(
                          color: m.user ? cs.primaryContainer : cs.surfaceContainerHighest,
                          borderRadius: BorderRadius.circular(16),
                        ),
                        child: Text(m.text, style: const TextStyle(fontSize: 16)),
                      ),
                    );
                  },
                ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Column(children: [
              Text(_error!, style: TextStyle(color: cs.error), textAlign: TextAlign.center),
              if (_conversationId == null && !busy) TextButton(onPressed: _start, child: const Text('Retry')),
            ]),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
          child: Column(children: [
            Text(_status),
            const SizedBox(height: 14),
            AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              padding: EdgeInsets.all(listening ? 10 : 0),
              decoration: BoxDecoration(shape: BoxShape.circle, color: listening ? cs.error.withAlpha(50) : null),
              child: SizedBox(
                width: 84,
                height: 84,
                child: FloatingActionButton(
                  heroTag: 'mic',
                  shape: const CircleBorder(),
                  backgroundColor: listening ? cs.error : cs.primary,
                  foregroundColor: listening ? cs.onError : cs.onPrimary,
                  onPressed: busy || _conversationId == null ? null : _onMicTap,
                  child: busy
                      ? const CircularProgressIndicator()
                      : Icon(listening ? Icons.stop : (_phase == _Phase.speaking ? Icons.volume_up : Icons.mic),
                          size: 38),
                ),
              ),
            ),
          ]),
        ),
      ]),
    );
  }
}
