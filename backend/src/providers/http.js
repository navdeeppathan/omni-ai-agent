export class ProviderError extends Error {
  constructor(message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const RETRYABLE = [429, 500, 502, 503, 529];
const MAX_RETRY_WAIT_MS = 5000;

function retryAfterMs(response) {
  const secs = Number(response.headers.get('retry-after'));
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

/**
 * fetch + timeout + retry for transient failures (overload, rate limit, timeouts).
 * `init` is a function so every attempt gets a fresh body. Returns the parsed JSON body.
 */
export async function requestJson(label, url, init, { timeoutMs = 15000, attempts = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { ...init(), signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return await response.json();
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      lastError = new ProviderError(`${label} returned ${response.status}${detail ? `: ${detail}` : ''}`, {
        status: response.status,
        retryAfterMs: retryAfterMs(response),
      });
      if (!RETRYABLE.includes(response.status)) throw lastError;
    } catch (e) {
      if (e instanceof ProviderError && !RETRYABLE.includes(e.status)) throw e;
      lastError = e instanceof ProviderError ? e : new ProviderError(`${label} request failed: ${e.message}`);
    }
    if (attempt < attempts - 1) {
      const wait = Math.min(lastError.retryAfterMs ?? 700 * (attempt + 1), MAX_RETRY_WAIT_MS);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/** Reverse lookup: "Hindi" / "hindi" -> "hi". For providers that return language names, not ISO codes. */
let nameToCode;
export function languageCodeFromName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  if (/^[a-z]{2,3}$/.test(key)) return key;
  if (!nameToCode) {
    nameToCode = new Map();
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    for (let i = 97; i <= 122; i++) {
      for (let j = 97; j <= 122; j++) {
        const code = String.fromCharCode(i, j);
        try {
          const n = names.of(code);
          if (n && n.toLowerCase() !== code) nameToCode.set(n.toLowerCase(), code);
        } catch { /* not a valid code */ }
      }
    }
  }
  return nameToCode.get(key) ?? null;
}
