# Omni Voice AI — natural multilingual voice conversation

Talk to an AI agent the way you'd talk to a person. Speak in **any language**: it detects the language automatically, understands you, and answers out loud in the same language. There are no menus and no fixed topics.

Three clients share one backend:

| Part | Tech | What it is |
|---|---|---|
| `backend/` | Node.js, Express, PostgreSQL, pluggable AI (Gemini, OpenAI, Claude) | Speech-to-text + language detection, conversation, saving transcripts |
| `frontend/` | React, TypeScript, Vite | Web app: hands-free voice chat + conversation history |
| `mobile/` | Flutter | Android / iOS / Windows / Web voice client |

See [DOCUMENTATION.md](DOCUMENTATION.md) for the architecture and the step-by-step flow.

## Prerequisites
- Node.js 20+, npm
- PostgreSQL 14+ (local or hosted, e.g. Neon)
- An API key for one AI provider (default Gemini, from [Google AI Studio](https://aistudio.google.com/apikey))
- Flutter SDK (only for the mobile app)

## 1. Backend

```powershell
cd backend
Copy-Item .env.example .env     # then edit .env
npm install
npm run dev
```

In `backend/.env` set `DATABASE_URL` and the AI settings `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` (plus `STT_API_KEY`, `STT_MODEL`, `STT_BASE_URL` if speech-to-text comes from a different service). Gemini, OpenAI, Anthropic and any OpenAI-compatible service (Groq, OpenRouter, Ollama...) work; `.env.example` has ready-to-copy values. The API key stays on the server only. On startup the backend creates the `conversations` table. Check `http://localhost:4000/api/health`.

## 2. Web app

```powershell
cd frontend
npm install
npm run dev        # http://localhost:5173
```

Use `http://localhost:5173` or HTTPS, because browsers block the microphone on other insecure origins. To point at another backend, set `VITE_API_BASE` (for example `http://192.168.1.10:4000/api`).

**Using it:** pick *Auto-detect* (or a fixed language), tick the consent box, press **Start talking** and just speak. When you stop talking, the app transcribes you, the AI replies, speaks the reply, and starts listening again (hands-free). Tap the orb to interrupt or to speak manually. You can also type. **End & save** stores the conversation under **History**.

## 3. Mobile app

```powershell
cd mobile
flutter run -d <android-device-or-windows-or-chrome>
```

The app asks for microphone permission, then you simply talk. The backend URL is set in [mobile/lib/api.dart](mobile/lib/api.dart) (or pass `--dart-define=API_BASE=http://<host>:4000/api`). It can also be changed at runtime from the settings icon, e.g. `http://192.168.1.10:4000/api` for a phone on the same Wi-Fi, or `http://10.0.2.2:4000/api` for the Android emulator. Flutter *web* must run on port 5173 to pass the backend's CORS check.

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | DB + LLM configuration check |
| `POST /api/agent/session` | Start a conversation (`{language:'auto', transcriptConsent:true}`) → greeting |
| `POST /api/agent/transcribe` | Audio (base64) → `{text, language}` |
| `POST /api/agent/message` | `{conversationId, message}` → `{reply, language}` (history is kept server-side) |
| `POST /api/agent/session/:id/end` | Finish and save |
| `GET /api/conversations`, `GET /api/conversations/:id` | History and transcripts |
| `DELETE /api/conversations/:id` | Delete a conversation |

## Commands (from `backend/`)

```powershell
npm test               # needs the API running on :4000
npm run reset-demo     # clears saved conversations and drops the old order/delivery tables
```

> `reset-demo` is destructive. Do not run it against a database containing data you want to keep. If you ran the earlier order/delivery version of this project, it removes those leftover tables.

## Notes and limits
- Turn-based, not streaming. Each turn is record → transcribe → reply → speak, typically a few seconds.
- Only text is saved, never raw audio. Consent is required to start a session.
- Spoken replies use the device's own voices. If none is installed for a language, the reply is shown as text. Install a voice in the OS speech settings.
- Your AI provider's quotas, availability and pricing apply. Temporary overloads and rate limits are retried once.
- There is no authentication or rate limiting. Do not expose this publicly without adding them and reviewing privacy rules.
