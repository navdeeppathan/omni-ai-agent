import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool, query, initDb } from './db.js';
import { createProviders } from './providers/index.js';

const app = express();
const PORT = Number(process.env.PORT || 4000);
const origins = (process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: origins }));
// Audio uploads (base64) need a bigger body limit than normal JSON.
app.use((req, res, next) => express.json({ limit: req.path === '/api/agent/transcribe' ? '12mb' : '1mb' })(req, res, next));

const now = () => new Date().toISOString();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const one = async (sql, params = []) => (await query(sql, params)).rows[0] || null;
const many = async (sql, params = []) => (await query(sql, params)).rows;

// ---------------------------------------------------------------- language helpers

/** "hi-IN" / "Hindi" style input -> lowercase ISO 639 code like "hi". Falls back to "en". */
function normalizeLang(code) {
  const base = String(code || '').toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : 'en';
}

function languageName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; }
  catch { return code; }
}

function parseModelJson(text) {
  try { return JSON.parse(text); } catch { /* try to salvage JSON wrapped in prose or code fences */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

// ---------------------------------------------------------------- AI providers (see providers/index.js)

const { llm, stt } = createProviders();

function systemPrompt(language) {
  const languageRule = language && language !== 'auto'
    ? `Always reply in ${languageName(language)}, written in its native script.`
    : "Detect the language of the user's latest message and reply in that same language, in its native script (if they type a language in Latin letters, such as Romanized Hindi, still reply in the language's native script). If the user switches language, switch with them.";
  return [
    'You are a warm, curious, natural-sounding voice companion. You talk with the user about anything: everyday chat, questions, ideas, advice, learning, stories, or just keeping them company.',
    languageRule,
    'Your reply is read aloud, so speak like a real person: 1-3 short, conversational sentences. No markdown, bullet lists, emojis, or special symbols. Spell out anything that would be awkward to read aloud.',
    'Match the user\'s tone and energy. Ask a short follow-up question when it helps the conversation flow, but not every time.',
    'Be honest. If you do not know something, say so. You cannot browse the internet, make calls, or take real-world actions, so never claim to have done so. Never ask for passwords, OTPs, card numbers, or other sensitive information.',
    'Respond ONLY with JSON: {"reply": string, "language": string} where "language" is the ISO 639-1 code of the language of your reply (for example "en", "hi", "ta", "te", "es", "fr").',
  ].join(' ');
}

async function llmReply({ language, message, history = [] }) {
  const turns = history.slice(-16);
  while (turns.length && turns[0].role !== 'user') turns.shift(); // providers expect the first turn to be the user's
  const { text, model } = await llm.chat({
    system: systemPrompt(language),
    messages: [...turns.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text })), { role: 'user', text: message }],
    temperature: 0.8,
    maxTokens: 1024,
    json: true,
  });
  const parsed = parseModelJson(text);
  const reply = String(parsed?.reply ?? (parsed ? '' : text)).trim();
  if (!reply) throw new Error('The model returned an empty reply');
  return { reply, language: normalizeLang(parsed?.language || (language !== 'auto' ? language : 'en')), model };
}

/** Speech-to-text with automatic language identification, via the configured STT provider. */
async function transcribe({ audioBase64, mimeType }) {
  const r = await stt.transcribe({ audioBase64, mimeType });
  if (r.raw === undefined) return { text: String(r.text || '').trim(), language: normalizeLang(r.language) };
  const parsed = parseModelJson(r.raw) || {};
  return { text: String(parsed.text || '').trim(), language: normalizeLang(parsed.language) };
}

// ---------------------------------------------------------------- routes

app.get('/api/health', wrap(async (req, res) => {
  await query('SELECT 1');
  res.json({ ok: true, service: 'omni-voice-ai', database: 'postgresql', llm: llm.configured() ? 'configured' : 'missing_api_key', provider: llm.name, model: llm.model, stt: stt.name, time: now() });
}));

const FALLBACK_GREETING = "Hi there! I'm your AI voice assistant. Talk to me in any language and I'll answer in the same one. What's on your mind?";

app.post('/api/agent/session', wrap(async (req, res) => {
  const p = z.object({
    language: z.string().min(2).max(10).default('auto'),
    transcriptConsent: z.literal(true),
  }).strict().safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ ok: false, error: 'invalid_input', details: p.error.flatten() });

  const language = p.data.language === 'auto' ? 'auto' : normalizeLang(p.data.language);
  let greeting = FALLBACK_GREETING;
  let greetingLang = language === 'auto' ? 'en' : language;
  let mode = 'fallback';
  try {
    const g = await llmReply({
      language: language === 'auto' ? 'en' : language,
      message: 'Greet me warmly in one or two short sentences. Tell me I can talk about anything and can speak in any language. Do not ask more than one question.',
    });
    greeting = g.reply; greetingLang = g.language; mode = 'ai';
  } catch (e) {
    console.error('Greeting generation failed:', e.message);
  }

  const id = randomUUID(), ts = now();
  await query(
    'INSERT INTO conversations(id,status,language,message_count,transcript,created_at) VALUES($1,$2,$3,1,$4::jsonb,$5)',
    [id, 'in_progress', greetingLang, JSON.stringify([{ role: 'assistant', text: greeting, language: greetingLang, ts }]), ts],
  );
  res.status(201).json({ ok: true, conversationId: id, greeting, language: greetingLang, mode });
}));

app.post('/api/agent/transcribe', wrap(async (req, res) => {
  const p = z.object({
    audioBase64: z.string().min(100),
    mimeType: z.string().regex(/^audio\/[\w.+-]+/),
  }).strict().safeParse(req.body);
  if (!p.success) return res.status(400).json({ ok: false, error: 'invalid_input' });
  try {
    const r = await transcribe({ audioBase64: p.data.audioBase64, mimeType: p.data.mimeType.split(';')[0] });
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('Transcription failed:', e.message);
    res.status(502).json({ ok: false, error: 'transcription_failed', message: e.message });
  }
}));

app.post('/api/agent/message', wrap(async (req, res) => {
  const p = z.object({
    conversationId: z.string().min(1),
    message: z.string().trim().min(1).max(2000),
    language: z.string().min(2).max(10).default('auto'),
  }).strict().safeParse(req.body);
  if (!p.success) return res.status(400).json({ ok: false, error: 'invalid_input', details: p.error.flatten() });

  const convo = await one('SELECT * FROM conversations WHERE id=$1', [p.data.conversationId]);
  if (!convo) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  if (convo.status !== 'in_progress') return res.status(409).json({ ok: false, error: 'conversation_ended' });

  const language = p.data.language === 'auto' ? 'auto' : normalizeLang(p.data.language);
  let result;
  try {
    result = await llmReply({ language, message: p.data.message, history: convo.transcript });
  } catch (e) {
    console.error('LLM reply failed:', e.message);
    return res.status(502).json({ ok: false, error: 'llm_unavailable', message: e.message });
  }

  const ts = now();
  await query(
    `UPDATE conversations
        SET transcript = transcript || $1::jsonb,
            language = $2,
            title = COALESCE(title, $3),
            message_count = message_count + 2
      WHERE id = $4`,
    [
      JSON.stringify([{ role: 'user', text: p.data.message, ts }, { role: 'assistant', text: result.reply, language: result.language, ts }]),
      result.language,
      p.data.message.slice(0, 80),
      convo.id,
    ],
  );
  res.json({ ok: true, reply: result.reply, language: result.language, model: result.model });
}));

app.post('/api/agent/session/:id/end', wrap(async (req, res) => {
  const convo = await one('SELECT id FROM conversations WHERE id=$1', [req.params.id]);
  if (!convo) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  await query("UPDATE conversations SET status='completed', ended_at=$1 WHERE id=$2 AND status='in_progress'", [now(), convo.id]);
  res.json({ ok: true, data: { conversationId: convo.id, status: 'completed' } });
}));

app.get('/api/conversations', wrap(async (req, res) => {
  res.json({ ok: true, data: await many('SELECT id,status,language,title,message_count,created_at,ended_at FROM conversations ORDER BY created_at DESC LIMIT 100') });
}));

app.get('/api/conversations/:id', wrap(async (req, res) => {
  const convo = await one('SELECT * FROM conversations WHERE id=$1', [req.params.id]);
  if (!convo) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  res.json({ ok: true, data: convo });
}));

app.delete('/api/conversations/:id', wrap(async (req, res) => {
  const r = await query('DELETE FROM conversations WHERE id=$1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ ok: false, error: 'conversation_not_found' });
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'internal_error', message: process.env.NODE_ENV === 'development' ? err.message : undefined });
});

await initDb();
const server = app.listen(PORT, () => console.log(`Omni Voice AI API running at http://localhost:${PORT}`));
async function shutdown() { server.close(async () => { await pool.end(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
