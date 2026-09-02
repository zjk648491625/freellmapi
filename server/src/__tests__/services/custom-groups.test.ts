import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  CUSTOM_GROUPS_SETTING_KEY,
  CUSTOM_GROUP_STRATEGIES,
  customGroupSchema,
  validateCustomGroupName,
  shuffleMembers,
  getCustomGroups,
  setCustomGroups,
  findCustomGroup,
  buildCustomGroupChain,
  resolveCustomGroupDispatch,
  previewCustomGroup,
  type CustomGroup,
} from '../../services/custom-groups.js';
import { initDb, getDb, getSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

// ── Pure logic: name validation ──────────────────────────────────────────────
describe('validateCustomGroupName', () => {
  const others: CustomGroup[] = [customGroupSchema.parse({ name: 'existing', models: ['m'] })];

  it('accepts catalog-safe names', () => {
    expect(validateCustomGroupName('team-alpha', [])).toBeNull();
    expect(validateCustomGroupName('My_Group.2', [])).toBeNull();
    expect(validateCustomGroupName('a1.b-c_d', [])).toBeNull();
  });

  it('rejects empty, oversized, and bad-charset names', () => {
    expect(validateCustomGroupName('', [])).toMatch(/empty/);
    expect(validateCustomGroupName('   ', [])).toMatch(/empty/);
    expect(validateCustomGroupName('g'.repeat(65), [])).toMatch(/64/);
    // ' ' (space), ':' and '#' are separators of the structured id forms.
    expect(validateCustomGroupName('my group', [])).toMatch(/letters, digits/);
    expect(validateCustomGroupName('groq:model', [])).toMatch(/letters, digits/);
    expect(validateCustomGroupName('custom:model#ep', [])).toMatch(/letters, digits/);
    expect(validateCustomGroupName('-leading', [])).toMatch(/start with a letter or digit/);
    expect(validateCustomGroupName('模型组', [])).toMatch(/letters, digits/);
  });

  it('rejects reserved virtual ids (case-insensitive)', () => {
    expect(validateCustomGroupName('auto', [])).toMatch(/reserved/);
    expect(validateCustomGroupName('AUTO', [])).toMatch(/reserved/);
    expect(validateCustomGroupName('fusion', [])).toMatch(/reserved/);
  });

  it('enforces case-insensitive uniqueness', () => {
    expect(validateCustomGroupName('EXISTING', others)).toMatch(/already uses/);
    expect(validateCustomGroupName('existing', others)).toMatch(/already uses/);
    expect(validateCustomGroupName('other', others)).toBeNull();
  });
});

// ── Pure logic: schema defaults + shuffle ────────────────────────────────────
describe('customGroupSchema', () => {
  it('fills the documented defaults', () => {
    const g = customGroupSchema.parse({ name: 'team', models: ['a'] });
    expect(g.description).toBe('');
    expect(g.strategy).toBe('random');
    expect(g.enabled).toBe(true);
  });

  it('requires at least one member', () => {
    expect(customGroupSchema.safeParse({ name: 'team', models: [] }).success).toBe(false);
  });

  it('enforces the documented upper bounds', () => {
    // 64 members max, each ref at most 256 chars, description at most 300.
    const ok = customGroupSchema.safeParse({ name: 'team', models: Array.from({ length: 64 }, (_, i) => `m${i}`) });
    expect(ok.success).toBe(true);
    expect(customGroupSchema.safeParse({ name: 'team', models: Array.from({ length: 65 }, (_, i) => `m${i}`) }).success).toBe(false);
    expect(customGroupSchema.safeParse({ name: 'team', models: ['x'.repeat(257)] }).success).toBe(false);
    expect(customGroupSchema.safeParse({ name: 'team', models: ['a'], description: 'x'.repeat(301) }).success).toBe(false);
  });

  it('rejects unknown strategies (zod enum, no silent passthrough)', () => {
    expect(customGroupSchema.safeParse({ name: 'team', models: ['a'], strategy: 'round-robin' }).success).toBe(false);
    expect(customGroupSchema.safeParse({ name: 'team', models: ['a'], strategy: 'RANDOM' }).success).toBe(false);
  });

  it('accepts the fan-out strategies and defaults expose_panel off', () => {
    expect(CUSTOM_GROUP_STRATEGIES).toEqual(['random', 'synthesize', 'best_of']);
    const syn = customGroupSchema.parse({ name: 'team', models: ['a'], strategy: 'synthesize' });
    expect(syn.strategy).toBe('synthesize');
    expect(syn.expose_panel).toBe(false); // default off
    const best = customGroupSchema.parse({ name: 'team', models: ['a'], strategy: 'best_of' });
    expect(best.strategy).toBe('best_of');
    const exposed = customGroupSchema.parse({ name: 'team', models: ['a'], expose_panel: true });
    expect(exposed.expose_panel).toBe(true);
    expect(exposed.strategy).toBe('random'); // unrelated default intact
  });

  it('trims names and member refs on parse', () => {
    const g = customGroupSchema.parse({ name: '  team  ', models: ['  a  ', 'b'] });
    expect(g.name).toBe('team');
    expect(g.models).toEqual(['a', 'b']);
  });
});

describe('shuffleMembers', () => {
  it('returns a permutation of the same elements', () => {
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    for (let i = 0; i < 20; i++) {
      expect([...shuffleMembers(src)].sort((a, b) => a - b)).toEqual(src);
    }
  });

  it('does not mutate its input', () => {
    const src = [1, 2, 3];
    shuffleMembers(src);
    expect(src).toEqual([1, 2, 3]);
  });

  it('actually varies the order across draws', () => {
    const src = Array.from({ length: 8 }, (_, i) => i);
    const seen = new Set(shuffleMembers(src).join(','));
    for (let i = 0; i < 30; i++) seen.add(shuffleMembers(src).join(','));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('is deterministic for a mocked Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    // rand=0 → j=0 at every step: [A,B,C] → swap(0,2) → [C,B,A] → swap(0,1) → [B,C,A]
    expect(shuffleMembers(['A', 'B', 'C'])).toEqual(['B', 'C', 'A']);
    spy.mockRestore();
  });
});

// ── DB-backed resolution ─────────────────────────────────────────────────────
function addModel(platform: string, modelId: string, displayName: string): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision)
    VALUES (?, ?, ?, 5, 5, 'Large', 100, NULL, NULL, NULL, '~10M', 131072, 1, 0)
  `).run(platform, modelId, displayName);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, id);
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

describe('custom group chain + dispatch (db)', () => {
  let groqRow: number;
  let cerebrasRow: number;
  let llamaRow: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    setCustomGroups({ groups: [] });
    groqRow = addModel('groq', 'tum-groq', 'Test Unify Model');
    cerebrasRow = addModel('cerebras', 'tum-cerebras', 'Test Unify Model');
    llamaRow = addModel('openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'Other Model');
    addKey('groq');
    addKey('cerebras');
    addKey('openrouter');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists and reloads the configured groups', () => {
    setCustomGroups({ groups: [{ name: 'team', models: ['tum-groq'] }] });
    expect(getSetting(CUSTOM_GROUPS_SETTING_KEY)).toBeTruthy();
    expect(getCustomGroups()).toHaveLength(1);
    expect(findCustomGroup('TEAM')?.name).toBe('team');
    expect(findCustomGroup('nope')).toBeNull();
  });

  it('builds a deduped chain with a contiguous random tier order', () => {
    // Overlapping refs (unify slug + platform-qualified member) must produce
    // one chain row per distinct db id, ordered by a fresh random permutation.
    const group = customGroupSchema.parse({
      name: 'team',
      models: ['test-unify-model', 'groq:tum-groq', 'openrouter:meta-llama/llama-3.3-70b-instruct:free'],
    });
    const { chain, unresolved } = buildCustomGroupChain(group);
    expect(unresolved).toEqual([]);
    const ids = chain.map(r => r.model_db_id).sort((a, b) => a - b);
    expect(ids).toEqual([groqRow, cerebrasRow, llamaRow].sort((a, b) => a - b));
    const tiers = chain.map(r => r.match_tier);
    expect([...tiers].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 1, 2]);
  });

  it('reports member refs that match nothing as unresolved', () => {
    // NOTE: 'tum-groq' would resolve to BOTH unify-group rows (a bare member id
    // pulls the whole logical group — #651 never-shrink), so this test uses the
    // singly-named 'other-model' as the resolved ref.
    const group = customGroupSchema.parse({ name: 'team', models: ['meta-llama/llama-3.3-70b-instruct:free', 'no-such-model'] });
    const { chain, unresolved } = buildCustomGroupChain(group);
    expect(unresolved).toEqual(['no-such-model']);
    expect(chain.map(r => r.model_db_id)).toEqual([llamaRow]);
  });

  it('encodes the mocked random permutation into match_tier', () => {
    const group = customGroupSchema.parse({ name: 'team', models: ['test-unify-model'] });
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const { chain } = buildCustomGroupChain(group);
    spy.mockRestore();
    // rand=0 permutation of [groq, cerebras] (catalog-ordered from
    // resolveModelGroupCandidates) → [cerebras, groq].
    expect(chain.map(r => r.model_db_id)).toEqual([cerebrasRow, groqRow]);
    expect(chain[0].match_tier).toBe(0);
    expect(chain[1].match_tier).toBe(1);
  });

  it('varies which member lands first across real draws', () => {
    const group = customGroupSchema.parse({ name: 'team', models: ['test-unify-model'] });
    const firsts = new Set<number>();
    for (let i = 0; i < 40; i++) {
      firsts.add(buildCustomGroupChain(group).chain[0].model_db_id);
    }
    expect(firsts.size).toBe(2);
  });

  it('returns null for virtual ids, unknown names, and catalog ids (catalog wins)', () => {
    expect(resolveCustomGroupDispatch(undefined)).toBeNull();
    expect(resolveCustomGroupDispatch('')).toBeNull();
    expect(resolveCustomGroupDispatch('auto')).toBeNull();
    expect(resolveCustomGroupDispatch('fusion')).toBeNull();
    expect(resolveCustomGroupDispatch('never-configured')).toBeNull();
    // A real model id keeps answering through the catalog paths.
    expect(resolveCustomGroupDispatch('tum-groq')).toBeNull();
    // A platform-qualified member id belongs to the catalog too.
    expect(resolveCustomGroupDispatch('groq:tum-groq')).toBeNull();
    // A unify canonical slug belongs to the catalog too.
    expect(resolveCustomGroupDispatch('test-unify-model')).toBeNull();
  });

  it('dispatches a configured group over its randomized member chain', () => {
    setCustomGroups({ groups: [{ name: 'team', models: ['test-unify-model'] }] });
    const dispatch = resolveCustomGroupDispatch('team');
    expect(dispatch).not.toBeNull();
    expect(dispatch!.status).toBe('ok');
    expect(dispatch!.chain.map(r => r.model_db_id).sort((a, b) => a - b))
      .toEqual([groqRow, cerebrasRow].sort((a, b) => a - b));
  });

  it('matches group names case-insensitively', () => {
    setCustomGroups({ groups: [{ name: 'Team', models: ['tum-groq'] }] });
    expect(resolveCustomGroupDispatch('TEAM')?.group.name).toBe('Team');
  });

  it('reports a disabled group instead of a chain', () => {
    setCustomGroups({ groups: [{ name: 'team', models: ['tum-groq'], enabled: false }] });
    const dispatch = resolveCustomGroupDispatch('team');
    expect(dispatch?.status).toBe('disabled');
    expect(dispatch?.chain).toHaveLength(0);
  });

  it('previews member resolution and availability', () => {
    setCustomGroups({ groups: [{ name: 'team', models: ['test-unify-model', 'no-such-model'] }] });
    const preview = previewCustomGroup(getCustomGroups()[0]);
    expect(preview.members[0].resolved).toBe(true);
    expect(preview.members[0].rows.length).toBe(2);
    expect(preview.members[1].resolved).toBe(false);
    expect(preview.resolvedRows).toHaveLength(2);
    expect(preview.routable).toBe(true);
    expect(preview.available).toBe(true);
  });
});
