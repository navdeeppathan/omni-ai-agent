import { useEffect, useRef, useState } from 'react';
import { AudioLines, Bot, History, Mic, MessageCircle, Send, Square, Trash2, User, Volume2 } from 'lucide-react';

const API: string = (import.meta as any).env?.VITE_API_BASE || 'http://localhost:4000/api';

type Msg = { role: 'user' | 'assistant'; text: string; language?: string; ts?: string };
type ConvoSummary = { id: string; status: string; language?: string; title?: string; message_count: number; created_at: string };
type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

const LANGUAGES: [string, string][] = [
  ['auto', 'Auto-detect (speak any language)'], ['en', 'English'], ['hi', 'हिन्दी · Hindi'], ['ta', 'தமிழ் · Tamil'], ['te', 'తెలుగు · Telugu'],
  ['bn', 'বাংলা · Bengali'], ['mr', 'मराठी · Marathi'], ['gu', 'ગુજરાતી · Gujarati'], ['kn', 'ಕನ್ನಡ · Kannada'], ['ml', 'മലയാളം · Malayalam'],
  ['pa', 'ਪੰਜਾਬੀ · Punjabi'], ['ur', 'اردو · Urdu'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'],
  ['ar', 'العربية'], ['ja', '日本語'], ['ko', '한국어'], ['zh', '中文'],
];
// Region hints so the browser picks a sensible voice; other codes fall back to the bare language code.
const LOCALES: Record<string, string> = {
  en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN', kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN', ur: 'ur-PK',
  es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', ar: 'ar-SA', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN',
};
const langLabel = (code?: string) => (code ? LANGUAGES.find(l => l[0] === code)?.[1].split(' · ').pop() || code.toUpperCase() : '');

async function api(path: string, options: RequestInit = {}) {
  const res = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `Request failed (${res.status})`);
  return body;
}

const blobToBase64 = (blob: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = window.speechSynthesis;
  const v = synth.getVoices();
  if (v.length) return Promise.resolve(v);
  return new Promise(res => {
    const done = () => res(synth.getVoices());
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

export default function App() {
  const [tab, setTab] = useState<'talk' | 'history'>('talk');
  const [language, setLanguage] = useState('auto');
  const [consent, setConsent] = useState(false);
  const [handsFree, setHandsFree] = useState(true);
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [detected, setDetected] = useState('');
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');

  const convoId = useRef('');
  const stream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const stopListening = useRef<(() => void) | null>(null);
  const epoch = useRef(0); // bumped on end/restart so stale async work stops
  const handsFreeRef = useRef(handsFree);
  const languageRef = useRef(language);
  const phaseRef = useRef<Phase>('idle');
  const chatEnd = useRef<HTMLDivElement>(null);
  handsFreeRef.current = handsFree;
  languageRef.current = language;

  const setPhaseBoth = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, phase]);
  useEffect(() => () => { endSession(true); }, []);

  async function speak(msg: string, lang: string): Promise<void> {
    if (!('speechSynthesis' in window)) { setNotice('Speech output is not supported in this browser. Replies are shown as text.'); return; }
    const locale = LOCALES[lang] || lang;
    const voices = await loadVoices();
    const voice = voices.find(v => v.lang.replace('_', '-').toLowerCase() === locale.toLowerCase())
      || voices.find(v => v.lang.toLowerCase().startsWith(lang));
    if (!voice && lang !== 'en') setNotice(`No ${langLabel(lang)} voice is installed on this device, so the reply is shown as text. Install one in your OS speech settings, or use Chrome/Edge.`);
    await new Promise<void>(resolve => {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(msg);
      u.lang = voice?.lang || locale;
      if (voice) u.voice = voice;
      u.rate = 0.98;
      const timer = setTimeout(resolve, 60000); // safety net: some browsers never fire onend
      const done = () => { clearTimeout(timer); resolve(); };
      u.onend = done; u.onerror = done;
      window.speechSynthesis.speak(u);
    });
  }

  /** Speak a reply, then (in hands-free mode) go straight back to listening. */
  async function say(msg: string, lang: string, myEpoch: number) {
    setPhaseBoth('speaking');
    await speak(msg, lang);
    if (myEpoch !== epoch.current) return;
    setPhaseBoth('idle');
    if (handsFreeRef.current) listen(myEpoch);
  }

  async function startSession() {
    if (!consent) { setNotice('Please tick the consent box first.'); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setNotice('Microphone recording needs HTTPS or localhost and a modern browser (Chrome, Edge, Safari 14.1+, Firefox).');
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      audioCtx.current = new AudioContext();
      const r = await api('/agent/session', { method: 'POST', body: JSON.stringify({ language, transcriptConsent: true }) });
      const myEpoch = ++epoch.current;
      convoId.current = r.conversationId;
      setActive(true); setMessages([{ role: 'assistant', text: r.greeting, language: r.language }]); setDetected(r.language); setNotice('');
      say(r.greeting, language === 'auto' ? r.language : language, myEpoch);
    } catch (e: any) {
      releaseMic();
      setNotice(e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in your browser settings and try again.' : e.message || 'Could not start the session.');
    }
  }

  function releaseMic() {
    stream.current?.getTracks().forEach(t => t.stop()); stream.current = null;
    audioCtx.current?.close().catch(() => {}); audioCtx.current = null;
  }

  async function endSession(silent = false) {
    epoch.current++;
    stopListening.current?.();
    window.speechSynthesis?.cancel();
    releaseMic();
    const id = convoId.current;
    convoId.current = '';
    if (id) { try { await api(`/agent/session/${id}/end`, { method: 'POST', body: '{}' }); } catch { /* best effort */ } }
    if (silent) return;
    setActive(false); setPhaseBoth('idle'); setDetected('');
    setNotice('Conversation saved. Find it under History.');
  }

  /** Record one utterance, stop on silence, transcribe it, and send it. */
  function listen(myEpoch: number) {
    const s = stream.current, ctx = audioCtx.current;
    if (!s || !ctx || phaseRef.current === 'listening' || myEpoch !== epoch.current) return;
    window.speechSynthesis?.cancel();
    ctx.resume().catch(() => {});
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const source = ctx.createMediaStreamSource(s);
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const startedAt = Date.now();
    let heard = false, lastVoice = startedAt, stopped = false, manual = false;

    const stop = (byUser = false) => {
      if (stopped) return;
      stopped = true; manual = byUser;
      clearInterval(timer);
      if (rec.state !== 'inactive') rec.stop();
    };
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      const t = Date.now();
      if (peak > 12) { heard = true; lastVoice = t; }
      if ((heard && t - lastVoice > 1400) || t - startedAt > 30000 || (!heard && t - startedAt > 10000)) stop();
    }, 120);
    stopListening.current = () => stop(true);

    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      source.disconnect();
      stopListening.current = null;
      if (myEpoch !== epoch.current) return;
      if (!heard && !manual) { setPhaseBoth('idle'); setNotice('I did not hear anything. Tap the mic when you are ready.'); return; }
      setPhaseBoth('thinking');
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
        const r = await api('/agent/transcribe', { method: 'POST', body: JSON.stringify({ audioBase64: await blobToBase64(blob), mimeType: (blob.type || 'audio/webm').split(';')[0] }) });
        if (myEpoch !== epoch.current) return;
        if (!r.text) { setPhaseBoth('idle'); setNotice('I could not make that out. Please try again.'); if (handsFreeRef.current) listen(myEpoch); return; }
        setDetected(r.language);
        await sendTurn(r.text, myEpoch);
      } catch (e: any) {
        if (myEpoch === epoch.current) { setPhaseBoth('idle'); setNotice(`Speech recognition failed: ${e.message}`); }
      }
    };
    rec.start();
    setPhaseBoth('listening'); setNotice('');
  }

  async function sendTurn(msg: string, myEpoch = epoch.current) {
    setMessages(m => [...m, { role: 'user', text: msg }]);
    setPhaseBoth('thinking');
    try {
      const r = await api('/agent/message', { method: 'POST', body: JSON.stringify({ conversationId: convoId.current, message: msg, language: languageRef.current }) });
      if (myEpoch !== epoch.current) return;
      setMessages(m => [...m, { role: 'assistant', text: r.reply, language: r.language }]);
      setDetected(r.language);
      await say(r.reply, r.language, myEpoch);
    } catch (e: any) {
      if (myEpoch !== epoch.current) return;
      setPhaseBoth('idle');
      setNotice(`Could not get a reply: ${e.message}`);
    }
  }

  function onOrb() {
    if (!active) return;
    if (phase === 'listening') stopListening.current?.();
    else if (phase === 'speaking') window.speechSynthesis.cancel(); // say() then resumes listening in hands-free mode
    else if (phase === 'idle') listen(epoch.current);
  }

  function submitText() {
    const v = text.trim();
    if (!v || !active || phase === 'thinking') return;
    setText('');
    stopListening.current?.();
    window.speechSynthesis?.cancel();
    sendTurn(v);
  }

  const status: Record<Phase, string> = {
    idle: active ? 'Tap the mic and talk' : 'Start a conversation',
    listening: 'Listening… just talk',
    thinking: 'Thinking…',
    speaking: 'Speaking… tap to interrupt',
  };

  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><div className="logo"><AudioLines size={20} /></div><b>omni<span>voice</span></b></div>
        <nav>
          <button className={tab === 'talk' ? 'on' : ''} onClick={() => setTab('talk')}><MessageCircle size={16} /> Talk</button>
          <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}><History size={16} /> History</button>
        </nav>
      </header>

      {tab === 'talk' ? (
        <main className="talk">
          <div className="chat">
            {messages.length === 0 && (
              <div className="empty">
                <div className="orb-static"><Bot size={34} /></div>
                <h1>Talk to your AI, naturally</h1>
                <p>Speak in any language. It figures out which one you're using and answers in the same language, out loud. No menus, no topics, just a conversation.</p>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="av">{m.role === 'assistant' ? <Bot size={15} /> : <User size={15} />}</div>
                <div className="bubble">{m.text}</div>
              </div>
            ))}
            {phase === 'thinking' && <div className="typing">Thinking<span>•••</span></div>}
            <div ref={chatEnd} />
          </div>

          {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}

          {!active ? (
            <div className="start">
              <label className="field">Language
                <select value={language} onChange={e => setLanguage(e.target.value)}>{LANGUAGES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
              </label>
              <label className="check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
                I allow microphone use and saving the text of this conversation. Audio is never stored.</label>
              <button className="primary" onClick={startSession}><Mic size={18} /> Start talking</button>
            </div>
          ) : (
            <div className="controls">
              <div className="status">{status[phase]}{detected && <span className="chip"><Volume2 size={12} /> {langLabel(detected)}</span>}</div>
              <button className={`orb ${phase}`} onClick={onOrb} disabled={phase === 'thinking'} aria-label="Microphone">
                {phase === 'listening' ? <Square size={30} /> : phase === 'speaking' ? <Volume2 size={32} /> : <Mic size={32} />}
              </button>
              <div className="row">
                <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && submitText()} placeholder="…or type a message" />
                <button className="send" onClick={submitText} disabled={!text.trim() || phase === 'thinking'}><Send size={16} /></button>
              </div>
              <div className="row between">
                <label className="check small"><input type="checkbox" checked={handsFree} onChange={e => setHandsFree(e.target.checked)} /> Hands-free (keep listening after each reply)</label>
                <button className="ghost" onClick={() => endSession()}><Square size={13} /> End &amp; save</button>
              </div>
            </div>
          )}
        </main>
      ) : <HistoryView />}
    </div>
  );
}

function HistoryView() {
  const [items, setItems] = useState<ConvoSummary[]>([]);
  const [open, setOpen] = useState('');
  const [detail, setDetail] = useState<Msg[]>([]);
  const [error, setError] = useState('');

  const load = () => api('/conversations').then(r => setItems(r.data)).catch(e => setError(e.message + ' — is the backend running?'));
  useEffect(() => { load(); }, []);

  async function toggle(id: string) {
    if (open === id) { setOpen(''); return; }
    try { setDetail((await api(`/conversations/${id}`)).data.transcript); setOpen(id); } catch (e: any) { setError(e.message); }
  }
  async function remove(id: string) {
    try { await api(`/conversations/${id}`, { method: 'DELETE' }); if (open === id) setOpen(''); load(); } catch (e: any) { setError(e.message); }
  }

  return (
    <main className="history">
      <h2>Conversation history</h2>
      {error && <div className="notice">{error}</div>}
      {!items.length && !error && <p className="muted">No conversations yet. Go to Talk and say hello.</p>}
      {items.map(c => (
        <div className="card" key={c.id}>
          <div className="card-head" onClick={() => toggle(c.id)}>
            <div><b>{c.title || 'Conversation'}</b><small>{new Date(c.created_at).toLocaleString()} · {c.message_count} messages{c.language ? ` · ${langLabel(c.language)}` : ''} · {c.status.replace('_', ' ')}</small></div>
            <button className="icon" title="Delete" onClick={e => { e.stopPropagation(); remove(c.id); }}><Trash2 size={16} /></button>
          </div>
          {open === c.id && <div className="transcript">{detail.map((m, i) => <p key={i} className={m.role}><b>{m.role === 'assistant' ? 'AI' : 'You'}:</b> {m.text}</p>)}</div>}
        </div>
      ))}
    </main>
  );
}
