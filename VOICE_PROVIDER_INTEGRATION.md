# Voice and LLM provider notes

This project uses Google Gemini for both speech-to-text (with automatic language detection) and the conversational replies. Text-to-speech uses the voices built into the browser or phone. It does not place telephone calls.

## Configure Gemini

1. Create an API key at https://aistudio.google.com/apikey.
2. Copy `backend/.env.example` to `backend/.env`.
3. Set `GEMINI_API_KEY` and, if desired, `GEMINI_MODEL`.
4. Restart the backend.

Keep the key on the server only. Quotas, pricing and model availability are set by Google.

## Current limitations

- Turn-based (record → transcribe → reply → speak), not real-time streaming.
- Speech synthesis quality and language coverage depend on the OS and browser voices.
- If Gemini is overloaded, a turn is retried once and then reported as an error.

## Possible upgrades

- **Lower latency / natural interruption:** switch to the Gemini Live API over WebSocket for streaming audio in and out.
- **Higher-quality voices:** replace on-device TTS with a cloud TTS service called from the backend.
- **Telephony:** a provider such as Twilio could bridge phone calls to the same `/agent/*` flow. That needs authentication, webhook validation and consent and regulatory review.
