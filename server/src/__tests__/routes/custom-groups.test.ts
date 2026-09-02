import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setCustomGroups } from '../../services/custom-groups.js';
import { setRoutingStrategy } from '../../services/router.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = 'http://127.0.0.1:' + addr.port + path;
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: 'Bearer ' + dashToken } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(data); } catch { /* SSE / non-JSON */ }
  return { status: res.status, body: json, text: data, headers: res.headers };
}

function authHeaders() {
  return { Authorization: 'Bearer ' + getUnifiedApiKey() };
}

// Insert a catalog row + fallback_config entry, returning its model_db_id.
function addModel(platform: string, modelId: string, displayName: string, priority: number): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision)
    VALUES (?, ?, ?, 5, 5, 'Large', 100, NULL, NULL, NULL, '~10M', 131072, 1, 0)
  `).run(platform, modelId, displayName);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  return id;
}

function addKey(platform: string): void {
  const db = getDb();
  const { encrypted, iv, authTag } = encrypt('test-key-' + platform);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, platform + '-key', encrypted, iv, authTag);
}

// A mocked upstream chat completion response (OpenAI-compatible shape).
function completion(model: string, content: string) {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// "Test Unify Model" served by both Groq and Cerebras (the shared fixture the
// proxy-model-groups tests use), plus a third unrelated model.
describe('Custom model groups (自定义模型组)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    // createApp() seeds a default chain profile and marks it active; an active
    // profile makes routeRequest (the fan-out judge path) read the EMPTY
    // profile_models instead of the fixture's fallback_config rows. Clear it
    // so the auto chain is the fixture chain.
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM profiles').run();
    setCustomGroups({ groups: [] });
    setRoutingStrategy('priority');
    addModel('groq', 'tum-groq', 'Test Unify Model', 1);
    addModel('cerebras', 'tum-cerebras', 'Test Unify Model', 2);
    addModel('openrouter', 'other-model', 'Other Model', 3);
    addKey('groq');
    addKey('cerebras');
    addKey('openrouter');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Admin API ──────────────────────────────────────────────────────────────
  it('PUT saves and GET returns groups with a resolution preview', async () => {
    const put = await request(app, 'PUT', '/api/custom-model-groups', {
      groups: [{ name: 'team', models: ['test-unify-model', 'no-such-model'], description: 'my pool' }],
    });
    expect(put.status).toBe(200);
    expect(put.body.groups).toHaveLength(1);
    expect(put.body.groups[0].name).toBe('team');
    // Preview enriched fields.
    expect(put.body.groups[0].routable).toBe(true);
    expect(put.body.groups[0].available).toBe(true);
    expect(put.body.groups[0].members[0].resolved).toBe(true);
    expect(put.body.groups[0].members[1].resolved).toBe(false);

    const get = await request(app, 'GET', '/api/custom-model-groups');
    expect(get.status).toBe(200);
    expect(get.body.groups[0].models).toEqual(['test-unify-model', 'no-such-model']);
  });

  it('PUT rejects invalid configs with a 400', async () => {
    const badName = await request(app, 'PUT', '/api/custom-model-groups', {
      groups: [{ name: 'bad name!', models: ['tum-groq'] }],
    });
    expect(badName.status).toBe(400);

    const emptyModels = await request(app, 'PUT', '/api/custom-model-groups', {
      groups: [{ name: 'ok-name', models: [] }],
    });
    expect(emptyModels.status).toBe(400);

    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'dup', models: ['a'] }] });
    const dup = await request(app, 'PUT', '/api/custom-model-groups', {
      groups: [{ name: 'dup', models: ['a'] }, { name: 'DUP', models: ['b'] }],
    });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toMatch(/already uses/);
  });

  it('validate-name gives live feedback without saving', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'taken', models: ['tum-groq'] }] });
    const ok = await request(app, 'POST', '/api/custom-model-groups/validate-name', { name: 'fresh-name' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    const clash = await request(app, 'POST', '/api/custom-model-groups/validate-name', { name: 'TAKEN' });
    expect(clash.body.ok).toBe(false);
    expect(clash.body.problem).toMatch(/already uses/);
    // excludeName lets an edit keep its own name.
    const self = await request(app, 'POST', '/api/custom-model-groups/validate-name', { name: 'TAKEN', excludeName: 'taken' });
    expect(self.body.ok).toBe(true);
  });

  it('DELETE removes one group and 404s unknown names', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['tum-groq'] }] });
    const del = await request(app, 'DELETE', '/api/custom-model-groups/team');
    expect(del.status).toBe(200);
    expect(del.body.groups).toHaveLength(0);
    const gone = await request(app, 'DELETE', '/api/custom-model-groups/team');
    expect(gone.status).toBe(404);
  });

  // ── /v1/models discovery ───────────────────────────────────────────────────
  it('lists an enabled routable group on /v1/models', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const { status, body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(status).toBe(200);
    const entry = body.data.find((m: any) => m.id === 'team');
    expect(entry).toBeTruthy();
    expect(entry.available).toBe(true);
    expect(entry.owned_by).toBe('freellmapi');
    // ?available=true keeps it (a key can serve a member).
    const avail = await request(app, 'GET', '/v1/models?available=true', undefined, authHeaders());
    expect(avail.body.data.some((m: any) => m.id === 'team')).toBe(true);
  });

  it('never lists a group whose name collides with a catalog id (catalog wins)', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'tum-groq', models: ['other-model'] }] });
    const { body } = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(body.data.filter((m: any) => m.id === 'tum-groq')).toHaveLength(1); // the REAL row only
  });

  // ── Dispatch: random member per call ───────────────────────────────────────
  it('model:<group-name> serves a random member and reports it honestly', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return completion('tum-groq', 'from groq');
      if (u.includes('api.cerebras.ai')) return completion('tum-cerebras', 'from cerebras');
      // Not an upstream we fake (e.g. the loopback call to OUR app) — pass it
      // through to the real fetch, init INCLUDED (dropping it would downgrade
      // the POST to a GET).
      return orig(url, init);
    });

    const served = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const { status, body, headers, text } = await request(app, 'POST', '/v1/chat/completions', {
        model: 'team',
        messages: [{ role: 'user', content: 'hi' }],
      }, authHeaders());
      expect(status).toBe(200);
      expect(['tum-groq', 'tum-cerebras']).toContain(body.model);
      served.add(headers.get('x-routed-via') ?? '');
    }
    // Randomness: both members must appear across 16 draws (both healthy).
    expect(served.size).toBe(2);
  });

  it('fails over INSIDE the group when the drawn member is rate-limited', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      if (u.includes('api.cerebras.ai')) return completion('tum-cerebras', 'answer from cerebras');
      // Not an upstream we fake (e.g. the loopback call to OUR app) — pass it
      // through to the real fetch, init INCLUDED (dropping it would downgrade
      // the POST to a GET).
      return orig(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'team',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(body.model).toBe('tum-cerebras');
    expect(headers.get('x-routed-via')).toContain('cerebras');
  });

  it('streams a group call like a normal model (SSE, member model id)', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) {
        return new Response('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n'
          + 'data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: { content: 'hello from groq' }, finish_reason: null }] }) + '\n\n'
          + 'data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'
          + 'data: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (u.includes('api.cerebras.ai')) return completion('tum-cerebras', 'unused');
      // Not an upstream we fake (e.g. the loopback call to OUR app) — pass it
      // through to the real fetch, init INCLUDED (dropping it would downgrade
      // the POST to a GET).
      return orig(url, init);
    });

    const { status, text } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'team',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(text).toContain('hello from groq');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('[DONE]');
  });

  // ── Honest errors ──────────────────────────────────────────────────────────
  it('404s a group whose members all fail to resolve', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'ghosts', models: ['no-such-a', 'no-such-b'] }] });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'ghosts',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(404);
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toMatch(/no enabled members/);
    expect(body.error.message).toContain('no-such-a');
  });

  it('404s a disabled group', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'sleepy', models: ['tum-groq'], enabled: false }] });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'sleepy',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(404);
    expect(body.error.message).toMatch(/is disabled/);
  });

  // ── Backward compatibility ─────────────────────────────────────────────────
  it('a group named like a real model id NEVER shadows the catalog', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'tum-groq', models: ['other-model'] }] });
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return completion('tum-groq', 'from groq');
      // Not an upstream we fake (e.g. the loopback call to OUR app) — pass it
      // through to the real fetch, init INCLUDED (dropping it would downgrade
      // the POST to a GET).
      return orig(url, init);
    });
    const { status, body, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'tum-groq',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(body.model).toBe('tum-groq');
    expect(headers.get('x-routed-via')).toContain('groq');
  });

  it('unify group pins behave exactly as before (strict chain, failover)', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['other-model'] }] });
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      if (u.includes('api.cerebras.ai')) return completion('tum-cerebras', 'answer from cerebras');
      // Not an upstream we fake (e.g. the loopback call to OUR app) — pass it
      // through to the real fetch, init INCLUDED (dropping it would downgrade
      // the POST to a GET).
      return orig(url, init);
    });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'test-unify-model',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(body.model).toBe('tum-cerebras');
  });

  // ── Other surfaces ─────────────────────────────────────────────────────────
  it('legacy /v1/completions accepts a group name too', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const orig = global.fetch;
    // Providers always speak chat-completions upstream; the legacy surface
    // translates prompt→messages and the answer back to text_completion.
    const upstreamHits = { groq: 0, cerebras: 0 };
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) {
        upstreamHits.groq++;
        return completion('tum-groq', 'groq completion');
      }
      if (u.includes('api.cerebras.ai')) {
        upstreamHits.cerebras++;
        return completion('tum-cerebras', 'cerebras completion');
      }
      // Not an upstream we fake (e.g. the loopback call to OUR app) — pass it
      // through to the real fetch, init INCLUDED (dropping it would downgrade
      // the POST to a GET).
      return orig(url, init);
    });
    for (let i = 0; i < 12; i++) {
      const { status, body } = await request(app, 'POST', '/v1/completions', {
        model: 'team',
        prompt: 'hi',
      }, authHeaders());
      expect(status).toBe(200);
      expect(body.choices[0].text.length).toBeGreaterThan(0);
    }
    // Randomness: both group members must have served across 12 draws.
    expect(upstreamHits.groq).toBeGreaterThan(0);
    expect(upstreamHits.cerebras).toBeGreaterThan(0);
  });

  it('/v1/responses accepts a group name', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) return completion('tum-groq', 'from groq');
      if (u.includes('api.cerebras.ai')) return completion('tum-cerebras', 'from cerebras');
      // Not an upstream we fake (e.g. the loopback call to OUR app) — pass it
      // through to the real fetch, init INCLUDED (dropping it would downgrade
      // the POST to a GET).
      return orig(url, init);
    });
    const { status, body } = await request(app, 'POST', '/v1/responses', {
      model: 'team',
      input: 'hi',
    }, authHeaders());
    expect(status).toBe(200);
    expect(['tum-groq', 'tum-cerebras']).toContain(body.model);
  });

  it('/v1/messages (Anthropic) accepts a group name', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const orig = global.fetch;
    // The Anthropic envelope echoes the REQUESTED model name, so randomness is
    // observed by counting which upstream actually got called.
    const upstreamHits = { groq: 0, cerebras: 0 };
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) { upstreamHits.groq++; return completion('tum-groq', 'from groq'); }
      if (u.includes('api.cerebras.ai')) { upstreamHits.cerebras++; return completion('tum-cerebras', 'from cerebras'); }
      // Not an upstream we fake (e.g. the loopback call to OUR app) — pass it
      // through to the real fetch, init INCLUDED (dropping it would downgrade
      // the POST to a GET).
      return orig(url, init);
    });
    for (let i = 0; i < 12; i++) {
      const { status, body } = await request(app, 'POST', '/v1/messages', {
        model: 'team',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }, { ...authHeaders(), 'anthropic-version': '2023-06-01' });
      expect(status).toBe(200);
      expect(body.model).toBe('team');
    }
    // Randomness: both group members must have served across 12 draws.
    expect(upstreamHits.groq).toBeGreaterThan(0);
    expect(upstreamHits.cerebras).toBeGreaterThan(0);
  });

  // ── Streaming (the path every real agent client actually uses) ─────────────
  it('streams /v1/chat/completions through a group name', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const orig = global.fetch;
    const enc = new TextEncoder();
    // The proxy asks the UPSTREAM for an OpenAI-style chunk stream and
    // re-emits it as the client's SSE. Both fakes serve a full tiny stream.
    const sseFrame = (payload: object | string) =>
      `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
    const streamFor = (platform: string, text: string) => new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(sseFrame(
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: platform, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] })));
        controller.enqueue(enc.encode(sseFrame(
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: platform, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })));
        controller.enqueue(enc.encode(sseFrame(
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: platform, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })));
        controller.enqueue(enc.encode(sseFrame('[DONE]')));
        controller.close();
      },
    });
    const upstreamHits = { groq: 0, cerebras: 0 };
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) { upstreamHits.groq++; return new Response(streamFor('tum-groq', 'from groq'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
      if (u.includes('api.cerebras.ai')) { upstreamHits.cerebras++; return new Response(streamFor('tum-cerebras', 'from cerebras'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
      return orig(url, init);
    });
    const texts = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const { status, text, headers } = await request(app, 'POST', '/v1/chat/completions', {
        model: 'team',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }, authHeaders());
      expect(status).toBe(200);
      expect(headers.get('content-type')).toContain('text/event-stream');
      expect(text.trim().endsWith('data: [DONE]')).toBe(true);
      // Content arrives as delta frames and carries the serving member's text.
      const deltas = text.split('\n')
        .filter(l => l.startsWith('data: ') && l.trim() !== 'data: [DONE]')
        .map(l => JSON.parse(l.slice(6)))
        .map(f => f.choices?.[0]?.delta?.content)
        .filter((c: any): c is string => typeof c === 'string' && c.length > 0);
      expect(deltas.length).toBeGreaterThan(0);
      texts.add(deltas.join(''));
    }
    // Randomness holds on the streaming path too: both members served.
    expect(upstreamHits.groq).toBeGreaterThan(0);
    expect(upstreamHits.cerebras).toBeGreaterThan(0);
    expect(texts.has('from groq')).toBe(true);
    expect(texts.has('from cerebras')).toBe(true);
  });

  it('streams /v1/messages through a group name (Anthropic SSE)', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const orig = global.fetch;
    const enc = new TextEncoder();
    // The Anthropic surface consumes the provider's OpenAI-style chunk stream
    // and re-emits message_start / content_block_delta / message_stop frames.
    const sseFrame = (payload: object | string) =>
      `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
    const streamFor = (platform: string, text: string) => new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(sseFrame(
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: platform, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] })));
        controller.enqueue(enc.encode(sseFrame(
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: platform, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })));
        controller.enqueue(enc.encode(sseFrame(
          { id: 'c1', object: 'chat.completion.chunk', created: 1, model: platform, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })));
        controller.enqueue(enc.encode(sseFrame('[DONE]')));
        controller.close();
      },
    });
    const upstreamHits = { groq: 0, cerebras: 0 };
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) { upstreamHits.groq++; return new Response(streamFor('tum-groq', 'from groq'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
      if (u.includes('api.cerebras.ai')) { upstreamHits.cerebras++; return new Response(streamFor('tum-cerebras', 'from cerebras'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
      return orig(url, init);
    });
    const texts = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const { status, text } = await request(app, 'POST', '/v1/messages', {
        model: 'team',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }, { ...authHeaders(), 'anthropic-version': '2023-06-01' });
      expect(status).toBe(200);
      expect(text).toContain('message_start');
      expect(text).toContain('message_stop');
      const deltas = text.split('\n')
        .filter(l => l.startsWith('data: '))
        .map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
        .filter(Boolean)
        .map(f => f?.delta?.text)
        .filter((c: any): c is string => typeof c === 'string' && c.length > 0);
      if (deltas.length > 0) texts.add(deltas.join(''));
    }
    // Randomness holds on the Anthropic streaming path too.
    expect(upstreamHits.groq).toBeGreaterThan(0);
    expect(upstreamHits.cerebras).toBeGreaterThan(0);
    expect(texts.has('from groq')).toBe(true);
    expect(texts.has('from cerebras')).toBe(true);
  });

  // ── MCP introspection (agents discover groups like /v1/models clients) ─────
  it('MCP list_models exposes enabled groups', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', { groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const rpcRes = await request(app, 'POST', '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_models', arguments: { available_only: false } },
    }, authHeaders());
    expect(rpcRes.status).toBe(200);
    const body = rpcRes.body as any;
    expect(body?.result?.content?.[0]?.type).toBe('text');
    const listing = JSON.parse(body.result.content[0].text);
    // The group is NOT a catalog id, so it must survive the collision filter
    // and appear with the same shape the catalog rows use.
    const entry = listing.models.find((m: any) => m.id === 'team');
    expect(entry).toBeTruthy();
    expect(entry.available).toBe(true); // fixture keys are enabled + healthy
    expect(entry.platforms).toEqual(expect.arrayContaining(['groq', 'cerebras']));
    expect(listing.models.filter((m: any) => m.id === 'team')).toHaveLength(1);
  });

  // ── Fan-out strategies (COPIED fusion semantics) ───────────────────────────
  // A judge sub-call is detectable by its prompt: it carries the anonymized
  // 'independent answers' block the copied buildJudgeMessages assembles.
  const isJudgeCall = (init: any) =>
    JSON.stringify(JSON.parse(String(init?.body ?? '{}')).messages ?? []).includes('independent answers');

  it('group strategy synthesize fans out to members and blends with a judge', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', {
      groups: [{ name: 'team', models: ['tum-groq', 'tum-cerebras'], strategy: 'synthesize', expose_panel: true }],
    });
    const orig = global.fetch;
    const calls: { platform: string; judge: boolean }[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com') || u.includes('api.cerebras.ai') || u.includes('openrouter.ai')) {
        const platform = u.includes('api.groq.com') ? 'groq' : u.includes('api.cerebras.ai') ? 'cerebras' : 'openrouter';
        const model = platform === 'groq' ? 'tum-groq' : platform === 'cerebras' ? 'tum-cerebras' : 'other-model';
        if (isJudgeCall(init)) {
          calls.push({ platform, judge: true });
          return completion(model, 'judged answer');
        }
        calls.push({ platform, judge: false });
        return completion(model, platform === 'groq' ? 'from groq' : platform === 'cerebras' ? 'from cerebras' : 'from openrouter');
      }
      return orig(url, init);
    });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'team',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);
    // The response reports the GROUP NAME as the model, not 'fusion'.
    expect(body.model).toBe('team');
    // The judge's synthesis is the final answer.
    expect(body.choices[0].message.content).toBe('judged answer');
    // One parallel call per member (2), then exactly one judge call.
    expect(calls.filter(c => !c.judge)).toHaveLength(2);
    expect(calls.filter(c => c.judge)).toHaveLength(1);
    // x_fusion carries the panel answers + judge metadata (expose_panel on).
    expect(body.x_fusion).toBeTruthy();
    expect(body.x_fusion.strategy).toBe('synthesize');
    expect(body.x_fusion.synthesized).toBe(true);
    expect(body.x_fusion.group).toBe('team');
    expect(body.x_fusion.panel.filter((p: any) => p.status === 'ok')).toHaveLength(2);
    expect(body.x_fusion.panel.map((p: any) => p.content)).toEqual(expect.arrayContaining(['from groq', 'from cerebras']));
  });

  it('group strategy best_of returns the strongest answer without calling a judge', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', {
      groups: [{ name: 'team', models: ['tum-groq', 'tum-cerebras'], strategy: 'best_of' }],
    });
    const orig = global.fetch;
    let judgeCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com') || u.includes('api.cerebras.ai') || u.includes('openrouter.ai')) {
        const model = u.includes('api.groq.com') ? 'tum-groq' : u.includes('api.cerebras.ai') ? 'tum-cerebras' : 'other-model';
        if (isJudgeCall(init)) { judgeCalls++; return completion(model, 'judged'); }
        return completion(model, u.includes('api.cerebras.ai')
          ? 'the much longer cerebras answer that should win best_of'
          : 'short');
      }
      return orig(url, init);
    });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'team',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(body.model).toBe('team');
    expect(body.choices[0].message.content).toContain('longer cerebras answer');
    // best_of: NO judge call.
    expect(judgeCalls).toBe(0);
    // expose_panel defaults off — no x_fusion payload.
    expect(body.x_fusion).toBeUndefined();
  });

  it('streams group strategy synthesize with _fusion trace frames', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', {
      groups: [{ name: 'team', models: ['tum-groq', 'tum-cerebras'], strategy: 'synthesize', expose_panel: true }],
    });
    const orig = global.fetch;
    const enc = new TextEncoder();
    const sseFrame = (p: object | string) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com') || u.includes('api.cerebras.ai') || u.includes('openrouter.ai')) {
        if (isJudgeCall(init)) {
          // The judge STREAMS in the streaming route (copied fusion behavior).
          const chunk = (content: any, finish: string | null = null) => ({
            id: 'j1', object: 'chat.completion.chunk', created: 1, model: 'judge-model',
            choices: [{ index: 0, delta: content === null ? { role: 'assistant' } : { content }, finish_reason: finish }],
          });
          const stream = new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(sseFrame(chunk(null))));
              c.enqueue(enc.encode(sseFrame(chunk('judged streaming answer'))));
              c.enqueue(enc.encode(sseFrame(chunk({}, 'stop'))));
              c.enqueue(enc.encode(sseFrame('[DONE]')));
              c.close();
            },
          });
          return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        const model = u.includes('api.groq.com') ? 'tum-groq' : u.includes('api.cerebras.ai') ? 'tum-cerebras' : 'other-model';
        return completion(model, u.includes('api.groq.com') ? 'from groq' : u.includes('api.cerebras.ai') ? 'from cerebras' : 'from openrouter');
      }
      return orig(url, init);
    });
    const { status, text, headers } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'team',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('text/event-stream');
    // Trace frames arrive for each panel slot and the judge.
    expect(text).toContain('"event":"panel"');
    expect(text).toContain('"event":"judge"');
    // The final answer streams as normal content deltas and closes with [DONE].
    expect(text).toContain('judged streaming answer');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    // Chunk model label = the group name.
    expect(text).toContain('"model":"team"');
  });

  it('group strategy passes a structured tool call through without synthesis', async () => {
    await request(app, 'PUT', '/api/custom-model-groups', {
      groups: [{ name: 'team', models: ['tum-groq', 'tum-cerebras'], strategy: 'synthesize' }],
    });
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('api.groq.com')) {
        return new Response(JSON.stringify({
          id: 't1', object: 'chat.completion', created: 1, model: 'tum-groq',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a"}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('api.cerebras.ai')) return completion('tum-cerebras', 'from cerebras');
      return orig(url, init);
    });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'team',
      messages: [{ role: 'user', content: 'read the file' }],
    }, authHeaders());
    expect(status).toBe(200);
    // Actions aren't prose: the first structured tool call wins, no judge.
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('read_file');
  });

  it('caps the fan-out panel at 8 members and reports the overflow in x_fusion', async () => {
    const members: string[] = [];
    for (let i = 1; i <= 9; i++) {
      addModel('groq', 'cap-m' + i, 'Cap Model ' + i, 10 + i);
      addKey('groq');
      members.push('cap-m' + i);
    }
    await request(app, 'PUT', '/api/custom-model-groups', {
      groups: [{ name: 'big', models: members, strategy: 'best_of', expose_panel: true }],
    });
    const orig = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init?: any) => {
      if (String(url).includes('api.groq.com')) return completion('cap-m1', 'cap answer');
      return orig(url, init);
    });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'big',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(body.x_fusion.panel_requested).toHaveLength(8);
    expect(body.x_fusion.dropped).toHaveLength(1);
  });
});
