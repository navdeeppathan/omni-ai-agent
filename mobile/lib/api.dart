import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// Thin client for the Express backend in ../backend.
class Api {
  static const _fromEnv = String.fromEnvironment('API_BASE');

  /// Editable at runtime from the settings dialog (needed for physical phones).
  static String baseUrl = _fromEnv.isNotEmpty ? _fromEnv : _defaultBase();

  static String _defaultBase() {
    if (!kIsWeb && Platform.isAndroid)
      return 'https://unpledged-dripping-armory.ngrok-free.dev/api'; // emulator -> host
    return 'https://unpledged-dripping-armory.ngrok-free.dev/api';
  }

  static const _timeout = Duration(seconds: 60);

  static Future<Map<String, dynamic>> _send(
    String method,
    String path, [
    Object? body,
  ]) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = {'Content-Type': 'application/json'};
    final res = method == 'GET'
        ? await http.get(uri, headers: headers).timeout(_timeout)
        : await http
              .post(uri, headers: headers, body: jsonEncode(body ?? {}))
              .timeout(_timeout);
    final json = jsonDecode(utf8.decode(res.bodyBytes));
    if (res.statusCode >= 400 || json['ok'] == false) {
      throw ApiException(
        json['message'] ??
            json['error'] ??
            'Request failed (${res.statusCode})',
      );
    }
    return json as Map<String, dynamic>;
  }

  /// Starts a conversation. The language is auto-detected from what the user says.
  static Future<({String conversationId, String greeting, String language})>
  startSession() async {
    final r = await _send('POST', '/agent/session', {
      'language': 'auto',
      'transcriptConsent': true,
    });
    return (
      conversationId: r['conversationId'] as String,
      greeting: r['greeting'] as String,
      language: (r['language'] as String?) ?? 'en',
    );
  }

  static Future<void> endSession(String conversationId) =>
      _send('POST', '/agent/session/$conversationId/end');

  /// Speech -> text + detected language code (e.g. en, hi, ta, fr).
  static Future<({String text, String language})> transcribe(
    Uint8List audio,
    String mimeType,
  ) async {
    final r = await _send('POST', '/agent/transcribe', {
      'audioBase64': base64Encode(audio),
      'mimeType': mimeType,
    });
    return (
      text: (r['text'] as String?) ?? '',
      language: (r['language'] as String?) ?? 'en',
    );
  }

  /// Sends the user's text; the backend keeps the history and replies in the user's language.
  static Future<({String reply, String language})> message({
    required String conversationId,
    required String text,
  }) async {
    final r = await _send('POST', '/agent/message', {
      'conversationId': conversationId,
      'language': 'auto',
      'message': text,
    });
    return (
      reply: r['reply'] as String,
      language: (r['language'] as String?) ?? 'en',
    );
  }
}

class ApiException implements Exception {
  final String message;
  ApiException(this.message);
  @override
  String toString() => message;
}
