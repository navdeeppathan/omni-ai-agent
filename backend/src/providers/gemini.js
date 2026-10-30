import { requestJson } from './http.js';

const TRANSCRIBE_PROMPT = 'Transcribe this speech exactly as spoken, in the native script of the language spoken (any language). Return JSON: {"text": string, "language": string} where "language" is the ISO 639-1 code of the spoken language. If there is no clear speech, return {"text":"","language":"en"}.';

/** Native Gemini API (generateContent). */
export function createGemini({ apiKey, model = 'gemini-2.5-flash', baseUrl }) {
  async function generate(body, timeoutMs) {
    if (!apiKey) throw new Error('No API key configured (set AI_API_KEY)');
    const generationConfig = { ...body.generationConfig };
    // Gemini 2.5 "thinking" tokens count against maxOutputTokens and can truncate non-Latin replies.
    if (/2\.5-flash/.test(model) && !/lite/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const payload = await requestJson('Gemini', url, () => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ ...body, generationConfig }),
    }), { timeoutMs });
    const text = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned an empty response');
    return text;
  }

  return {
    name: 'gemini',
    model,
    configured: () => Boolean(apiKey),

    async chat({ system, messages, temperature = 0.8, maxTokens = 1024, json = false }) {
      const text = await generate({
        ...(system && { systemInstruction: { parts: [{ text: system }] } }),
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
        generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json && { responseMimeType: 'application/json' }) },
      }, 15000);
      return { text, model };
    },

    /** Gemini transcribes by prompt, so it returns JSON text for the caller to parse. */
    async transcribe({ audioBase64, mimeType }) {
      const text = await generate({
        contents: [{ role: 'user', parts: [{ text: TRANSCRIBE_PROMPT }, { inlineData: { mimeType, data: audioBase64 } }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: 'application/json' },
      }, 30000);
      return { raw: text };
    },
  };
}
