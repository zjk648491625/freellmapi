/**
 * Custom model group FAN-OUT strategies ('synthesize' / 'best_of').
 *
 * 自定义模型组的融合策略 — COPIED from services/fusion.ts (the virtual
 * "fusion" model's engine) per the standalone-logic-route rule: this feature
 * must keep working (and keep merging cheap) no matter how upstream's fusion
 * evolves, so the engine logic is deliberately DUPLICATED here rather than
 * shared. The only pieces imported from shared infrastructure are the same
 * routing/ratelimit primitives every other path uses (routePinnedModel,
 * routeRequest, cooldown/accounting helpers) — the same relationship the
 * random-group path has with routeRequest().
 *
 * Adaptations vs the fusion original (everything else is a faithful copy):
 *  - The panel is the group's member list, resolved with the SAME id space
 *    fusion pickers use (bare model_id, unify canonical slug) — capped at the
 *    same hard ceiling of 8 slots, extras reported as "dropped".
 *  - No overflow/refill wave: the operator named exact members, so a failed
 *    slot is NOT substituted with a different model (explicit-panel semantics).
 *  - The response's "model" field is the GROUP NAME (the id the caller sent),
 *    and response ids are prefixed "cg-" instead of "fusion-".
 *  - The request-log tag is 'custom-group' so group fan-out traffic is
 *    attributable in analytics separately from fusion traffic.
 *  - No per-group judge yet (v1): the judge rides the normal auto chain via
 *    routeRequest(), exactly like fusion with no judge configured.
 *
 * The "x_fusion" exposure (per-model answers + judge metadata) is the same
 * field name and shape the virtual "fusion" model emits when its
 * expose_panel flag is on, so clients learn one convention.
 */
import type { ChatMessage, ChatCompletionChoice, ChatCompletionResponse, ChatToolCall, TokenUsage } from '@freellmapi/shared/types.js';
import {
  routePinnedModel, routeRequest, resolveFusionCandidate,
  recordRateLimitHit, recordSuccess, type RouteResult, type FusionCandidate,
} from './router.js';
import {
  recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit,
  getCooldownDecisionForLimit,
  PAYMENT_REQUIRED_COOLDOWN_MS, MODEL_FORBIDDEN_COOLDOWN_MS,
} from './ratelimit.js';
import { logRequest } from '../lib/request-log.js';
import {
  isRetryableError, isRateLimitSignal, isPaymentRequiredError,
  isModelNotFoundError, isModelAccessForbiddenError,
} from '../lib/error-classify.js';
import { contentToString, stripImagesFromMessages } from '../lib/content.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import type { CompletionOptions } from '../providers/base.js';
import type { CustomGroup } from './custom-groups.js';
import type { Response } from 'express';
import crypto from 'node:crypto';

// Request-log tag: fan-out sub-calls are attributable separately from fusion.
const GROUP_TAG = 'custom-group';

// Copied fusion constants (services/fusion.ts). Per-slot key-rotation budget
// is small on purpose — a model with every key cooled down should fail fast,
// not stall the panel. The judge walks the normal auto chain and gets more
// room to fail over.
const MAX_SLOT_ATTEMPTS = 4;
const MAX_JUDGE_ATTEMPTS = 6;
// A panel of fewer than this many *successful* answers isn't worth a judge
// pass — with one survivor we just return it directly.
const SYNTHESIS_QUORUM = 2;
// Ceiling even an explicit group panel can't exceed (copied fusion cap). A
// group may declare more members; extras are reported in x_fusion.dropped.
const GROUP_PANEL_HARD_CAP = 8;

export class GroupStrategyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ── Copied from fusion.ts (verbatim except the tag constant) ─────────────────

// One panel member's outcome.
interface PanelAnswer {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  status: 'ok' | 'failed';
  content?: string;
  toolCalls?: ChatToolCall[];
  rawChoice?: ChatCompletionChoice;
  error?: string;
  usage?: TokenUsage;
}

interface CallOutcome {
  ok: boolean;
  route?: RouteResult;
  text?: string;
  toolCalls?: ChatToolCall[];
  rawChoice?: ChatCompletionChoice;
  usage?: TokenUsage;
  error?: string;
}

const ZERO_USAGE: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + (b.prompt_tokens ?? 0),
    completion_tokens: a.completion_tokens + (b.completion_tokens ?? 0),
    total_tokens: a.total_tokens + (b.total_tokens ?? 0),
  };
}

/**
 * Run one model call with retry across keys/models, doing the same accounting
 * (request counts, token usage, success/penalty, cooldowns, request log) the
 * normal proxy path does — just tagged as custom-group traffic. getRoute
 * decides WHICH model is tried: a pinned-model closure for a panel slot (never
 * substitutes), or the auto-router for the judge (falls over across the chain).
 */
async function runModelCall(
  getRoute: (skipKeys: Set<string>, skipModels: Set<number>) => RouteResult | null,
  messages: ChatMessage[],
  options: CompletionOptions,
  estimatedTokens: number,
  maxAttempts: number,
): Promise<CallOutcome> {
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let route: RouteResult | null;
    try {
      route = getRoute(skipKeys, skipModels);
    } catch (err: any) {
      // routeRequest throws when the whole chain is exhausted (judge path).
      lastError = sanitizeProviderErrorMessage(err?.message);
      break;
    }
    if (!route) break;

    const startedAt = Date.now();
    try {
      const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, options);
      const choice = result.choices?.[0];
      const text = contentToString(choice?.message?.content ?? '');
      const toolCalls = choice?.message?.tool_calls;
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

      if (!text && !hasToolCalls) {
        // Empty completion — fail over like the main proxy path does.
        logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, 'empty completion (custom group)', null, GROUP_TAG);
        skipKeys.add(route.platform + ':' + route.modelId + ':' + route.keyId);
        setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
        recordRateLimitHit(route.modelDbId);
        lastError = 'empty completion from ' + route.displayName;
        continue;
      }

      const usage = result.usage ?? ZERO_USAGE;
      recordRequest(route.platform, route.modelId, route.keyId);
      recordTokens(route.platform, route.modelId, route.keyId, usage.total_tokens);
      recordSuccess(route.modelDbId);
      logRequest(route.platform, route.modelId, route.keyId, 'success', usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, Date.now() - startedAt, null, null, GROUP_TAG);
      return {
        ok: true,
        route,
        text,
        toolCalls: hasToolCalls ? toolCalls : undefined,
        rawChoice: hasToolCalls ? choice : undefined,
        usage,
      };
    } catch (err: any) {
      const safe = sanitizeProviderErrorMessage(err?.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, safe, null, GROUP_TAG);
      lastError = safe;

      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);
        skipKeys.add(route.platform + ':' + route.modelId + ':' + route.keyId);
        // Provenance mirrors cooldownDecisionForError (lib/fallback-loop.ts):
        // credit/tier benches are never probe-recovered, Retry-After-backed
        // ones only when our heuristic outlasted the provider's own retry time.
        const decision = isPaymentRequiredError(err)
          ? { durationMs: PAYMENT_REQUIRED_COOLDOWN_MS, source: 'credit' as const }
          : isModelAccessForbiddenError(err)
          ? { durationMs: MODEL_FORBIDDEN_COOLDOWN_MS, source: 'tier' as const }
          : getCooldownDecisionForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }, err.retryAfterMs, { quotaSignal: isRateLimitSignal(err) });
        setCooldown(route.platform, route.modelId, route.keyId, decision.durationMs, decision.source);
        recordRateLimitHit(route.modelDbId);
        continue;
      }
      // Non-retryable (auth, validation) — this slot/judge is done.
      break;
    } finally {
      // Panel slots run concurrently, so a leaked lease here would starve the
      // rest of the panel of its own keys' concurrency budget. The route object
      // stays usable as a data carrier after release.
      route.release?.();
    }
  }

  return { ok: false, error: lastError ?? 'no available key for model' };
}

/**
 * Like runModelCall, but STREAMS the judge's answer so the client sees it
 * written live instead of waiting for the whole synthesis. Failover only works
 * before the first byte ("started"): once we've forwarded text to the client we
 * can't cleanly switch models, so a mid-stream error returns the partial answer.
 * Usage is estimated (streaming rarely echoes a usage block).
 */
async function runJudgeStreaming(
  getRoute: (skipKeys: Set<string>, skipModels: Set<number>) => RouteResult | null,
  messages: ChatMessage[],
  options: CompletionOptions,
  estimatedTokens: number,
  maxAttempts: number,
  cb: { onStart?: (r: { platform: string; model: string }) => void; onDelta?: (t: string) => void },
): Promise<CallOutcome> {
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let route: RouteResult | null;
    try { route = getRoute(skipKeys, skipModels); } catch (err: any) { lastError = sanitizeProviderErrorMessage(err?.message); break; }
    if (!route) break;

    const startedAt = Date.now();
    let text = '';
    let started = false;
    try {
      for await (const chunk of route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, options)) {
        const delta = (chunk as any)?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          if (!started) { started = true; cb.onStart?.({ platform: route.platform, model: route.modelId }); }
          text += delta;
          cb.onDelta?.(delta);
        }
      }
      if (!text) {
        logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, 'empty completion (custom group judge)', null, GROUP_TAG);
        skipKeys.add(route.platform + ':' + route.modelId + ':' + route.keyId);
        setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
        recordRateLimitHit(route.modelDbId);
        lastError = 'empty judge completion from ' + route.displayName;
        continue;
      }
      const out = Math.ceil(text.length / 4);
      const usage: TokenUsage = { prompt_tokens: estimatedTokens, completion_tokens: out, total_tokens: estimatedTokens + out };
      recordRequest(route.platform, route.modelId, route.keyId);
      recordTokens(route.platform, route.modelId, route.keyId, usage.total_tokens);
      recordSuccess(route.modelDbId);
      logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedTokens, out, Date.now() - startedAt, null, null, GROUP_TAG);
      return { ok: true, route, text, usage };
    } catch (err: any) {
      const safe = sanitizeProviderErrorMessage(err?.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, safe, null, GROUP_TAG);
      lastError = safe;
      // Already streamed bytes — can't fail over without duplicating output.
      // Keep whatever the client already received.
      if (started) {
        if (text) {
          const out = Math.ceil(text.length / 4);
          return { ok: true, route, text, usage: { prompt_tokens: estimatedTokens, completion_tokens: out, total_tokens: estimatedTokens + out } };
        }
        break;
      }
      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);
        skipKeys.add(route.platform + ':' + route.modelId + ':' + route.keyId);
        // Same provenance mapping as the non-stream path above.
        const decision = isPaymentRequiredError(err)
          ? { durationMs: PAYMENT_REQUIRED_COOLDOWN_MS, source: 'credit' as const }
          : isModelAccessForbiddenError(err)
          ? { durationMs: MODEL_FORBIDDEN_COOLDOWN_MS, source: 'tier' as const }
          : getCooldownDecisionForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }, err.retryAfterMs, { quotaSignal: isRateLimitSignal(err) });
        setCooldown(route.platform, route.modelId, route.keyId, decision.durationMs, decision.source);
        recordRateLimitHit(route.modelDbId);
        continue;
      }
      break;
    } finally {
      route.release?.();
    }
  }
  return { ok: false, error: lastError ?? 'no available key for judge' };
}

// Synthesis judge instructions. Anonymized "Response N" so the judge weighs
// content, not model reputation; told to produce the final answer directly with
// no meta-commentary about merging. (Copied verbatim from fusion.ts.)
const JUDGE_SYSTEM_PROMPT =
  'You are the final author of a single answer. Several AI assistants each independently answered the user\'s most recent message; their answers are provided below, anonymized as "Response 1", "Response 2", etc. ' +
  'IMPORTANT: the user will NEVER see any of those individual responses — they only ever see what you write — so your answer must be COMPLETE and fully STAND-ALONE on its own. ' +
  'Take the best parts of every response, combine the correct and most useful ideas into one coherent whole, resolve any contradictions by reasoning about which is actually right (do not just average or list options), and fill in anything they all missed. ' +
  'Then REWRITE it all from scratch, in your own words, as one clear, well-structured, self-contained answer that makes complete sense by itself. ' +
  'Do not mention that other answers exist, do not refer to "Response 1/2/3", do not compare the responses, and do not describe your process — just deliver the final, authoritative answer directly to the user.';

function buildJudgeMessages(original: ChatMessage[], answers: PanelAnswer[], stripImages = false): ChatMessage[] {
  const ok = answers.filter(a => a.status === 'ok' && a.content);
  const panelBlock = ok
    .map((a, i) => '--- Response ' + (i + 1) + ' ---\n' + a.content)
    .join('\n\n');

  // Keep the full original conversation for context, then append the candidate
  // answers + synthesis instruction as a final user turn. The judge system
  // prompt leads so it frames everything that follows.
  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    ...(stripImages ? stripImagesFromMessages(original) : original),
    {
      role: 'user',
      content:
        'Here are ' + ok.length + ' independent answers to my most recent message:\n\n' + panelBlock + '\n\n' +
        'Take the best parts of these, then rewrite one complete, self-contained answer to my most recent message in your own words. ' +
        'I will only see your answer — not these — so do not reference them.',
    },
  ];
}

// ── Group-adapted orchestration (adapted from runFusion) ─────────────────────

export interface GroupFanoutResult {
  response: ChatCompletionResponse & { x_fusion?: unknown; _fusion?: unknown };
  routedVia: string; // for the X-Routed-Via header
}

export interface GroupFanoutHooks {
  onPanel?: (a: { platform: string; model: string; status: 'ok' | 'failed'; content?: string; tool_calls?: ChatToolCall[]; error?: string }) => void;
  onJudge?: (j: { platform: string; model: string }) => void;
  onJudgeDelta?: (text: string) => void;
}

/**
 * Orchestrate a group fan-out request end to end: resolve the member panel,
 * fan out in parallel, then synthesize survivors with a judge ('synthesize')
 * or return the strongest single answer ('best_of'). Throws GroupStrategyError
 * when nothing usable comes back so the route can map it to an HTTP status.
 */
export async function runGroupFanout(params: {
  group: CustomGroup;
  requestedModel: string;
  messages: ChatMessage[];
  options: CompletionOptions;
  estimatedTokens: number;
  vision?: boolean;
  hooks?: GroupFanoutHooks;
}): Promise<GroupFanoutResult> {
  const { group, requestedModel, messages, options, estimatedTokens, vision = false } = params;
  const hooks = params.hooks;
  const strategy = group.strategy === 'best_of' ? 'best_of' : 'synthesize';

  // Panel = the group's members, resolved with the same id space fusion
  // pickers use (exact model_id first, unify canonical fallback — router infra,
  // NOT a fusion coupling). Capability drops and duplicates are reported, not
  // fatal; the hard cap of 8 mirrors fusion's explicit-panel ceiling.
  const requireTools = (options.tools?.length ?? 0) > 0;
  const panel: FusionCandidate[] = [];
  const dropped: string[] = [];
  const seen = new Set<number>();
  for (const ref of group.models) {
    if (panel.length >= GROUP_PANEL_HARD_CAP) { dropped.push(ref + ' (over cap of ' + GROUP_PANEL_HARD_CAP + ')'); continue; }
    const cand = resolveFusionCandidate(ref);
    if (!cand) { dropped.push(ref + ' (unknown or disabled)'); continue; }
    if (requireTools && !cand.supportsTools) { dropped.push(ref + ' (no tool-calling support)'); continue; }
    if (vision && !cand.supportsVision) { dropped.push(ref + ' (no vision support)'); continue; }
    if (seen.has(cand.modelDbId)) continue; // de-dup repeats
    seen.add(cand.modelDbId);
    panel.push(cand);
  }
  if (panel.length === 0) {
    throw new GroupStrategyError(
      "model group '" + requestedModel + "': no usable member models for the panel. Fix the group's member list in the dashboard, or use 'auto' (or omit the 'model' field) to auto-route.",
      400,
    );
  }

  // Dispatch ONE panel slot: hard-pinned to its model, rotating only that
  // model's keys (so a key 429 doesn't collapse the slot onto a duplicate
  // backend — fusion issue #326 semantics). No overflow: the operator named
  // exact members, so a failed slot is never substituted.
  const runSlot = (cand: FusionCandidate): Promise<PanelAnswer> =>
    runModelCall(
      (skipKeys) => routePinnedModel(cand.modelDbId, estimatedTokens, skipKeys),
      messages, options, estimatedTokens, MAX_SLOT_ATTEMPTS,
    ).then((outcome): PanelAnswer => {
      const answer: PanelAnswer = outcome.ok
        ? {
            modelDbId: cand.modelDbId,
            platform: cand.platform,
            modelId: cand.modelId,
            displayName: cand.displayName,
            status: 'ok',
            content: outcome.text,
            toolCalls: outcome.toolCalls,
            rawChoice: outcome.rawChoice,
            usage: outcome.usage,
          }
        : { modelDbId: cand.modelDbId, platform: cand.platform, modelId: cand.modelId, displayName: cand.displayName, status: 'failed', error: outcome.error };
      hooks?.onPanel?.({ platform: answer.platform, model: answer.modelId, status: answer.status, content: answer.content, tool_calls: answer.toolCalls, error: answer.error });
      return answer;
    });

  const settled = await Promise.allSettled(panel.map(runSlot));
  const answers: PanelAnswer[] = settled.map((s, i) => s.status === 'fulfilled'
    ? s.value
    : { modelDbId: panel[i].modelDbId, platform: panel[i].platform, modelId: panel[i].modelId, displayName: panel[i].displayName, status: 'failed', error: sanitizeProviderErrorMessage((s as PromiseRejectedResult).reason?.message) });

  const survivors = answers.filter(a => a.status === 'ok' && (a.content || (a.toolCalls?.length ?? 0) > 0));
  let totalUsage: TokenUsage = { ...ZERO_USAGE };
  for (const a of survivors) totalUsage = addUsage(totalUsage, a.usage);

  if (survivors.length === 0) {
    throw new GroupStrategyError(
      "model group '" + requestedModel + "': every member failed or was rate-limited. Try again shortly or fix the group's member list in the dashboard.",
      429,
    );
  }

  // Tool calls are actions, not prose. They cannot be safely synthesized across
  // models, so the first panel survivor that returned structured tool_calls
  // wins and the judge is skipped. (Copied fusion semantics.)
  const toolCallWinner = survivors.find(a => (a.toolCalls?.length ?? 0) > 0 && a.rawChoice);
  if (toolCallWinner) {
    const choice: ChatCompletionChoice = {
      index: 0,
      message: toolCallWinner.rawChoice!.message,
      finish_reason: 'tool_calls',
    };
    const response: ChatCompletionResponse & { x_fusion?: unknown; _fusion?: unknown } = {
      id: 'cg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [choice],
      usage: totalUsage,
    };
    const winner = { platform: toolCallWinner.platform, model: toolCallWinner.modelId };
    // Always-on lightweight routing summary (copied fusion convention).
    response._fusion = {
      panel: survivors.map(a => ({ platform: a.platform, model: a.modelId })),
      judge: null,
      synthesized: false,
      tool_call_winner: winner,
    };
    if (group.expose_panel) {
      response.x_fusion = {
        strategy,
        synthesized: false,
        judge: null,
        group: group.name,
        panel_requested: panel.map(p => p.modelId),
        dropped,
        tool_call_winner: winner,
        panel: answers.map(a => ({
          model: a.modelId,
          platform: a.platform,
          status: a.status,
          ...(a.status === 'ok'
            ? { content: a.content, tool_calls: a.toolCalls }
            : { error: a.error }),
        })),
      };
    }

    return {
      response,
      routedVia: 'custom-group:' + group.name + '(' + survivors.map(a => a.modelId).join('+') + ' -> tool_call:' + toolCallWinner.modelId + ')',
    };
  }

  const textSurvivors = survivors.filter(a => a.content);

  // Decide the final answer.
  let finalText: string;
  let judgeModelLabel: string | null = null;
  let judgeRoute: { platform: string; model: string } | null = null;
  let synthesized = false;

  if (textSurvivors.length < SYNTHESIS_QUORUM || strategy === 'best_of') {
    // One survivor, or best-of requested: return the strongest single answer
    // (longest as a cheap proxy for completeness) — no judge call.
    finalText = textSurvivors.slice().sort((a, b) => (b.content!.length - a.content!.length))[0].content!;
  } else {
    const judgeMessages = buildJudgeMessages(messages, textSurvivors, vision);
    // The judge prompt carries every panel answer, so its input is much larger
    // than the original — size the routing estimate accordingly.
    const judgeEstimate = estimatedTokens + textSurvivors.reduce((n, a) => n + Math.ceil((a.content?.length ?? 0) / 4), 0);
    const judgeOptions: CompletionOptions = requireTools
      ? { ...options, tools: undefined, tool_choice: undefined, parallel_tool_calls: undefined }
      : options;

    // v1: no per-group judge — the judge rides the normal auto chain, exactly
    // like fusion with no judge configured.
    const getJudgeRoute = (skipKeys: Set<string>, skipModels: Set<number>) => routeRequest(
      judgeEstimate, skipKeys.size ? skipKeys : undefined, undefined, false, false,
      skipModels.size ? skipModels : undefined, undefined,
      // The judge writes the final answer the client receives, so a
      // structured-output request must not land it on a platform whose
      // policy drops response_format (kilo) — the schema would never even
      // reach the model. Mirrors the non-fusion routing (#516).
      options.response_format !== undefined,
    );

    // Stream the judge when the caller wants live tokens; otherwise a single
    // buffered call.
    const judge = hooks?.onJudgeDelta
      ? await runJudgeStreaming(getJudgeRoute, judgeMessages, judgeOptions, judgeEstimate, MAX_JUDGE_ATTEMPTS, {
          // Surface the judge model the moment it starts emitting, so the trace
          // shows it while the answer is still streaming.
          onStart: (r) => { judgeRoute = r; judgeModelLabel = r.platform + '/' + r.model; hooks.onJudge?.(r); },
          onDelta: hooks.onJudgeDelta,
        })
      : await runModelCall(getJudgeRoute, judgeMessages, judgeOptions, judgeEstimate, MAX_JUDGE_ATTEMPTS);

    if (judge.ok && judge.text) {
      finalText = judge.text;
      synthesized = true;
      // For the streaming path judgeRoute was set in onStart; set it here for the
      // buffered path (and as a fallback).
      if (!judgeRoute && judge.route) judgeRoute = { platform: judge.route.platform, model: judge.route.modelId };
      judgeModelLabel = judgeRoute ? judgeRoute.platform + '/' + judgeRoute.model : null;
      if (!hooks?.onJudgeDelta && judgeRoute) hooks?.onJudge?.(judgeRoute);
      totalUsage = addUsage(totalUsage, judge.usage);
    } else {
      // Judge failed → best-of fallback rather than erroring the whole request.
      finalText = textSurvivors.slice().sort((a, b) => (b.content!.length - a.content!.length))[0].content!;
    }
  }

  const routedModels = textSurvivors.map(a => a.modelId);
  const routedVia = 'custom-group:' + group.name + '(' + routedModels.join('+') + (synthesized && judgeModelLabel ? ' -> ' + judgeModelLabel : '') + ')';

  const response: ChatCompletionResponse & { x_fusion?: unknown; _fusion?: unknown } = {
    id: 'cg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message: { role: 'assistant', content: finalText }, finish_reason: 'stop' }],
    usage: totalUsage,
  };

  // Always-on lightweight routing summary so a client (e.g. the Playground
  // footer) can show exactly which member models replied and which judge
  // synthesized — without the heavier per-answer x_fusion payload.
  response._fusion = {
    panel: survivors.map(a => ({ platform: a.platform, model: a.modelId })),
    judge: synthesized ? judgeRoute : null,
    synthesized,
  };

  if (group.expose_panel) {
    response.x_fusion = {
      strategy,
      synthesized,
      judge: judgeModelLabel,
      group: group.name,
      panel_requested: panel.map(p => p.modelId),
      dropped,
      panel: answers.map(a => ({
        model: a.modelId,
        platform: a.platform,
        status: a.status,
        ...(a.status === 'ok' ? { content: a.content } : { error: a.error }),
      })),
    };
  }

  return { response, routedVia };
}

/**
 * Streaming variant: owns the whole SSE response (headers, additive "_fusion"
 * trace frames, the final answer as normal content deltas, [DONE]). Copied
 * from the fusion branch's streaming writer (routes/proxy.ts) so the proxy
 * branch for group strategies stays a two-liner. Standard OpenAI clients skip
 * "_fusion" frames (they carry no "choices"); the Playground renders them.
 */
export async function streamGroupFanout(
  res: Response,
  params: {
    group: CustomGroup;
    requestedModel: string;
    messages: ChatMessage[];
    options: CompletionOptions;
    estimatedTokens: number;
    vision?: boolean;
  },
): Promise<void> {
  const { group, requestedModel } = params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const writeFrame = (o: unknown) => { try { res.write('data: ' + JSON.stringify(o) + '\n\n'); } catch { /* socket gone */ } };
  const streamId = 'cg-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const base = { id: streamId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: requestedModel };
  // Track whether the judge already streamed content so we don't re-emit it.
  let answerStarted = false;
  try {
    const { response } = await runGroupFanout({
      ...params,
      hooks: {
        // "a" already carries a sanitized error for failed slots; content is
        // the model's own answer and is forwarded as-is.
        onPanel: (a) => writeFrame({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          _fusion: { event: 'panel', ...a },
        }),
        onJudge: (j) => writeFrame({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          _fusion: { event: 'judge', ...j },
        }),
        // Stream the judge's synthesis live as standard content deltas, so the
        // final answer appears as it's written instead of after the wait.
        onJudgeDelta: (delta) => {
          if (!answerStarted) { writeFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }); answerStarted = true; }
          writeFrame({ ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
        },
      },
    });
    // best_of / single-survivor / judge-fell-back-to-best-of never streamed
    // a delta — emit the final answer as one chunk in that case.
    const finalMsg = response.choices[0]?.message;
    const finalToolCalls = (finalMsg as { tool_calls?: ChatToolCall[] } | undefined)?.tool_calls;
    const hasFinalToolCalls = Array.isArray(finalToolCalls) && finalToolCalls.length > 0;
    if (hasFinalToolCalls) {
      writeFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      writeFrame({ ...base, choices: [{ index: 0, delta: { tool_calls: finalToolCalls }, finish_reason: null }] });
      writeFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: response.usage });
    } else {
      if (!answerStarted) {
        const finalText = contentToString(finalMsg?.content ?? '');
        writeFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        writeFrame({ ...base, choices: [{ index: 0, delta: { content: finalText }, finish_reason: null }] });
      }
      writeFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: response.usage });
    }
  } catch (err: any) {
    const message = err instanceof GroupStrategyError ? err.message : 'model group error: ' + sanitizeProviderErrorMessage(err?.message);
    const type = err instanceof GroupStrategyError && err.status === 429 ? 'rate_limit_error' : 'server_error';
    writeFrame({ error: { message, type } });
  }
  try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
}
