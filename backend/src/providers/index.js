import { createGemini } from './gemini.js';
import { createOpenAI } from './openai.js';
import { createAnthropic } from './anthropic.js';

/**
 * Configuration is just a key, a model and a base URL, for chat (AI_*) and for speech-to-text (STT_*):
 *   AI_API_KEY, AI_MODEL, AI_BASE_URL
 *   STT_API_KEY, STT_MODEL, STT_BASE_URL   (each defaults to the AI_* value)
 *
 * The API flavour is detected from the base URL:
 *   generativelanguage.googleapis.com (not /openai)  -> native Gemini
 *   api.anthropic.com                                -> native Anthropic (chat only)
 *   anything else                                    -> OpenAI-compatible (OpenAI, Groq, OpenRouter, Ollama, ...)
 *
 * To add a provider with its own API shape: write src/providers/<name>.js exporting a factory
 *   ({ apiKey, model, baseUrl }) => { name, model, configured(), chat({ system, messages, temperature, maxTokens, json }),
 *                                     transcribe?({ audioBase64, mimeType }) }
 * and add a rule to detect() below.
 */
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function detect(baseUrl) {
  if (/generativelanguage\.googleapis\.com/.test(baseUrl) && !/\/openai/.test(baseUrl)) return { kind: 'gemini', create: createGemini };
  if (/api\.anthropic\.com/.test(baseUrl)) return { kind: 'anthropic', create: createAnthropic };
  return { kind: 'openai', create: createOpenAI };
}

function build({ apiKey, model, baseUrl, jsonMode }) {
  const url = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const { create } = detect(url);
  return create({ apiKey: apiKey?.trim(), model: model?.trim() || undefined, baseUrl: url, jsonMode });
}

export function createProviders(env = process.env) {
  // GEMINI_API_KEY / GEMINI_MODEL still work, so existing .env files keep running.
  const aiKey = env.AI_API_KEY || env.GEMINI_API_KEY;
  const aiBase = env.AI_BASE_URL || DEFAULT_BASE_URL;
  const aiModel = env.AI_MODEL || (detect(aiBase).kind === 'gemini' ? env.GEMINI_MODEL : undefined);
  const jsonMode = env.AI_JSON_MODE !== 'false';
  const llm = build({ apiKey: aiKey, model: aiModel, baseUrl: aiBase, jsonMode });

  const sttCustom = Boolean(env.STT_API_KEY || env.STT_MODEL || env.STT_BASE_URL);
  // Without STT_* settings, Gemini transcribes with its chat model; OpenAI-style services need a transcription model.
  const sttBase = env.STT_BASE_URL || aiBase;
  const stt = sttCustom || detect(sttBase).kind === 'openai'
    ? build({ apiKey: env.STT_API_KEY || aiKey, model: env.STT_MODEL || (detect(sttBase).kind === 'openai' ? 'whisper-1' : undefined), baseUrl: sttBase })
    : llm;
  if (!stt.transcribe) {
    throw new Error('The AI_BASE_URL provider has no speech-to-text. Set STT_BASE_URL, STT_API_KEY and STT_MODEL (e.g. https://api.openai.com/v1 and whisper-1).');
  }
  return { llm, stt };
}
