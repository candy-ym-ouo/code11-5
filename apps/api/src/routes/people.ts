import { Router } from 'express';
import { z } from 'zod';
import { mergePersonSchema, personSchema } from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody, validateQuery, queryOf } from '../middleware/validation';
import * as personService from '../services/personService';

export const peopleRouter = Router({ mergeParams: true });

const listPeopleQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  includeMerged: z.enum(['true', '1']).optional(),
});

const undoMergeSchema = z.object({});

peopleRouter.get(
  '/',
  requireFamily('person:read'),
  validateQuery(listPeopleQuerySchema),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const q = queryOf<z.infer<typeof listPeopleQuerySchema>>(req);
    res.json({
      people: await personService.listPeople(ctx, q.q, { includeMerged: Boolean(q.includeMerged) }),
    });
  }),
);

peopleRouter.post(
  '/',
  requireFamily('person:write'),
  writeLimiter,
  validateBody(personSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.status(201).json({ person: await personService.createPerson(user.id, ctx, req.body, clientMeta(req)) });
  }),
);

peopleRouter.get(
  '/:personId',
  requireFamily('person:read'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json({ person: await personService.getPerson(user.id, ctx, req.params.personId!) });
  }),
);

peopleRouter.patch(
  '/:personId',
  requireFamily('person:write'),
  writeLimiter,
  validateBody(personSchema.partial()),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    res.json({ person: await personService.updatePerson(user.id, ctx, req.params.personId!, req.body, clientMeta(req)) });
  }),
);

peopleRouter.delete(
  '/:personId',
  requireFamily('person:delete'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await personService.deletePerson(user.id, ctx, req.params.personId!, clientMeta(req));
    res.status(204).end();
  }),
);

// 合并前预览：哪些关联会挪过去、哪些条目存在重复（冲突）
peopleRouter.get(
  '/:personId/merge-preview',
  requireFamily('person:delete'),
  validateQuery(z.object({ targetPersonId: z.string().cuid() })),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const { targetPersonId } = queryOf<{ targetPersonId: string }>(req);
    res.json({
      preview: await personService.previewMerge(user.id, ctx, req.params.personId!, targetPersonId),
    });
  }),
);

peopleRouter.post(
  '/:personId/merge',
  requireFamily('person:delete'),
  writeLimiter,
  validateBody(mergePersonSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const person = await personService.mergePerson(
      user.id,
      ctx,
      req.params.personId!,
      req.body.targetPersonId,
      clientMeta(req),
    );
    res.json({ person });
  }),
);

peopleRouter.get(
  '/:personId/merges',
  requireFamily('person:read'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ merges: await personService.listMergeHistory(ctx, req.params.personId!) });
  }),
);

// 撤销某次合并（mergeId 是合并记录 id）
peopleRouter.post(
  '/merges/:mergeId/undo',
  requireFamily('person:delete'),
  writeLimiter,
  validateBody(undoMergeSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const result = await personService.undoMerge(user.id, ctx, req.params.mergeId!, clientMeta(req));
    res.json(result);
  }),
);
