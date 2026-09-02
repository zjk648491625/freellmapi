import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, Layers, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { buildModelOptions } from '@/lib/model-groups'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
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

interface FallbackEntry {
  modelDbId: number
  modelId: string
  displayName: string
  platform: string
  enabled: boolean
  keyCount: number
}

const PROVIDER_ALL = '__all__'

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

  // Member picker options — same logical-model flattening the fusion panel
  // picker uses (one option per unify group when unification is on).
  const availableModels = useMemo(
    () => fallbackEntries.filter(e => e.keyCount > 0 && e.enabled),
    [fallbackEntries],
  )
  const modelOptions = useMemo(() => buildModelOptions(availableModels, true), [availableModels])

  const [drafts, setDrafts] = useState<DraftGroup[]>([])
  // Index of the group currently expanded for editing; null = read-only list.
  const [editing, setEditing] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState<string>(PROVIDER_ALL)

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
  const visibleModels = useMemo(() => {
    const q = query.trim().toLowerCase()
    return modelOptions.filter(o =>
      (provider === PROVIDER_ALL || o.platforms.includes(provider))
      && (!q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)))
  }, [modelOptions, query, provider])

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
                          {modelOptions.length === 0 ? (
                            <p className="text-xs text-muted-foreground">{t('modelGroups.noModels')}</p>
                          ) : (
                            <>
                              <div className="flex items-center gap-2">
                                <div className="relative flex-1">
                                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                                  <Input
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    placeholder={t('modelGroups.searchPlaceholder')}
                                    className="pl-8"
                                  />
                                </div>
                                <Select value={provider} onValueChange={v => setProvider(v ?? PROVIDER_ALL)}>
                                  <SelectTrigger className="w-44 shrink-0" aria-label={t('modelGroups.providerAll')}>
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
                              <div className="max-h-80 overflow-y-auto rounded-xl border divide-y">
                                {visibleModels.length === 0 ? (
                                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('modelGroups.noMatch')}</p>
                                ) : visibleModels.map(o => {
                                  const selected = draft.models.includes(o.value)
                                  return (
                                    <button
                                      key={o.value}
                                      type="button"
                                      onClick={() => toggleMember(index, o.value)}
                                      className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                                        selected ? 'bg-muted/50' : 'hover:bg-muted/30'
                                      }`}
                                    >
                                      <span className={`flex size-4 items-center justify-center rounded border ${selected ? 'bg-foreground text-background' : ''}`}>
                                        {selected && <Check className="size-3" />}
                                      </span>
                                      <span className="min-w-0 flex-1">
                                        <span className="text-sm font-medium">{o.label}</span>
                                        <span className="ml-2 font-mono text-[11px] text-muted-foreground">{o.value}</span>
                                      </span>
                                      <Badge variant="secondary" className="text-[10px]">
                                        {o.providerCount > 1 ? t('models.providerCount', { count: o.providerCount }) : o.platform}
                                      </Badge>
                                    </button>
                                  )
                                })}
                              </div>
                            </>
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
