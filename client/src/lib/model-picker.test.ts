import { describe, expect, it } from 'vitest'
import {
  buildPickerStats, filterSortPickerOptions, pickerFiltersActive,
  NO_PICKER_FILTERS,
  type PickerFilters,
} from './model-picker'
import type { ModelOption } from './model-groups'
import type { FallbackEntry, RoutingScore } from './routing'

// ── Fixtures ─────────────────────────────────────────────────────────────────
let nextDbId = 1
const entry = (over: Partial<FallbackEntry> & { modelId: string }): FallbackEntry => ({
  modelDbId: nextDbId++,
  priority: 1,
  effectivePriority: 1,
  penalty: 0,
  rateLimitHits: 0,
  enabled: true,
  platform: 'groq',
  displayName: over.modelId,
  intelligenceRank: 5,
  speedRank: 5,
  sizeLabel: 'Large',
  rpmLimit: null,
  rpdLimit: null,
  monthlyTokenBudget: '',
  supportsVision: false,
  supportsTools: false,
  keyCount: 1,
  ...over,
})

const score = (modelDbId: number, over: Partial<RoutingScore> = {}): RoutingScore => ({
  modelDbId,
  reliability: 0.5,
  speed: 0.5,
  intelligence: 0.5,
  headroom: 1,
  rateLimit: 1,
  score: 0.5,
  totalRequests: 10,
  ...over,
})

const opt = (value: string, label = value, platforms: string[] = ['groq']): ModelOption => ({
  value,
  label,
  platform: platforms[0],
  platforms,
  providerCount: platforms.length,
  sizeTier: 2,
  intelligenceRank: 5,
})

const f = (over: Partial<PickerFilters> = {}): PickerFilters => ({ ...NO_PICKER_FILTERS, ...over })

// ── buildPickerStats ─────────────────────────────────────────────────────────
describe('buildPickerStats', () => {
  it('keys ungrouped entries by model id and reads canonical value', () => {
    const stats = buildPickerStats([entry({ modelId: 'm1', canonicalId: 'c1' })], [])
    expect(stats.get('c1')).toBeTruthy()
    expect(stats.get('m1')).toBeUndefined()
  })

  it('groups unify members and takes the BEST member per axis', () => {
    const a = entry({ modelId: 'm1', groupKey: 'g', canonicalId: 'c' })
    const b = entry({ modelId: 'm2', groupKey: 'g', canonicalId: 'c' })
    const stats = buildPickerStats([a, b], [
      score(a.modelDbId, { reliability: 0.6, speed: 0.9, score: 0.4 }),
      score(b.modelDbId, { reliability: 0.8, speed: 0.2, score: 0.7 }),
    ])
    const s = stats.get('c')!
    expect(s.reliability).toBe(0.8) // best member, not the average
    expect(s.speed).toBe(0.9)
    expect(s.score).toBe(0.7)
  })

  it('computes guardrails as headroom × rateLimit per member, best wins', () => {
    const a = entry({ modelId: 'm1' })
    const b = entry({ modelId: 'm2', groupKey: 'm1' }) // same logical group as a
    const stats = buildPickerStats([a, b], [
      score(a.modelDbId, { headroom: 0.9, rateLimit: 0.9 }), // 0.81
      score(b.modelDbId, { headroom: 1, rateLimit: 0.95 }),  // 0.95
    ])
    expect(stats.get('m1')!.guardrails).toBe(0.95)
  })

  it('takes the largest context window across members', () => {
    const a = entry({ modelId: 'm1', groupKey: 'g', canonicalId: 'c', contextWindow: 128_000 })
    const b = entry({ modelId: 'm2', groupKey: 'g', canonicalId: 'c', contextWindow: 1_000_000 })
    const stats = buildPickerStats([a, b], [])
    expect(stats.get('c')!.contextMax).toBe(1_000_000)
  })

  it('contextMax is null when no member records a window', () => {
    const stats = buildPickerStats([entry({ modelId: 'm1' })], [])
    expect(stats.get('m1')!.contextMax).toBeNull()
  })

  it('scoreless members leave axes undefined instead of faking zero', () => {
    const stats = buildPickerStats([entry({ modelId: 'm1' })], [])
    const s = stats.get('m1')!
    expect(s.reliability).toBeUndefined()
    expect(s.guardrails).toBeUndefined()
    expect(s.score).toBeUndefined()
  })
})

// ── filterSortPickerOptions ──────────────────────────────────────────────────
describe('filterSortPickerOptions: filters', () => {
  const options = [opt('m1', 'Alpha'), opt('m2', 'Beta'), opt('m3', 'Gamma')]
  const stats = new Map([
    ['m1', { reliability: 0.9, speed: 0.2, intelligence: 0.6, guardrails: 1, score: 0.8, contextMax: 128_000 }],
    ['m2', { reliability: 0.6, speed: 0.8, intelligence: 0.4, guardrails: 0.7, score: 0.6, contextMax: 32_000 }],
    ['m3', {}], // no data at all (fresh rows)
  ])

  it('returns everything untouched with default order when nothing is set', () => {
    expect(filterSortPickerOptions(options, stats, f())).toEqual(options)
  })

  it('filters by quality bands and excludes models without data for the axis', () => {
    const out = filterSortPickerOptions(options, stats, f({ reliability: 'ge70' }))
    expect(out.map(o => o.value)).toEqual(['m1']) // m2 below band, m3 no data
    expect(filterSortPickerOptions(options, stats, f({ reliability: 'ge50' })).map(o => o.value)).toEqual(['m1', 'm2'])
  })

  it('filters speed, intelligence, score and guardrails the same way', () => {
    expect(filterSortPickerOptions(options, stats, f({ speed: 'ge70' })).map(o => o.value)).toEqual(['m2'])
    expect(filterSortPickerOptions(options, stats, f({ intelligence: 'ge50' })).map(o => o.value)).toEqual(['m1'])
    expect(filterSortPickerOptions(options, stats, f({ score: 'ge70' })).map(o => o.value)).toEqual(['m1'])
    expect(filterSortPickerOptions(options, stats, f({ guard: 'ge08' })).map(o => o.value)).toEqual(['m1'])
    expect(filterSortPickerOptions(options, stats, f({ guard: 'ge095' })).map(o => o.value)).toEqual(['m1'])
  })

  it('filters context with the Models-page buckets', () => {
    expect(filterSortPickerOptions(options, stats, f({ context: 'ge32k' })).map(o => o.value)).toEqual(['m1', 'm2'])
    expect(filterSortPickerOptions(options, stats, f({ context: 'ge128k' })).map(o => o.value)).toEqual(['m1'])
    expect(filterSortPickerOptions(options, stats, f({ context: 'ge1m' }))).toEqual([])
  })

  it('search matches label and id case-insensitively; provider filters by platforms', () => {
    expect(filterSortPickerOptions(options, stats, f({ query: 'ALPH' })).map(o => o.value)).toEqual(['m1'])
    expect(filterSortPickerOptions(options, stats, f({ query: 'm2' })).map(o => o.value)).toEqual(['m2'])
    expect(filterSortPickerOptions(options, stats, f({ provider: 'openrouter' }))).toEqual([])
  })
})

describe('filterSortPickerOptions: sort', () => {
  const options = [opt('m1', 'Charlie'), opt('m2', 'Alpha'), opt('m3', 'Bravo')]
  const stats = new Map<string, any>([
    ['m1', { reliability: 0.6, score: 0.4, contextMax: 32_000 }],
    ['m2', { reliability: 0.9, score: 0.9, contextMax: 1_000_000 }],
    // m3: no data — must sink on every axis sort
  ])

  it('sorts descending by the axis with no-data last and label tiebreak', () => {
    expect(filterSortPickerOptions(options, stats, f({ sortBy: 'reliability' })).map(o => o.value)).toEqual(['m2', 'm1', 'm3'])
    expect(filterSortPickerOptions(options, stats, f({ sortBy: 'score' })).map(o => o.value)).toEqual(['m2', 'm1', 'm3'])
  })

  it('sorts context by window size', () => {
    expect(filterSortPickerOptions(options, stats, f({ sortBy: 'context' })).map(o => o.value)).toEqual(['m2', 'm1', 'm3'])
  })

  it('sorts ascending on the second header click without un-sinking no-data rows', () => {
    expect(filterSortPickerOptions(options, stats, f({ sortBy: 'reliability', sortDir: 'asc' })).map(o => o.value)).toEqual(['m1', 'm2', 'm3'])
  })

  it('falls back to score, then intelligence, on ties — same direction as the primary', () => {
    // speed ties at 0.8: score decides desc (0.9 before 0.4)
    const opts = [opt('m1', 'Alpha'), opt('m2', 'Beta')]
    const st = new Map<string, any>([
      ['m1', { speed: 0.8, score: 0.4, intelligence: 0.9 }],
      ['m2', { speed: 0.8, score: 0.9, intelligence: 0.2 }],
    ])
    expect(filterSortPickerOptions(opts, st, f({ sortBy: 'speed' })).map(o => o.value)).toEqual(['m2', 'm1'])
    // asc flips the fallback too
    expect(filterSortPickerOptions(opts, st, f({ sortBy: 'speed', sortDir: 'asc' })).map(o => o.value)).toEqual(['m1', 'm2'])
    // score ties at 0.9: intelligence decides
    const st2 = new Map<string, any>([
      ['m1', { speed: 0.1, score: 0.9, intelligence: 0.3 }],
      ['m2', { speed: 0.2, score: 0.9, intelligence: 0.8 }],
    ])
    expect(filterSortPickerOptions(opts, st2, f({ sortBy: 'score' })).map(o => o.value)).toEqual(['m2', 'm1'])
  })

  it('orders raw intelligence: 1.0 stays ahead of 0.9971 (bars show 100.00 vs 99.71)', () => {
    // The GLM-5.2 vs MiniMax M3 case: the bars display two decimals, so the
    // visible order IS the raw order — MiniMax M3 (100.00) correctly first,
    // no fallback needed.
    const opts = [opt('glm-5.2', 'GLM-5.2'), opt('minimax-m3', 'MiniMax M3')]
    const st = new Map<string, any>([
      ['glm-5.2', { intelligence: 0.9971, score: 0.817 }],
      ['minimax-m3', { intelligence: 1.0, score: 0.706 }],
    ])
    expect(filterSortPickerOptions(opts, st, f({ sortBy: 'intelligence' })).map(o => o.value)).toEqual(['minimax-m3', 'glm-5.2'])
  })

  it('falls back to score only on EXACT intelligence ties', () => {
    const opts = [opt('glm-5.2', 'GLM-5.2'), opt('minimax-m3', 'MiniMax M3')]
    const st = new Map<string, any>([
      ['glm-5.2', { intelligence: 1, score: 0.817 }],
      ['minimax-m3', { intelligence: 1, score: 0.706 }],
    ])
    expect(filterSortPickerOptions(opts, st, f({ sortBy: 'intelligence' })).map(o => o.value)).toEqual(['glm-5.2', 'minimax-m3'])
  })

  it('filter bands compare raw values (0.6999 fails ≥70, 0.7 passes)', () => {
    const opts = [opt('m1'), opt('m2'), opt('m3')]
    const st = new Map<string, any>([
      ['m1', { reliability: 0.6999 }],
      ['m2', { reliability: 0.5 }],
      ['m3', { reliability: 0.7 }],
    ])
    expect(filterSortPickerOptions(opts, st, f({ reliability: 'ge70' })).map(o => o.value)).toEqual(['m3'])
  })

  it('walks the whole fallback chain: reliability ties → score ties → speed decides', () => {
    const opts = [opt('m1', 'Alpha'), opt('m2', 'Beta')]
    const st = new Map<string, any>([
      ['m1', { reliability: 0.9, score: 0.7, speed: 0.2 }],
      ['m2', { reliability: 0.9, score: 0.7, speed: 0.6 }],
    ])
    expect(filterSortPickerOptions(opts, st, f({ sortBy: 'reliability' })).map(o => o.value)).toEqual(['m2', 'm1'])
  })

  it('skips fallback axes without data instead of sinking them', () => {
    const opts = [opt('m1', 'Alpha'), opt('m2', 'Beta'), opt('m3', 'Gamma')]
    const st = new Map<string, any>([
      // all tie on speed; m1 has NO score → chain skips to intelligence
      ['m1', { speed: 0.8, intelligence: 0.3 }],
      ['m2', { speed: 0.8, score: 0.5, intelligence: 0.9 }],
      ['m3', { speed: 0.8, score: 0.9, intelligence: 0.1 }],
    ])
    // desc: score first among m2/m3 → m3 (0.9) before m2 (0.5); m1's missing score is skipped, not sunk
    expect(filterSortPickerOptions(opts, st, f({ sortBy: 'speed' })).map(o => o.value)).toEqual(['m3', 'm2', 'm1'])
  })

  it('ties break alphabetically', () => {
    const tied = new Map<string, any>([
      ['m1', { reliability: 0.5 }],
      ['m2', { reliability: 0.5 }],
    ])
    expect(filterSortPickerOptions([opt('m1', 'Charlie'), opt('m2', 'Alpha')], tied, f({ sortBy: 'reliability' })).map(o => o.value)).toEqual(['m2', 'm1'])
  })
})

// ── pickerFiltersActive ──────────────────────────────────────────────────────
describe('pickerFiltersActive', () => {
  it('is false when only the sort differs', () => {
    expect(pickerFiltersActive(f({ sortBy: 'score' }))).toBe(false)
  })
  it('is true when any dimension filter is set', () => {
    expect(pickerFiltersActive(f({ guard: 'ge08' }))).toBe(true)
    expect(pickerFiltersActive(f({ context: 'ge32k' }))).toBe(true)
  })
})
