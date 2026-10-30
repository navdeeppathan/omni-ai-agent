import { requestJson } from './http.js';

/** Native Anthropic Messages API. Chat only: Anthropic has no speech-to-text, so set STT_* to another service. */
export function createAnthropic({ apiKey, model = 'claude-haiku-5-5', baseUrl }) {
  return {
    name: 'anthropic',
    model,
    configured: () => Boolean(apiKey),

    async chat({ system, messages, temperature = 0.8, maxTokens = 1024 }) {
      if (!apiKey) throw new Error('No API key configured (set AI_API_KEY)');
      const payload = await requestJson('Anthropic', `${baseUrl}/v1/messages`, () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          ...(system && { system }),
          messages: messages.map(m => ({ role: m.role, content: m.text })),
        }),
      }), { timeoutMs: 15000 });
      const text = (payload?.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (!text) throw new Error('Anthropic returned an empty response');
      return { text, model };
    },
  };
}
