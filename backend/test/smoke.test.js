import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.API_BASE_URL || 'http://localhost:4000/api';
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health endpoint reports PostgreSQL connectivity', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.ok, true);
  assert.equal(data.database, 'postgresql');
});

test('a session requires transcript consent', async () => {
  const r = await post('/agent/session', { transcriptConsent: false });
  assert.equal(r.status, 400);
});

test('session can be started, listed and ended', async () => {
  const r = await post('/agent/session', { language: 'auto', transcriptConsent: true });
  assert.equal(r.status, 201);
  const { conversationId, greeting } = await r.json();
  assert.ok(conversationId && greeting);

  const detail = await (await fetch(`${base}/conversations/${conversationId}`)).json();
  assert.equal(detail.data.transcript[0].role, 'assistant');

  const end = await post(`/agent/session/${conversationId}/end`, {});
  assert.equal((await end.json()).data.status, 'completed');

  // Messages to an ended conversation are rejected.
  const late = await post('/agent/message', { conversationId, message: 'hello' });
  assert.equal(late.status, 409);

  assert.equal((await fetch(`${base}/conversations/${conversationId}`, { method: 'DELETE' })).status, 200);
});
