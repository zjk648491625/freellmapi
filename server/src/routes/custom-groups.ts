/**
 * Admin API for custom model groups (自定义模型组) — the dashboard surface for
 * the feature implemented in services/custom-groups.ts. Mounted at
 * /api/custom-model-groups (requireAuth, like every /api dashboard route).
 *
 * Deliberately a SEPARATE router file: it touches nothing in routes/settings.ts
 * or routes/models.ts, so upstream merges cannot conflict with it.
 *
 * Shape follows the settings router's conventions:
 *  - GET  /              → the full config, each group enriched with its runtime
 *                          resolution preview (resolved rows, availability);
 *  - PUT  /              → full replace (the same contract as the unify overrides
 *                          PUT — the client edits the whole list and saves it);
 *  - POST /validate-name → validate one group name without saving (live feedback
 *                          while the operator types);
 *  - DELETE /:name       → convenience single-group removal.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import {
  getCustomGroups,
  setCustomGroups,
  previewCustomGroup,
  validateCustomGroupName,
  findCustomGroup,
} from '../services/custom-groups.js';

export const customGroupsRouter = Router();

function listPayload() {
  return {
    groups: getCustomGroups().map(g => {
      const preview = previewCustomGroup(g);
      return {
        ...g,
        members: preview.members,
        resolvedRows: preview.resolvedRows,
        routable: preview.routable,
        available: preview.available,
      };
    }),
  };
}

customGroupsRouter.get('/', (_req: Request, res: Response) => {
  res.json(listPayload());
});

customGroupsRouter.put('/', (req: Request, res: Response) => {
  try {
    setCustomGroups(req.body);
    res.json(listPayload());
  } catch (err: any) {
    // Zod schema violations and name-validation Errors both render as a 400
    // with a specific message (mirrors the settings router's error shape).
    const detail = err instanceof ZodError
      ? err.errors.map(e => (e.path.length ? e.path.join('.') + ': ' + e.message : e.message)).slice(0, 5).join(', ')
      : err?.message ?? 'invalid config';
    res.status(400).json({ error: { message: 'Invalid custom model groups config: ' + detail, type: 'invalid_request_error' } });
  }
});

// Validate a single group name WITHOUT saving — the dashboard calls this while
// the operator types, before a full-list PUT.
customGroupsRouter.post('/validate-name', (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const exclude = typeof req.body?.excludeName === 'string' ? req.body.excludeName.trim().toLowerCase() : null;
  // Same case-insensitive comparison the save path uses, so live validation
  // agrees with what the PUT will accept.
  const others = getCustomGroups().filter(g => g.name.trim().toLowerCase() !== exclude);
  const problem = validateCustomGroupName(name, others);
  res.json({ ok: problem == null, problem });
});

customGroupsRouter.delete('/:name', (req: Request, res: Response) => {
  // Express 5 types params as string | string[]; names never contain '/', so
  // the array form (repeated params) simply collapses.
  const raw = req.params.name;
  const name = (Array.isArray(raw) ? raw.join('/') : raw) ?? '';
  const existing = findCustomGroup(name);
  if (!existing) {
    res.status(404).json({ error: { message: "No custom model group named '" + name + "'", type: 'invalid_request_error' } });
    return;
  }
  // Compare by name, not object identity: each getCustomGroups() call re-parses
  // the stored JSON into fresh objects.
  const lower = existing.name.trim().toLowerCase();
  setCustomGroups({ groups: getCustomGroups().filter(g => g.name.trim().toLowerCase() !== lower) });
  res.json(listPayload());
});
