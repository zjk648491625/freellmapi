// Pure sort/filter/selection logic for the model-group member picker (the
// Groups page's model list). Extracted from the page component so the seven
// dimensions (稳定/速度/智能/护栏/评分/上下文/发布时间) are unit-testable —
// the same pattern as lib/fusion-filter.ts. No React, no fetch: data in,
// options out.
import type { ModelOption } from './model-groups'
import type { FallbackEntry, RoutingScore } from './routing'

// Sort axes over the picker's logical models. 'default' keeps the server's
// chain order (the same order the option list arrives in).
export type SortKey = 'default' | 'reliability' | 'speed' | 'intelligence' | 'guardrails' | 'score' | 'context'

// Quality bands on the 0..1 routing axes (rendered ×100, e.g. '≥ 70').
export type QualityBand = 'any' | 'ge50' | 'ge70' | 'ge85'
export const QUALITY_BANDS: { key: QualityBand; min: number }[] = [
  { key: 'any', min: 0 },
  { key: 'ge50', min: 0.5 },
  { key: 'ge70', min: 0.7 },
  { key: 'ge85', min: 0.85 },
]

// Guardrails band (headroom × rate-limit multiplier — the same value the
// Models table's guardrails cell shows). 1.0 = not being held back.
export type GuardBand = 'any' | 'ge08' | 'ge095'
export const GUARD_BANDS: { key: GuardBand; min: number }[] = [
  { key: 'any', min: 0 },
  { key: 'ge08', min: 0.8 },
  { key: 'ge095', min: 0.95 },
]

// Context band — the SAME buckets the Models page toolbar uses (32K+/128K+/1M+;
// numeric labels are not localized there either).
export type ContextBand = 'any' | 'ge32k' | 'ge128k' | 'ge1m'
export const CONTEXT_BANDS: { key: ContextBand; min: number; label: string }[] = [
  { key: 'any', min: 0, label: '' },
  { key: 'ge32k', min: 32_000, label: '32K+' },
  { key: 'ge128k', min: 128_000, label: '128K+' },
  { key: 'ge1m', min: 1_000_000, label: '1M+' },
]

// Per-logical-model aggregates for sort/filter. Groups inherit the BEST
// member's axis value (the same convention the Models table uses: a group is
// as good as its best provider), and the EARLIEST first-seen date.
export interface PickerOptionStats {
  reliability?: number
  speed?: number
  intelligence?: number
  guardrails?: number
  score?: number
  contextMax?: number | null
}

/**
 * Group the fallback entries the SAME way buildModelOptions does (key =
 * groupKey ?? modelId, value = canonicalId ?? modelId) and aggregate each
 * option's stats, so the flat picker options and the stats line up without
 * touching the shared helper. Scoreless members (fresh rows with no traffic)
 * contribute nothing to an axis rather than a fake zero.
 */
export function buildPickerStats(entries: FallbackEntry[], scores: RoutingScore[]): Map<string, PickerOptionStats> {
  const groups = new Map<string, { value: string; entries: FallbackEntry[] }>()
  for (const e of entries) {
    const key = e.groupKey ?? e.modelId
    let g = groups.get(key)
    if (!g) { g = { value: e.canonicalId ?? e.modelId, entries: [] }; groups.set(key, g) }
    g.entries.push(e)
  }
  const scoreByDb = new Map(scores.map(s => [s.modelDbId, s]))
  const best = (xs: (number | undefined)[]): number | undefined => {
    const nums = xs.filter((x): x is number => x !== undefined)
    return nums.length ? Math.max(...nums) : undefined
  }
  const out = new Map<string, PickerOptionStats>()
  for (const { value, entries: members } of groups.values()) {
    const scored = members.map(e => scoreByDb.get(e.modelDbId)).filter((s): s is RoutingScore => !!s)
    out.set(value, {
      reliability: best(scored.map(s => s.reliability)),
      speed: best(scored.map(s => s.speed)),
      intelligence: best(scored.map(s => s.intelligence)),
      guardrails: best(scored.map(s => (s.headroom ?? 1) * (s.rateLimit ?? 1))),
      score: best(scored.map(s => s.score)),
      // Largest recorded window across providers; null when none is recorded.
      contextMax: members.some(e => e.contextWindow != null)
        ? Math.max(0, ...members.map(e => e.contextWindow ?? 0))
        : null,
    })
  }
  return out
}

export interface PickerFilters {
  // Case-insensitive substring over label + id; '' = off.
  query: string
  // Platform name, or null for "all providers".
  provider: string | null
  reliability: QualityBand
  speed: QualityBand
  intelligence: QualityBand
  guard: GuardBand
  score: QualityBand
  context: ContextBand
  sortBy: SortKey
  // Click-to-sort direction on the column headers ('desc' = best first).
  sortDir: 'desc' | 'asc'
}


// Tie-break chain for column sorts: when the chosen axis ties, fall through
// the remaining axes in this fixed priority — score first (the composite
// ranking is the best single tiebreaker), then intelligence, then the measured
// axes, then guardrails/context. The primary axis itself is skipped, and the
// fallback comparison runs in the SAME direction as the primary sort.
export const SORT_FALLBACK_CHAIN: Exclude<SortKey, 'default'>[] = ['score', 'intelligence', 'reliability', 'speed', 'guardrails', 'context']

export const NO_PICKER_FILTERS: PickerFilters = {
  query: '',
  provider: null,
  reliability: 'any',
  speed: 'any',
  intelligence: 'any',
  guard: 'any',
  score: 'any',
  context: 'any',
  sortBy: 'default',
  sortDir: 'desc',
}

export function pickerFiltersActive(f: PickerFilters): boolean {
  return f.reliability !== 'any' || f.speed !== 'any' || f.intelligence !== 'any'
    || f.guard !== 'any' || f.score !== 'any' || f.context !== 'any'
}

/**
 * Search + provider + the six dimension filters, then the sort. Active
 * filters EXCLUDE options without data for that axis (an unmeasured model
 * can't prove it belongs in a quality band); the sort sinks those to the end
 * instead (descending, ties by label).
 */
export function filterSortPickerOptions(
  options: ModelOption[],
  stats: Map<string, PickerOptionStats>,
  f: PickerFilters,
): ModelOption[] {
  const q = f.query.trim().toLowerCase()
  const qualityMin = (band: QualityBand) => QUALITY_BANDS.find(b => b.key === band)!.min
  const guardMin = GUARD_BANDS.find(b => b.key === f.guard)!.min
  const ctxMin = CONTEXT_BANDS.find(b => b.key === f.context)!.min
  const axisValue = (o: ModelOption, key: Exclude<SortKey, 'default'>): number | null => {
    const s = stats.get(o.value)
    if (!s) return null
    let v: number | null = null
    switch (key) {
      case 'reliability': v = s.reliability ?? null; break
      case 'speed': v = s.speed ?? null; break
      case 'intelligence': v = s.intelligence ?? null; break
      case 'guardrails': v = s.guardrails ?? null; break
      case 'score': v = s.score ?? null; break
      case 'context': v = s.contextMax ?? null; break
      default: v = null
    }
    // Compare RAW values: the bars display two decimals (99.71), so the
    // visible order already matches the underlying ordering. Only EXACT ties
    // fall through to the score tiebreaker.
    return v
  }
  const passes = (o: ModelOption): boolean => {
    if (f.provider && !o.platforms.includes(f.provider)) return false
    if (q && !o.label.toLowerCase().includes(q) && !o.value.toLowerCase().includes(q)) return false
    // Bands compare the same quantized (displayed) values the sort uses.
    const at = (key: Exclude<SortKey, 'default'>): number | null => axisValue(o, key)
    if (f.reliability !== 'any' && (at('reliability') === null || at('reliability')! < qualityMin(f.reliability))) return false
    if (f.speed !== 'any' && (at('speed') === null || at('speed')! < qualityMin(f.speed))) return false
    if (f.intelligence !== 'any' && (at('intelligence') === null || at('intelligence')! < qualityMin(f.intelligence))) return false
    if (f.score !== 'any' && (at('score') === null || at('score')! < qualityMin(f.score))) return false
    if (f.guard !== 'any' && (at('guardrails') === null || at('guardrails')! < guardMin)) return false
    if (f.context !== 'any' && (at('context') === null || at('context')! < ctxMin)) return false
    return true
  }
  const filtered = options.filter(passes)
  if (f.sortBy === 'default') return filtered
  // 'desc' = best/highest first; 'asc' = the reverse. Options with no data on
  // the PRIMARY axis sink to the end in BOTH directions. Ties fall through the
  // fallback chain (score → intelligence → reliability → speed → guardrails →
  // context, primary skipped) in the SAME direction; axes without data are
  // skipped rather than sinking. Still tied → alphabetical.
  const dir = f.sortDir === 'asc' ? 1 : -1
  const primary = f.sortBy
  return [...filtered].sort((a, b) => {
    const va = axisValue(a, primary)
    const vb = axisValue(b, primary)
    if (va === null && vb === null) return a.label.localeCompare(b.label)
    if (va === null) return 1
    if (vb === null) return -1
    if (va !== vb) return dir * (va - vb)
    for (const key of SORT_FALLBACK_CHAIN) {
      if (key === primary) continue
      const fa = axisValue(a, key)
      const fb = axisValue(b, key)
      if (fa === null || fb === null || fa === fb) continue
      return dir * (fa - fb)
    }
    return a.label.localeCompare(b.label)
  })
}