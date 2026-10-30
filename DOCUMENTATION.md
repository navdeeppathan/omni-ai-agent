# Omni Voice AI — Architecture & End-to-End Flow

A natural voice-conversation system: the user speaks in any language, the AI detects it and replies out loud in the same language. This document covers the **Backend**, the **Frontend (web)** and the **Mobile app**, and the flow from the first tap to the saved transcript.

---

## 1. Architecture

```
 ┌───────────────────────────┐          ┌───────────────────────────┐
 │ FRONTEND (React + Vite)   │          │ MOBILE (Flutter)          │
 │ Talk tab · History tab    │          │ Permission gate · Voice   │
 │ MediaRecorder + silence   │          │ screen · record (WAV) +   │
 │ detection · speechSynthesis│         │ silence detection · TTS   │
 └─────────────┬─────────────┘          └─────────────┬─────────────┘
               │          JSON over HTTP (REST /api)   │
               └───────────────────┬───────────────────┘
                                   ▼
                  ┌──────────────────────────────────┐
                  │ BACKEND (Node.js + Express)      │  :4000
                  │ zod validation · helmet · cors   │
                  │  /agent/session   /agent/transcribe │
                  │  /agent/message   /agent/session/:id/end │
                  │  /conversations (list/get/delete)│
                  └───────────┬──────────────┬───────┘
                      SQL     │              │  HTTPS (key stays server-side)
                              ▼              ▼
                    ┌────────────────┐  ┌──────────────────────────┐
                    │  PostgreSQL    │  │ Google Gemini API        │
                    │  conversations │  │  • speech → text + lang  │
                    └────────────────┘  │  • conversational reply  │
                                        └──────────────────────────┘
```

| Design point | Detail |
|---|---|
| One backend for all clients | Web and mobile use identical endpoints. |
| Language is never configured | Gemini identifies the spoken language during transcription and replies in the same language; the reply also carries a language code so the client picks the matching text-to-speech voice. A fixed language can optionally be chosen in the web app. |
| No fixed topics | The AI is a general conversation partner. There are no intents, menus or business data. |
| Server keeps the history | The client sends only `conversationId` + the new message. The backend loads the last 16 turns from the database. |
| Gemini key is server-only | Clients never see it. |
| Consent | A session can only start with `transcriptConsent: true`. Only text is stored, never audio. |

---

## 2. Backend (`backend/`)

Files: `src/server.js` (API + Gemini), `src/db.js` (pool + schema), `src/reset-demo.js`, `test/smoke.test.js`.

### 2.1 Startup
1. `dotenv` loads `.env`. `db.js` requires `DATABASE_URL`.
2. `initDb()` creates the `conversations` table (idempotent).
3. Express starts on `PORT` (4000). CORS allows `FRONTEND_ORIGIN` (comma-separated list). JSON limit is 1 MB, and 12 MB for `/agent/transcribe` (audio).

### 2.2 Environment
`DATABASE_URL`, `DATABASE_SSL`, `DB_POOL_MAX`, `PORT`, `FRONTEND_ORIGIN`, `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-2.5-flash`).

### 2.3 Data model — `conversations`
| Column | Meaning |
|---|---|
| `id` | UUID |
| `status` | `in_progress` → `completed` |
| `language` | language code of the latest turn |
| `title` | first 80 characters of the first user message |
| `message_count` | number of messages |
| `transcript` | JSONB array of `{role, text, language?, ts}` |
| `created_at`, `ended_at` | timestamps |

### 2.4 Endpoints
| Route | What it does |
|---|---|
| `GET /api/health` | checks the DB and whether `GEMINI_API_KEY` is set |
| `POST /api/agent/session` | requires `transcriptConsent:true`; asks Gemini for a short greeting (falls back to a built-in English one); inserts a conversation; returns `{conversationId, greeting, language}` |
| `POST /api/agent/transcribe` | `{audioBase64, mimeType}` → Gemini → `{text, language}` |
| `POST /api/agent/message` | `{conversationId, message, language?}` → Gemini → `{reply, language}`; appends both turns to the transcript atomically |
| `POST /api/agent/session/:id/end` | marks the conversation completed |
| `GET /api/conversations` · `GET /api/conversations/:id` | history list / full transcript |
| `DELETE /api/conversations/:id` | removes a conversation |

### 2.5 How Gemini is used
- **Reply** (`geminiReply`): a system prompt makes the model a warm, natural voice companion. Rules: reply in the user's language and native script (switch if they switch); 1–3 short spoken-style sentences; no markdown or emojis; be honest and never claim real-world actions; never ask for sensitive data. The model must answer as JSON `{"reply","language"}`. The last 16 turns are sent as context, with the temperature at 0.8.
- **Transcription** (`geminiTranscribe`): the audio goes inline to Gemini with a request for `{"text","language"}` in the native script. Any language Gemini understands works.
- **Resilience:** transient errors (429/500/503, timeouts) are retried once. If Gemini is still unavailable, `/agent/message` returns `502 llm_unavailable`, and the clients show the error and stay usable.

---

## 3. Frontend (`frontend/src/App.tsx`)

Two tabs:
- **Talk**: language selector (Auto-detect by default, or a fixed language), consent checkbox, **Start talking**, a pulsing mic orb, the chat bubbles, a type-instead input, a hands-free toggle and **End & save**.
- **History**: lists saved conversations and expands a transcript. It also deletes them.

API base: `VITE_API_BASE` or `http://localhost:4000/api`.

**State machine** (`phase`): `idle → listening → thinking → speaking → (idle | listening again)`.

**Voice loop in the browser**
1. On start, the mic stream and an `AudioContext` are opened once and kept for the whole session.
2. `listen()` runs a `MediaRecorder`. A volume analyser stops it after about 1.4 s of silence following speech (30 s max, 10 s if nothing is heard).
3. The audio is base64-encoded and sent to `/agent/transcribe`. The returned text goes to `/agent/message`.
4. The reply is spoken with `speechSynthesis`, using a voice matching the reply's language code. Then, in hands-free mode, the app listens again automatically.
5. Tapping the orb while listening sends immediately. Tapping it while the AI speaks interrupts it.
6. An `epoch` counter cancels stale async work when the session ends.

---

## 4. Mobile (`mobile/lib/`)

- `main.dart` → `PermissionGate` → `VoiceScreen`.
- `permission_gate.dart`: consent checkbox (mic use + saving the text transcript, no audio stored), then the microphone permission (`permission_handler` on Android/iOS; the recorder's own prompt on web/Windows).
- `voice_screen.dart`: chat bubbles, one large mic button, a detected-language chip, a hands-free toggle and a backend-URL dialog.
- `api.dart`: thin `http` client (60 s timeout). Base URL comes from `--dart-define=API_BASE`, a built-in default, or the runtime dialog.

**Phases:** `starting → idle → listening → thinking → speaking → (idle | listening)`.

**Turn loop:** the `record` package captures WAV 16 kHz mono. Its amplitude stream (`onAmplitudeChanged`) is used for silence detection (above −32 dB counts as speech; auto-stop 1.4 s after the speech ends, 10 s with no speech, 30 s max). The file is sent to `/agent/transcribe`, then `/agent/message`. The reply is spoken with `flutter_tts` using the locale for the reply's language. In hands-free mode, recording restarts automatically. Tapping the mic while the AI speaks stops it and starts listening. Leaving the screen ends the session.

---

## 5. End-to-end flow, step by step

### One-time setup
1. Create the PostgreSQL database. Put `DATABASE_URL` and `GEMINI_API_KEY` in `backend/.env`.
2. `cd backend && npm install && npm run dev` (table created automatically).
3. `cd frontend && npm install && npm run dev`, or `cd mobile && flutter run`.

### A conversation (web or mobile; same steps)
| # | Where | Step |
|---|---|---|
| 1 | Client | User agrees to consent and taps **Start**. The mic permission is requested. |
| 2 | Client → Backend | `POST /agent/session {language:'auto', transcriptConsent:true}` |
| 3 | Backend → Gemini | Generates a short greeting. If that fails, a built-in one is used. |
| 4 | Backend → DB | Inserts a `conversations` row with the greeting as the first transcript entry. Returns `conversationId`, greeting and language. |
| 5 | Client | Shows and speaks the greeting, then starts listening. |
| 6 | Client | User talks. Silence detection ends the recording. |
| 7 | Client → Backend → Gemini | `POST /agent/transcribe` returns `{text, language}`, for example `{"text":"मुझे आज अकेलापन लग रहा है","language":"hi"}`. |
| 8 | Client → Backend | `POST /agent/message {conversationId, message}` |
| 9 | Backend | Loads the conversation, takes the last 16 turns, and calls Gemini with the system prompt. Gemini returns `{reply, language}`. |
| 10 | Backend → DB | Appends the user and assistant turns, updates `language`, `title`, `message_count`. |
| 11 | Backend → Client | `{reply, language}` |
| 12 | Client | Shows the reply bubble and speaks it with a voice for that language. In hands-free mode it listens again, so go back to step 6. |
| 13 | Client → Backend | **End & save** (or leaving the screen) calls `POST /agent/session/:id/end`. |
| 14 | Web | **History** tab calls `GET /conversations` and `GET /conversations/:id` to show the saved transcript. |

If the user types instead of speaking, the client skips steps 6–7 and goes straight to step 8.

---

## 6. Limits and next steps
- Turn-based, not streaming: expect a few seconds per turn. Real-time streaming (Gemini Live API / WebSocket) would be the next step for lower latency and natural barge-in.
- Speech output depends on the voices installed on the device or browser. Without one for a language, the reply is shown as text only.
- There is no authentication, rate limiting or per-user separation. All conversations are visible to anyone who can reach the API. Add auth before any public deployment.
- The mobile default backend URL in `api.dart` points to an ngrok tunnel and must be updated when the tunnel changes.
- Gemini quotas, availability and pricing apply.

## 7. Repo map
```
backend/   src/server.js · src/db.js · src/reset-demo.js · test/smoke.test.js · .env(.example)
frontend/  src/App.tsx · src/styles.css · vite.config.ts
mobile/    lib/main.dart · permission_gate.dart · voice_screen.dart · api.dart
README.md · DOCUMENTATION.md · VOICE_PROVIDER_INTEGRATION.md
```
