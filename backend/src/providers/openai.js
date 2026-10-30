import { requestJson, languageCodeFromName } from './http.js';

const EXTENSIONS = { webm: 'webm', ogg: 'ogg', mp4: 'mp4', m4a: 'm4a', mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', wave: 'wav', flac: 'flac' };

/**
 * OpenAI and any OpenAI-compatible API (Groq, OpenRouter, Together, Ollama, LM Studio, vLLM, Gemini's /openai endpoint...).
 * The same client serves chat (/chat/completions) and speech-to-text (/audio/transcriptions).
 */
export function createOpenAI({ apiKey, model, baseUrl, jsonMode = true }) {
  const isOpenAI = baseUrl === 'https://api.openai.com/v1';
  model = model || (isOpenAI ? 'gpt-4o-mini' : undefined);
  // Local servers (Ollama etc.) accept any key; hosted services need a real one.
  const isLocal = /\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(baseUrl);
  const key = apiKey || (isLocal ? 'not-needed' : '');
  const headers = () => {
    if (!key) throw new Error('No API key configured (set AI_API_KEY, or STT_API_KEY for speech-to-text)');
    return { Authorization: `Bearer ${key}` };
  };
  const needModel = () => {
    if (!model) throw new Error('No model configured (set AI_MODEL, or STT_MODEL for speech-to-text)');
    return model;
  };

  return {
    name: 'openai-compatible',
    model,
    configured: () => Boolean(key),

    async chat({ system, messages, temperature = 0.8, maxTokens = 1024, json = false }) {
      const auth = { 'Content-Type': 'application/json', ...headers() };
      const m = needModel();
      const payload = await requestJson('AI', `${baseUrl}/chat/completions`, () => ({
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          model: m,
          messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map(x => ({ role: x.role, content: x.text }))],
          temperature,
          // OpenAI's newer models reject max_tokens; most compatible servers only know max_tokens.
          [isOpenAI ? 'max_completion_tokens' : 'max_tokens']: maxTokens,
          ...(json && jsonMode && { response_format: { type: 'json_object' } }),
        }),
      }), { timeoutMs: 15000 });
      const text = String(payload?.choices?.[0]?.message?.content ?? '').trim();
      if (!text) throw new Error('The AI returned an empty response');
      return { text, model: m };
    },

    async transcribe({ audioBase64, mimeType }) {
      const auth = headers();
      const m = model || 'whisper-1';
      const ext = EXTENSIONS[mimeType.split('/')[1]] || 'webm';
      const payload = await requestJson('Transcription', `${baseUrl}/audio/transcriptions`, () => {
        const form = new FormData();
        form.append('file', new Blob([Buffer.from(audioBase64, 'base64')], { type: mimeType }), `audio.${ext}`);
        form.append('model', m);
        // verbose_json also reports the detected language (whisper models); newer ones only support json.
        form.append('response_format', /whisper/i.test(m) ? 'verbose_json' : 'json');
        return { method: 'POST', headers: auth, body: form };
      }, { timeoutMs: 30000 });
      return { text: String(payload?.text || '').trim(), language: languageCodeFromName(payload?.language) };
    },
  };
}
