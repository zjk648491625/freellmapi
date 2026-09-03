import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, ChevronUp, Layers, Pencil, Plus, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { buildModelOptions } from '@/lib/model-groups'
import {
  buildPickerStats, filterSortPickerOptions, pickerFiltersActive,
  QUALITY_BANDS, GUARD_BANDS, CONTEXT_BANDS,
  type SortKey, type QualityBand, type GuardBand, type ContextBand,
} from '@/lib/model-picker'
import { formatContext, type FallbackEntry, type RoutingData } from '@/lib/routing'
import { AxisBar, AxisNoData } from '@/components/model-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Tooltip } from '@/components/tooltip'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { useI18n } from '@/i18n'

// 自定义模型组 (custom model groups): operator-defined model pools addressed by
// the group NAME as the request's model id — the server picks a random member
// per call and fails over inside the group. This page only edits configuration;
// all routing semantics live server-side (services/custom-groups.ts).

interface MemberRow {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  enabled: number
  available: number
}

interface MemberPreview {
  ref: string
  rows: MemberRow[]
  resolved: boolean
}

interface GroupPayload {
  name: string
  description: string
  models: string[]
  strategy: 'random' | 'synthesize' | 'best_of'
  expose_panel?: boolean
  enabled: boolean
  members: MemberPreview[]
  resolvedRows: MemberRow[]
  routable: boolean
  available: boolean
}

interface GroupsResponse {
  groups: GroupPayload[]
}

interface DraftGroup {
  name: string
  description: string
  models: string[]
  strategy: 'random' | 'synthesize' | 'best_of'
  expose_panel: boolean
  enabled: boolean
}

const PROVIDER_ALL = '__all__'

// One compact dimension picker in the member toolbar: a tiny axis label plus a
// small select. Shared by the sort control and the seven filter controls.
// One sortable column header in the member picker's table. Renders the axis
// label with a direction chevron when active; `tip` adds a help tooltip
// (guardrails semantics, score semantics, first-seen caveat).
function SortTh({ k, label, tip, align = 'left', sortBy, sortDir, onSort }: {
  k: Exclude<SortKey, 'default'>
  label: string
  tip?: string
  /** Match the data cells below: the mono value columns sit right. */
  align?: 'left' | 'right'
  sortBy: SortKey
  sortDir: 'desc' | 'asc'
  onSort: (k: Exclude<SortKey, 'default'>) => void
}) {
  const active = sortBy === k
  const button = (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={`inline-flex items-center gap-0.5 whitespace-nowrap ${
        active ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
      {active && (sortDir === 'desc' ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />)}
    </button>
  )
  return (
    <th className={`py-1.5 font-medium ${align === 'right' ? 'text-right pr-3' : 'pr-2'}`}>
      {tip ? <Tooltip text={tip}><span className="cursor-help underline decoration-dotted underline-offset-2">{button}</span></Tooltip> : button}
    </th>
  )
}

// One compact dimension-filter row inside the filters popover: axis label on
// the left, a small threshold select on the right.
function PickerFilterRow({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  const current = options.find(o => o.value === value)
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground whitespace-nowrap">{label}</span>
      <Select value={value} onValueChange={v => onChange(v ?? 'any')}>
        <SelectTrigger className="h-7 w-28 px-2 text-xs" aria-label={label}>
          <SelectValue>{current?.label ?? options[0]?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {options.map(o => (
            <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function toDraft(g: GroupPayload): DraftGroup {
  return { name: g.name, description: g.description ?? '', models: [...g.models], strategy: g.strategy ?? 'random', expose_panel: g.expose_panel ?? false, enabled: g.enabled ?? true }
}

export default function ModelGroupsPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery<GroupsResponse>({
    queryKey: ['custom-model-groups'],
    queryFn: () => apiFetch('/api/custom-model-groups'),
  })
  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  // Live routing scores for the picker's sort/filter axes. Same query key the
  // Models page uses, so both share one cache entry and no extra fetch.
  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
  })

  // Member picker options — same logical-model flattening the fusion panel
  // picker uses (one option per unify group when unification is on).
  const availableModels = useMemo(
    () => fallbackEntries.filter(e => e.keyCount > 0 && e.enabled),
    [fallbackEntries],
  )
  const modelOptions = useMemo(() => buildModelOptions(availableModels, true), [availableModels])

  // Per-option aggregates for sort/filter (best member's axis value per group,
  // earliest first-seen — see lib/model-picker.ts).
  const statsByValue = useMemo(
    () => buildPickerStats(availableModels, routing?.scores ?? []),
    [availableModels, routing],
  )

  const [drafts, setDrafts] = useState<DraftGroup[]>([])
  // Index of the group currently expanded for editing; null = read-only list.
  const [editing, setEditing] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState<string>(PROVIDER_ALL)
  // Picker sort/filter state (page-level, shared across the group editors).
  // Sort comes from clicking the list's column headers: 1st click sorts the
  // axis descending (best first), 2nd flips ascending, 3rd clears it.
  const [sortBy, setSortBy] = useState<SortKey>('default')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const [reliabilityBand, setReliabilityBand] = useState<QualityBand>('any')
  const [speedBand, setSpeedBand] = useState<QualityBand>('any')
  const [intelligenceBand, setIntelligenceBand] = useState<QualityBand>('any')
  const [guardBand, setGuardBand] = useState<GuardBand>('any')
  const [scoreBand, setScoreBand] = useState<QualityBand>('any')
  const [contextBand, setContextBand] = useState<ContextBand>('any')

  // Hydrate the draft from the server once it loads (and after saves).
  useEffect(() => {
    if (!data) return
    setDrafts(data.groups.map(toDraft))
    setEditing(null)
  }, [data])

  const saveMutation = useMutation({
    mutationFn: (body: { groups: DraftGroup[] }) =>
      apiFetch<GroupsResponse>('/api/custom-model-groups', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (res) => queryClient.setQueryData(['custom-model-groups'], res),
  })

  const providers = useMemo(
    () => [...new Set(modelOptions.flatMap(o => o.platforms))].sort(),
    [modelOptions],
  )
  const pickerFilters = useMemo(() => ({
    query,
    provider: provider === PROVIDER_ALL ? null : provider,
    reliability: reliabilityBand,
    speed: speedBand,
    intelligence: intelligenceBand,
    guard: guardBand,
    score: scoreBand,
    context: contextBand,
    sortBy,
    sortDir,
  }), [query, provider, reliabilityBand, speedBand, intelligenceBand, guardBand, scoreBand, contextBand, sortBy, sortDir])
  // Whether any filter (not sort) is active — drives the clear-filters chip.
  const filtersActive = pickerFiltersActive(pickerFilters)

  // Visible picker options: search + provider + the seven dimension filters,
  // then the sort (lib/model-picker.ts — filters exclude options without data
  // for an active axis; the sort sinks them to the end instead).
  const visibleModels = useMemo(
    () => filterSortPickerOptions(modelOptions, statsByValue, pickerFilters),
    [modelOptions, statsByValue, pickerFilters],
  )

  // Bulk selection actions over the CURRENT view (search + filters + sort
  // applied, in sorted order). 全选 always unions every visible option into
  // the draft (idempotent); Top 10 REPLACES the whole selection with the
  // first ten of the view — picking a new top 10 never stacks on the old
  // one; 取消选中 clears every member.
  const bulkSelect = (mode: 'all' | 'top10' | 'clear') => {
    if (editing === null) return
    setDrafts(prev => prev.map((d, i) => {
      if (i !== editing) return d
      if (mode === 'clear') return { ...d, models: [] }
      if (mode === 'top10') return { ...d, models: visibleModels.slice(0, 10).map(o => o.value) }
      return { ...d, models: [...d.models, ...visibleModels.map(o => o.value).filter(id => !d.models.includes(id))] }
    }))
  }
  // Column-header click cycle: desc → asc → off (default order).
  const clickSort = (key: Exclude<SortKey, 'default'>) => {
    if (sortBy === key && sortDir === 'asc') {
      setSortBy('default')
      setSortDir('desc')
    } else if (sortBy === key) {
      setSortDir('asc')
    } else {
      setSortBy(key)
      setSortDir('desc')
    }
  }
  const activeFilterCount = [reliabilityBand, speedBand, intelligenceBand, guardBand, scoreBand, contextBand]
    .filter(b => b !== 'any').length
  const clearFilters = () => {
    setReliabilityBand('any')
    setSpeedBand('any')
    setIntelligenceBand('any')
    setGuardBand('any')
    setScoreBand('any')
    setContextBand('any')
  }

  const serverGroups = data?.groups ?? []
  const hasChanges = !!data
    && (drafts.length !== serverGroups.length
      || drafts.some((d, i) => JSON.stringify(d) !== JSON.stringify(toDraft(serverGroups[i]))))

  const draftsValid = drafts.every(d => d.name.trim().length > 0 && d.models.length > 0)
    && new Set(drafts.map(d => d.name.trim().toLowerCase())).size === drafts.length

  const updateDraft = (index: number, patch: Partial<DraftGroup>) =>
    setDrafts(prev => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)))

  const toggleMember = (index: number, value: string) =>
    setDrafts(prev => prev.map((d, i) => {
      if (i !== index) return d
      const models = d.models.includes(value) ? d.models.filter(m => m !== value) : [...d.models, value]
      return { ...d, models }
    }))

  const addGroup = () => {
    setDrafts(prev => [...prev, { name: '', description: '', models: [], strategy: 'random', expose_panel: false, enabled: true }])
    setEditing(drafts.length)
    setQuery('')
    setProvider(PROVIDER_ALL)
  }

  const removeGroup = (index: number) => {
    setDrafts(prev => prev.filter((_, i) => i !== index))
    if (editing === index) setEditing(null)
  }

  return (
    <div>
      <PageHeader
        title={t('modelGroups.title')}
        description={t('modelGroups.description')}
        divider={false}
        actions={<ModelsTabs />}
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground max-w-xl">{t('modelGroups.usageHint')}</p>
            <Button size="sm" variant="outline" onClick={addGroup}>
              <Plus className="size-4 mr-1.5" />
              {t('modelGroups.addGroup')}
            </Button>
          </div>

          {drafts.length === 0 ? (
            <div className="rounded-xl border p-8 text-center">
              <p className="text-sm font-medium">{t('modelGroups.empty')}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('modelGroups.emptyHint')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {drafts.map((draft, index) => {
                // Match the saved preview BY NAME (case-insensitively), not by
                // index: add/remove while editing reindexes the drafts, and an
                // index lookup would then show another group's preview.
                const saved = serverGroups.find(g => g.name.trim().toLowerCase() === draft.name.trim().toLowerCase())
                const isEditing = editing === index
                return (
                  <div key={index} className="rounded-xl border">
                    <div className="flex items-center gap-3 p-3">
                      <Switch
                        checked={draft.enabled}
                        onCheckedChange={v => updateDraft(index, { enabled: v })}
                        aria-label={t('modelGroups.enabled')}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-medium">{draft.name.trim() || '…'}</span>
                          {saved?.available && <Badge className="text-[10px]">{t('modelGroups.availableBadge')}</Badge>}
                          {saved && !saved.available && saved.routable && <Badge variant="secondary" className="text-[10px]">{t('modelGroups.unavailableBadge')}</Badge>}
                          {!draft.enabled && <Badge variant="secondary" className="text-[10px]">{t('modelGroups.disabledBadge')}</Badge>}
                          {draft.strategy !== 'random' && <Badge variant="secondary" className="text-[10px]">{t(`modelGroups.strategy_${draft.strategy}`)}</Badge>}
                        </div>
                        {draft.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">{draft.description}</p>
                        )}
                      </div>
                      <Button size="icon" variant="ghost" onClick={() => { setEditing(isEditing ? null : index); setQuery(''); setProvider(PROVIDER_ALL) }} aria-label="edit">
                        {isEditing ? <ChevronDown className="size-4" /> : <Pencil className="size-4" />}
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => removeGroup(index)} aria-label={t('common.delete')}>
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>

                    {!isEditing && (
                      <div className="px-3 pb-3 flex flex-wrap gap-1.5">
                        {draft.models.map(ref => {
                          const preview = saved?.members.find(m => m.ref === ref)
                          return (
                            <Badge key={ref} variant="outline" className="font-normal">
                              {preview && preview.rows.length === 1 ? preview.rows[0].displayName : ref}
                              {preview && !preview.resolved && (
                                <AlertTriangle className="size-3 ml-1 text-amber-500" />
                              )}
                            </Badge>
                          )
                        })}
                        {draft.models.length === 0 && (
                          <span className="text-xs text-muted-foreground">{t('modelGroups.needName')}</span>
                        )}
                      </div>
                    )}

                    {isEditing && (
                      <div className="border-t p-3 space-y-4">
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium">{t('modelGroups.groupName')}</label>
                            <Input
                              value={draft.name}
                              onChange={e => updateDraft(index, { name: e.target.value })}
                              placeholder={t('modelGroups.groupNamePlaceholder')}
                              className="font-mono"
                            />
                            {draft.name.trim() && /[^ -~]/.test(draft.name.trim()) && (
                              <p className="text-xs text-destructive flex items-center gap-1.5">
                                <AlertTriangle className="size-3.5" />
                                {t('modelGroups.nameInvalid')}
                              </p>
                            )}
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-xs font-medium">{t('modelGroups.descriptionLabel')}</label>
                            <Input
                              value={draft.description}
                              onChange={e => updateDraft(index, { description: e.target.value })}
                              placeholder={t('modelGroups.descriptionPlaceholder')}
                            />
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-xs font-medium">
                            {t('modelGroups.members')}
                            <span className="ml-2 font-normal text-muted-foreground">
                              {t('modelGroups.selectedCount', { count: draft.models.length })}
                            </span>
                          </label>
                          <p className="text-xs text-muted-foreground">{t('modelGroups.membersHelp')}</p>
                          {/* Bulk-select / filter toolbar over the CURRENT picker
                              view. The bulk buttons sit on the LEFT and are
                              view-aware toggles (方案二): when their slice is fully
                              selected the button reads 已选择(N) and clicking again
                              removes exactly that slice — manual picks outside the
                              view are untouched. The seven dimension filters live
                              in one popover (the CustomWeightsPopover pattern);
                              sort comes from clicking the list's column headers. */}
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border bg-muted/30 p-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={editing === null || visibleModels.length === 0}
                              onClick={() => bulkSelect('all')}
                            >
                              {t('modelGroups.selectAllVisible')} ({visibleModels.length})
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={editing === null || visibleModels.length === 0}
                              onClick={() => bulkSelect('top10')}
                            >
                              {t('modelGroups.selectTop10')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={editing === null || draft.models.length === 0}
                              onClick={() => bulkSelect('clear')}
                            >
                              {t('modelGroups.clearSelection')}
                            </Button>
                            <Popover>
                              <PopoverTrigger className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs transition-colors hover:bg-muted">
                                <SlidersHorizontal className="size-3.5" />
                                {t('modelGroups.filterButton')}
                                {filtersActive && (
                                  <span className="rounded-full bg-foreground px-1.5 text-[10px] leading-4 text-background tabular-nums">{activeFilterCount}</span>
                                )}
                              </PopoverTrigger>
                              <PopoverContent align="start" className="w-64">
                                <div className="space-y-2.5">
                                  <h3 className="text-sm font-medium">{t('modelGroups.filterButton')}</h3>
                                  <PickerFilterRow
                                    label={t('modelGroups.dim_reliability')}
                                    value={reliabilityBand}
                                    onChange={v => setReliabilityBand((v ?? 'any') as QualityBand)}
                                    options={QUALITY_BANDS.map(b => ({ value: b.key, label: b.min === 0 ? t('modelGroups.filterAny') : `≥ ${Math.round(b.min * 100)}` }))}
                                  />
                                  <PickerFilterRow
                                    label={t('modelGroups.dim_speed')}
                                    value={speedBand}
                                    onChange={v => setSpeedBand((v ?? 'any') as QualityBand)}
                                    options={QUALITY_BANDS.map(b => ({ value: b.key, label: b.min === 0 ? t('modelGroups.filterAny') : `≥ ${Math.round(b.min * 100)}` }))}
                                  />
                                  <PickerFilterRow
                                    label={t('modelGroups.dim_intelligence')}
                                    value={intelligenceBand}
                                    onChange={v => setIntelligenceBand((v ?? 'any') as QualityBand)}
                                    options={QUALITY_BANDS.map(b => ({ value: b.key, label: b.min === 0 ? t('modelGroups.filterAny') : `≥ ${Math.round(b.min * 100)}` }))}
                                  />
                                  <PickerFilterRow
                                    label={t('modelGroups.dim_guardrails')}
                                    value={guardBand}
                                    onChange={v => setGuardBand((v ?? 'any') as GuardBand)}
                                    options={GUARD_BANDS.map(b => ({ value: b.key, label: b.min === 0 ? t('modelGroups.filterAny') : `≥ ${b.min}` }))}
                                  />
                                  <PickerFilterRow
                                    label={t('modelGroups.dim_score')}
                                    value={scoreBand}
                                    onChange={v => setScoreBand((v ?? 'any') as QualityBand)}
                                    options={QUALITY_BANDS.map(b => ({ value: b.key, label: b.min === 0 ? t('modelGroups.filterAny') : `≥ ${Math.round(b.min * 100)}` }))}
                                  />
                                  <PickerFilterRow
                                    label={t('modelGroups.dim_context')}
                                    value={contextBand}
                                    onChange={v => setContextBand((v ?? 'any') as ContextBand)}
                                    options={CONTEXT_BANDS.map(b => ({ value: b.key, label: b.min === 0 ? t('modelGroups.filterAny') : b.label }))}
                                  />
                                  
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 w-full text-xs text-muted-foreground"
                                    disabled={!filtersActive}
                                    onClick={clearFilters}
                                  >
                                    {t('modelGroups.filterClear')}
                                  </Button>
                                </div>
                              </PopoverContent>
                            </Popover>
                            {filtersActive && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 text-xs text-muted-foreground"
                                onClick={clearFilters}
                              >
                                {t('modelGroups.filterClear')}
                              </Button>
                            )}
                            <div className="relative ml-auto min-w-[12rem] flex-1">
                              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                              <Input
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder={t('modelGroups.searchPlaceholder')}
                                className="h-7 pl-8 text-xs"
                              />
                            </div>
                            <Select value={provider} onValueChange={v => setProvider(v ?? PROVIDER_ALL)}>
                              <SelectTrigger className="h-7 w-40 shrink-0 text-xs" aria-label={t('modelGroups.providerAll')}>
                                <SelectValue>
                                  {(v: string) => (v === PROVIDER_ALL ? t('modelGroups.providerAll') : v)}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={PROVIDER_ALL}>{t('modelGroups.providerAll')}</SelectItem>
                                {providers.map(p => (
                                  <SelectItem key={p} value={p}>{p}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {modelOptions.length === 0 ? (
                            <p className="text-xs text-muted-foreground">{t('modelGroups.noModels')}</p>
                          ) : (
                            /* Click-to-sort table (the Models page's column
                               language: AxisBar for the measured axes, mono
                               values for 护栏/评分/上下文/发布时间). Rows toggle
                               membership; headers cycle desc → asc → off. */
                            <div className="max-h-80 overflow-auto rounded-xl border">
                              <table className="w-full min-w-[640px] border-collapse text-left">
                                <thead className="sticky top-0 z-10 bg-background">
                                  <tr className="text-[11px] text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
                                    <th className="w-6 py-1.5 pl-3 pr-1" />
                                    <th className="py-1.5 pr-2 font-medium whitespace-nowrap">{t('modelGroups.members')}</th>
                                    <SortTh k="reliability" label={t('modelGroups.dim_reliability')} sortBy={sortBy} sortDir={sortDir} onSort={clickSort} />
                                    <SortTh k="speed" label={t('modelGroups.dim_speed')} sortBy={sortBy} sortDir={sortDir} onSort={clickSort} />
                                    <SortTh k="intelligence" label={t('modelGroups.dim_intelligence')} sortBy={sortBy} sortDir={sortDir} onSort={clickSort} />
                                    <SortTh k="guardrails" label={t('modelGroups.dim_guardrails')} tip={t('strategies.guardrailsTooltip')} sortBy={sortBy} sortDir={sortDir} onSort={clickSort} />
                                    <SortTh k="score" label={t('modelGroups.dim_score')} tip={t('strategies.scoreTooltip')} sortBy={sortBy} sortDir={sortDir} onSort={clickSort}  align="right" />
                                    <SortTh k="catalog" label={t('modelGroups.dim_catalog')} tip={t('modelGroups.catalogHint')} align="right" sortBy={sortBy} sortDir={sortDir} onSort={clickSort} />
                                    <SortTh k="context" label={t('modelGroups.dim_context')} sortBy={sortBy} sortDir={sortDir} onSort={clickSort}  align="right" />
                                  </tr>
                                </thead>
                                <tbody className="divide-y">
                                  {visibleModels.length === 0 ? (
                                    <tr>
                                      <td colSpan={8} className="px-3 py-6 text-center text-xs text-muted-foreground">{t('modelGroups.noMatch')}</td>
                                    </tr>
                                  ) : visibleModels.map(o => {
                                    const selected = draft.models.includes(o.value)
                                    const s = statsByValue.get(o.value)
                                    return (
                                      <tr
                                        key={o.value}
                                        onClick={() => toggleMember(index, o.value)}
                                        className={`cursor-pointer transition-colors ${
                                          selected ? 'bg-muted/50' : 'hover:bg-muted/30'
                                        }`}
                                      >
                                        <td className="py-1.5 pl-3 pr-1 align-middle">
                                          <span className={`flex size-4 items-center justify-center rounded border ${selected ? 'bg-foreground text-background' : ''}`}>
                                            {selected && <Check className="size-3" />}
                                          </span>
                                        </td>
                                        <td className="py-1.5 pr-2 align-middle">
                                          <span className="block max-w-[13rem] truncate text-xs font-medium leading-tight" title={o.label}>{o.label}</span>
                                          <span className="block max-w-[13rem] font-mono text-[10px] leading-tight text-muted-foreground/70">
                                            <span className="block truncate" title={o.value}>{o.value}</span>
                                            {o.providerCount > 1 && (
                                              <Tooltip text={t('models.servedBy', { providers: [...new Set(o.platforms)].join('\n') })}>
                                                <span className="mt-0.5 inline-block rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground not-italic">{t('models.providerCount', { count: o.providerCount })}</span>
                                              </Tooltip>
                                            )}
                                          </span>
                                        </td>
                                        <td className="py-1.5 pr-2 align-middle">{s?.reliability === undefined ? <AxisNoData /> : <AxisBar value={s.reliability} color="#22c55e" decimals={2} />}</td>
                                        <td className="py-1.5 pr-2 align-middle">{s?.speed === undefined ? <AxisNoData /> : <AxisBar value={s.speed} color="#3b82f6" decimals={2} />}</td>
                                        <td className="py-1.5 pr-2 align-middle">{s?.intelligence === undefined ? <AxisNoData /> : <AxisBar value={s.intelligence} color="#a855f7" decimals={2} />}</td>
                                        <td className="py-1.5 pr-2 align-middle font-mono text-[11px] text-muted-foreground tabular-nums">
                                          {s?.guardrails !== undefined && s.guardrails < 0.999 ? `×${s.guardrails.toFixed(2)}` : '—'}
                                        </td>
                                        <td className="py-1.5 pr-2 text-right align-middle font-mono text-[11px] tabular-nums">
                                          {s?.score !== undefined ? s.score.toFixed(3) : '–'}
                                        </td>
                                        <td className="py-1.5 pr-2 text-right align-middle font-mono text-[11px] text-muted-foreground tabular-nums" title={t('modelGroups.catalogHint')}>
                                          {s?.catalogScore !== undefined ? s.catalogScore.toFixed(1) : '–'}
                                        </td>
                                        <td className="py-1.5 pr-2 text-right align-middle font-mono text-[10px] text-muted-foreground tabular-nums">
                                          {s?.contextMax != null ? formatContext(s.contextMax) : '–'}
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>

                        {/* Member selection strategy: random draws ONE member
                            per request (strict chain); synthesize/best_of fan
                            out to EVERY member in parallel (copied fusion
                            semantics — N× token cost per request). */}
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium">{t('modelGroups.strategyLabel')}</label>
                          <p className="text-xs text-muted-foreground">{t('modelGroups.strategyHelp')}</p>
                          <div className="grid gap-2 sm:grid-cols-3">
                            {(['random', 'synthesize', 'best_of'] as const).map(s => (
                              <button
                                key={s}
                                type="button"
                                onClick={() => updateDraft(index, { strategy: s })}
                                aria-pressed={draft.strategy === s}
                                className={`rounded-lg border p-2.5 text-left transition-colors ${
                                  draft.strategy === s ? 'border-foreground bg-muted/50' : 'hover:bg-muted/30'
                                }`}
                              >
                                <span className="flex items-center gap-1.5 text-sm font-medium">
                                  {draft.strategy === s && <Check className="size-3.5" />}
                                  {t(`modelGroups.strategy_${s}`)}
                                </span>
                                <span className="block text-xs text-muted-foreground mt-0.5">{t(`modelGroups.strategy_${s}_help`)}</span>
                              </button>
                            ))}
                          </div>
                          {draft.strategy !== 'random' && (
                            <label className="flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer">
                              <Switch checked={draft.expose_panel} onCheckedChange={v => updateDraft(index, { expose_panel: v })} />
                              <span className="min-w-0">
                                <span className="block text-sm font-medium">{t('modelGroups.exposePanel')}</span>
                                <span className="block text-xs text-muted-foreground">{t('modelGroups.exposePanelHelp')}</span>
                              </span>
                            </label>
                          )}
                        </div>

                        <div className="rounded-xl border bg-muted/30 p-3">
                          <div className="flex items-center gap-2 mb-2">
                            <Layers className="size-4" />
                            <h3 className="text-sm font-medium">{t('modelGroups.usageTitle')}</h3>
                          </div>
                          <p className="text-xs text-muted-foreground mb-2">{t('modelGroups.usageHelp')}</p>
                          <pre className="overflow-x-auto rounded-lg bg-background p-3 text-[11px] leading-relaxed font-mono border">{`POST /v1/chat/completions
{
  "model": "${draft.name.trim() || 'your-group-name'}",
  "messages": [ ... ]
}`}</pre>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <FloatingBar show={hasChanges}>
        <span className="text-xs text-muted-foreground">{t('common.unsavedChanges')}</span>
        <Button size="sm" variant="ghost" onClick={() => { if (data) setDrafts(data.groups.map(toDraft)); setEditing(null) }} disabled={saveMutation.isPending}>
          {t('common.discard')}
        </Button>
        <Button size="sm" onClick={() => saveMutation.mutate({ groups: drafts })} disabled={saveMutation.isPending || !draftsValid}>
          {saveMutation.isPending ? t('common.saving') : t('common.save')}
        </Button>
      </FloatingBar>
    </div>
  )
}
