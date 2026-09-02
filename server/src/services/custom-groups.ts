/**
 * Custom model groups — "自定义模型组" (operator-defined model pools addressed
 * BY GROUP NAME as the request's model id; a matching request picks a RANDOM
 * member of the group per call).
 *
 * Design constraints (deliberate, so upstream fork merges stay cheap):
 *  - This file is a SEPARATE logic route. Nothing here modifies the unify
 *    grouping, the router's scoring, or any dispatch loop. The only thing it
 *    produces for the request path is an ordered ChainRow[] handed to the
 *    EXISTING routeRequest() as a prefetched strict chain — the same shape a
 *    unified-group pin already uses — so failover, cooldowns, key rotation,
 *    accounting, streaming integrity, and tool handling are all inherited
 *    unchanged from the normal pinned-model path.
 *  - The random member choice is encoded as match_tier = position on each
 *    chain row. orderChain() sorts by match_tier FIRST (it is the one key a
 *    score must never override), so the shuffle survives routeRequest's
 *    re-ordering under every routing strategy without touching router.ts.
 *    Semantically match_tier already means "may only serve once every lower
 *    tier is exhausted" — exactly the failover-within-group order we want.
 *  - Fusion-style features were considered and NOT copied here: this feature
 *    dispatches ONE random model per request (with in-group failover), it does
 *    not fan out or synthesize, so there is nothing to duplicate.
 *
 * Storage: one JSON blob in the existing `settings` table (same pattern as the
 * unify overrides and the saved fusion config) — NO schema migration.
 *
 * Precedence (critical for backward compatibility): a requested id that the
 * CATALOG can already serve — a real model_id, a platform:model_id member id,
 * a custom:model#endpoint qualified id, or a unify canonical slug — ALWAYS
 * resolves through the existing paths. Custom groups are only consulted when
 * the catalog has no answer, so no existing id can change behavior.
 */
import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { getModelGroups, resolveRequestedIdForDispatch } from './model-groups.js';
import { resolveModelGroupCandidates, type ChainRow } from './router.js';

// ── Settings key ─────────────────────────────────────────────────────────────
export const CUSTOM_GROUPS_SETTING_KEY = 'custom_model_groups';

// ── Schema ───────────────────────────────────────────────────────────────────
export const CUSTOM_GROUP_STRATEGIES = ['random', 'synthesize', 'best_of'] as const;
export type CustomGroupStrategy = (typeof CUSTOM_GROUP_STRATEGIES)[number];

export const customGroupSchema = z.object({
  // The callable model id. Restricted to a URL/catalog-safe charset so it can
  // never collide with the structured id forms the resolver understands
  // (platform:model, custom:model#endpoint, auto:*, fusion:* use separators
  // this charset forbids).
  name: z.string().trim().min(1).max(64),
  // Free-form operator note, surfaced in the dashboard only.
  description: z.string().max(300).optional().default(''),
  // Member model refs, resolved at REQUEST time (not save time) so a group
  // survives catalog re-scans. Each ref may be a bare model_id, a
  // platform:model_id member id, a custom:model#endpoint qualified id, or a
  // unify canonical slug — anything resolveRequestedIdForDispatch answers.
  models: z.array(z.string().trim().min(1).max(256)).min(1).max(64),
  // How a member is chosen per request:
  //  - 'random' (default): one member serves (uniform shuffle); the rest are
  //    the in-group failover order — the strict-chain path.
  //  - 'synthesize' / 'best_of': the group FANS OUT to every member in
  //    parallel (copied fusion semantics — services/custom-group-strategies.ts):
  //    'synthesize' blends the answers with a judge call; 'best_of' returns the
  //    strongest single answer without a judge. N× token cost per request.
  strategy: z.enum(CUSTOM_GROUP_STRATEGIES).default('random'),
  // Attach per-model panel answers + judge metadata under `x_fusion` in the
  // response (same field name/shape the virtual `fusion` model uses). Only
  // meaningful for the fan-out strategies.
  expose_panel: z.boolean().optional().default(false),
  // A disabled group stops answering (404) without losing its configuration.
  enabled: z.boolean().default(true),
});

export const customGroupsConfigSchema = z.object({
  groups: z.array(customGroupSchema).default([]),
});

export type CustomGroup = z.infer<typeof customGroupSchema>;
export type CustomGroupsConfig = z.infer<typeof customGroupsConfigSchema>;

const EMPTY_CONFIG: CustomGroupsConfig = { groups: [] };

// Group names that must never shadow a virtual id the routes intercept before
// any pin resolution. (auto:* / fusion:* forms are already impossible via the
// charset, but keep the bare ids explicit.)
const RESERVED_GROUP_NAMES = new Set(['auto', 'fusion']);

// ── Name validation ──────────────────────────────────────────────────────────
// Returns a human-readable problem, or null when the name is usable. Shared by
// the settings API (save time) so bad names are rejected with a clear message
// instead of silently shadowing — or being shadowed by — something else.
export function validateCustomGroupName(name: string, allGroups: CustomGroup[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'group name must not be empty';
  if (trimmed.length > 64) return 'group name must be at most 64 characters';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) {
    return 'group name may only contain letters, digits, ".", "_" and "-", and must start with a letter or digit';
  }
  const lower = trimmed.toLowerCase();
  if (RESERVED_GROUP_NAMES.has(lower)) return `'${trimmed}' is a reserved virtual model id`;
  // Case-insensitive uniqueness across the whole configured set.
  const clash = allGroups.find(g => g.name.trim().toLowerCase() === lower);
  if (clash) return `another group already uses this name (case-insensitive): '${clash.name}'`;
  return null;
}

// ── Settings accessors ───────────────────────────────────────────────────────
export function getCustomGroupsConfig(): CustomGroupsConfig {
  const raw = getSetting(CUSTOM_GROUPS_SETTING_KEY);
  if (!raw) return EMPTY_CONFIG;
  try {
    const parsed = customGroupsConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch { /* corrupt JSON → safe default */ }
  return EMPTY_CONFIG;
}

export function getCustomGroups(): CustomGroup[] {
  return getCustomGroupsConfig().groups;
}

/**
 * Full-replace save (the same contract the unify overrides PUT uses). Throws a
 * zod error on schema violations and a plain Error on name problems, so the
 * settings route can render either as a 400.
 */
export function setCustomGroups(input: unknown): CustomGroupsConfig {
  const norm = customGroupsConfigSchema.parse(input);
  // Names must be unique case-insensitively; validate each against the rest.
  for (let i = 0; i < norm.groups.length; i++) {
    const group = norm.groups[i];
    const others = norm.groups.filter((_, j) => j !== i);
    const problem = validateCustomGroupName(group.name, others);
    if (problem) {
      throw new Error(`group '${group.name}': ${problem}`);
    }
  }
  setSetting(CUSTOM_GROUPS_SETTING_KEY, JSON.stringify(norm));
  return norm;
}

// Exact (case-insensitive) group lookup by the requested model id.
export function findCustomGroup(name: string): CustomGroup | null {
  const lower = name.trim().toLowerCase();
  if (!lower) return null;
  return getCustomGroups().find(g => g.name.trim().toLowerCase() === lower) ?? null;
}

// ── Member resolution + random ordering ──────────────────────────────────────
export function shuffleMembers<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface CustomGroupChain {
  /** Shuffled strict chain — hand to routeRequest() as prefetchedChain. */
  chain: ChainRow[];
  /** Member refs that matched no enabled catalog row (reported, not routed). */
  unresolved: string[];
}

/**
 * Resolve every member ref to catalog rows and lay them out in a fresh random
 * order. Deduped by db id (two refs may overlap, e.g. gpt-oss-120b and
 * groq:gpt-oss-120b); every resolved row participates once.
 *
 * Rows come from resolveModelGroupCandidates, which only returns catalog-
 * ENABLED rows — a member that exists but is disabled simply doesn't
 * contribute. Capability/context filtering is deliberately left to
 * routeRequest, which already skips a candidate that cannot serve THIS
 * request (vision/tools/structured output/window) and falls to the next
 * member — randomness first, but never at the cost of a request a later
 * member could have served.
 */
export function buildCustomGroupChain(group: CustomGroup): CustomGroupChain {
  const unifyGroups = getModelGroups();
  const byDbId = new Map<number, ChainRow>();
  const unresolved: string[] = [];

  for (const ref of group.models) {
    const resolved = resolveRequestedIdForDispatch(ref, unifyGroups);
    if (!resolved || resolved.memberDbIds.length === 0) {
      unresolved.push(ref);
      continue;
    }
    // Equal-tier: no demoted ids — every resolved row is a full member.
    const rows = resolveModelGroupCandidates(resolved.memberDbIds);
    if (rows.length === 0) {
      unresolved.push(ref);
      continue;
    }
    for (const row of rows) {
      if (!byDbId.has(row.model_db_id)) byDbId.set(row.model_db_id, row);
    }
  }

  // Fisher–Yates over the deduped members; match_tier = position makes the
  // random permutation survive orderChain's tier-first sort (see file header).
  const shuffled = shuffleMembers([...byDbId.values()]);
  shuffled.forEach((row, index) => { row.match_tier = index; });
  return { chain: shuffled, unresolved };
}

// ── Request-path resolution ──────────────────────────────────────────────────
export type CustomGroupDispatchStatus = 'ok' | 'disabled';

export interface CustomGroupDispatch {
  group: CustomGroup;
  status: CustomGroupDispatchStatus;
  chain: ChainRow[];
  unresolved: string[];
}

/**
 * The one call the inference routes make. Returns
 *  - null          → the id is not a custom group (not configured, or claimed
 *                    by the catalog — see below); the caller falls through to
 *                    its existing resolution unchanged;
 *  - status 'ok'   → chain is the randomized strict chain (possibly empty,
 *                    meaning no member resolved to an enabled row);
 *  - status 'disabled' → the group exists but is switched off; callers render
 *                    the same 404 a disabled catalog model gets.
 *
 * Catalog-wins guard: a configured group whose name equals a real model_id
 * (enabled OR disabled), a platform:model_id member id, a qualified
 * custom:model#endpoint id, or a unify canonical slug is NEVER dispatched —
 * the catalog path keeps answering it exactly as before the feature existed.
 */
export function resolveCustomGroupDispatch(requestedId: string | undefined | null): CustomGroupDispatch | null {
  const id = (requestedId ?? '').trim();
  if (!id) return null;

  // Virtual ids are intercepted earlier in every route; never treat them as
  // group names (cheap belt-and-braces — routes call this after their own
  // virtual-id checks, and the charset forbids the suffixed forms anyway).
  const lower = id.toLowerCase();
  if (lower === 'auto' || lower.startsWith('auto:') || lower === 'fusion' || lower.startsWith('fusion:')) {
    return null;
  }

  const group = findCustomGroup(id);
  if (!group) return null;

  // Catalog precedence: any catalog row with this exact model_id (even a
  // disabled one — the route then renders its own honest 404/503) or any
  // unify-resolvable id belongs to the existing paths.
  const db = getDb();
  const row = db.prepare('SELECT id FROM models WHERE model_id = ? LIMIT 1').get(id);
  if (row) return null;
  const unifyHit = resolveRequestedIdForDispatch(id, getModelGroups());
  if (unifyHit && unifyHit.memberDbIds.length > 0) return null;

  if (!group.enabled) {
    return { group, status: 'disabled', chain: [], unresolved: [] };
  }
  const { chain, unresolved } = buildCustomGroupChain(group);
  return { group, status: 'ok', chain, unresolved };
}

// ── Listing / preview (dashboard + /v1/models discovery) ────────────────────
// One availability snapshot keyed by model db id — the same "enabled AND an
// enabled key can serve it" expression the /v1/models listing uses.
interface MemberAvailRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
  supports_tools: number;
  supports_vision: number;
  enabled: number;
  available: number;
}

function memberAvailability(memberDbIds: number[]): Map<number, MemberAvailRow> {
  const out = new Map<number, MemberAvailRow>();
  if (memberDbIds.length === 0) return out;
  const db = getDb();
  const availableExpr = `
    (CASE WHEN m.enabled = 1 AND EXISTS (
        SELECT 1 FROM api_keys k
        WHERE k.platform = m.platform
          AND k.enabled = 1
          AND (m.key_id IS NULL OR k.id = m.key_id)
      ) THEN 1 ELSE 0 END)`;
  const placeholders = memberDbIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT m.id, m.platform, m.model_id, m.display_name, m.context_window,
           m.supports_tools, m.supports_vision, m.enabled, ${availableExpr} AS available
    FROM models m
    WHERE m.id IN (${placeholders})
  `).all(...memberDbIds) as MemberAvailRow[];
  for (const r of rows) out.set(r.id, r);
  return out;
}

/** One member ref's runtime resolution, for the dashboard preview. */
export interface CustomGroupMemberRow {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: number;
  available: number;
  contextWindow: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface CustomGroupMemberPreview {
  ref: string;
  rows: CustomGroupMemberRow[];
  resolved: boolean;
}

export interface CustomGroupPreview {
  group: CustomGroup;
  members: CustomGroupMemberPreview[];
  /** Union of resolved member rows (deduped by db id). */
  resolvedRows: CustomGroupMemberRow[];
  /** True when at least one resolved row is catalog-enabled. */
  routable: boolean;
  /** True when at least one resolved row can serve right now. */
  available: boolean;
}

export function previewCustomGroup(group: CustomGroup): CustomGroupPreview {
  const unifyGroups = getModelGroups();
  const members: CustomGroupMemberPreview[] = [];
  const byDbId = new Map<number, CustomGroupMemberRow>();

  for (const ref of group.models) {
    const resolved = resolveRequestedIdForDispatch(ref, unifyGroups);
    const ids = resolved?.memberDbIds ?? [];
    const avail = memberAvailability(ids);
    const rows: CustomGroupMemberRow[] = ids.map(id => {
      const r = avail.get(id);
      const row: CustomGroupMemberRow = {
        modelDbId: id,
        platform: r?.platform ?? '?',
        modelId: r?.model_id ?? '?',
        displayName: r?.display_name ?? `#${id}`,
        enabled: r?.enabled ?? 0,
        available: r?.available ?? 0,
        contextWindow: r?.context_window ?? null,
        supportsTools: r?.supports_tools === 1,
        supportsVision: r?.supports_vision === 1,
      };
      if (!byDbId.has(id)) byDbId.set(id, row);
      return row;
    });
    members.push({ ref, rows, resolved: rows.length > 0 });
  }

  const resolvedRows = [...byDbId.values()];
  return {
    group,
    members,
    resolvedRows,
    routable: resolvedRows.some(r => r.enabled === 1),
    available: resolvedRows.some(r => r.enabled === 1 && r.available === 1),
  };
}

export function previewCustomGroups(): CustomGroupPreview[] {
  return getCustomGroups().map(previewCustomGroup);
}

// ── /v1/models discovery entries ─────────────────────────────────────────────
export interface CustomGroupDiscoveryEntry {
  id: string;
  name: string;
  contextWindow: number | null;
  available: boolean;
  platforms: string[];
  supportsTools: boolean;
}

/**
 * One entry per enabled group, shaped for the OpenAI-style /v1/models listing.
 * Context = max member window (a caller packing to it may land on the biggest
 * member); tools advertise ANY-enabled-member capability because routing
 * filters per request anyway; the id is only listed when NO catalog entry
 * claims it (mirrors the claude-family entries' collision filter).
 */
export function customGroupDiscoveryEntries(takenIds: ReadonlySet<string>): CustomGroupDiscoveryEntry[] {
  const out: CustomGroupDiscoveryEntry[] = [];
  for (const group of getCustomGroups()) {
    if (!group.enabled) continue;
    if (takenIds.has(group.name)) continue;
    const preview = previewCustomGroup(group);
    if (!preview.routable) continue;
    const windows = preview.resolvedRows
      .filter(r => r.enabled === 1)
      .map(r => r.contextWindow)
      .filter((w): w is number => w != null);
    const strategyNote = group.strategy === 'synthesize'
      ? 'answers fused into one by a judge'
      : group.strategy === 'best_of'
      ? 'the strongest member answer is returned'
      : 'one member chosen at random per request';
    out.push({
      id: group.name,
      name: `${group.name} (custom model group — ${strategyNote})`,
      contextWindow: windows.length ? Math.max(...windows) : null,
      available: preview.available,
      platforms: [...new Set(preview.resolvedRows.filter(r => r.enabled === 1).map(r => r.platform))],
      supportsTools: preview.resolvedRows.some(r => r.enabled === 1 && r.supportsTools),
    });
  }
  return out;
}
