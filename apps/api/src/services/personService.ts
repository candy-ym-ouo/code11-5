import type { Person, PersonRole, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { badRequest, conflict, notFound } from '../http/errors';
import * as audit from './auditService';
import { toItemDto, toPersonDto } from '../serializers';
import type { FamilyContext } from './permissionService';
import { itemVisibilityWhere } from './visibility';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface PersonInput {
  name: string;
  aliases?: string[] | null;
  relation?: string | null;
  relationNote?: string | null;
  birthYear?: number | null;
  deathYear?: number | null;
  bio?: string | null;
  avatarMediaId?: string | null;
}

/** 别名去空白、去重、限长；与正名重复的不收。 */
function normalizeAliases(name: string, aliases?: string[] | null): string[] {
  if (!aliases) return [];
  const seen = new Set<string>([name.trim()]);
  const out: string[] = [];
  for (const raw of aliases) {
    const a = raw.trim();
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push(a.slice(0, 40));
  }
  return out.slice(0, 10);
}

export async function listPeople(ctx: FamilyContext, q?: string) {
  const where: Prisma.PersonWhereInput = { familyId: ctx.familyId, deletedAt: null, mergedIntoId: null };
  if (q) {
    const kw = { contains: q, mode: 'insensitive' as const };
    where.OR = [{ name: kw }, { aliases: { has: q } }, { relation: kw }];
  }
  const rows = await prisma.person.findMany({
    where,
    include: { _count: { select: { links: true } } },
    orderBy: [{ name: 'asc' }],
    take: 500,
  });
  return rows.map(toPersonDto);
}

/** 合并记录的对外结构：双向都能用它说明「谁并进了谁、能否撤销」。 */
function toMergeDto(
  m: {
    id: string;
    sourceId: string;
    targetId: string;
    snapshot: Prisma.JsonValue;
    undoneAt: Date | null;
    createdAt: Date;
  },
  source: Pick<Person, 'id' | 'name'>,
  target: Pick<Person, 'id' | 'name'>,
) {
  const snapshot = (m.snapshot ?? {}) as { links?: unknown[] };
  return {
    id: m.id,
    sourceId: m.sourceId,
    sourceName: source.name,
    targetId: m.targetId,
    targetName: target.name,
    itemCount: Array.isArray(snapshot.links) ? snapshot.links.length : 0,
    undone: Boolean(m.undoneAt),
    undoneAt: m.undoneAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function getPerson(userId: string, ctx: FamilyContext, personId: string) {
  // 不能过滤 deletedAt —— 合并后的源人物带着 deletedAt+mergedIntoId，
  // 它的详情页正是「历史关联追溯还原」的入口；真正的删除是 deletedAt 有值但 mergedIntoId 为空
  const person = await prisma.person.findFirst({
    where: {
      id: personId,
      familyId: ctx.familyId,
      OR: [{ deletedAt: null }, { mergedIntoId: { not: null } }],
    },
    include: {
      _count: { select: { links: true } },
      mergedInto: { select: { id: true, name: true } },
    },
  });
  if (!person) throw notFound('人物不存在');

  // 人物详情里的条目同样要过可见性，不能因为「在人物页」就漏出私密条目
  const links = await prisma.itemPerson.findMany({
    where: {
      personId,
      item: { AND: [{ familyId: ctx.familyId }, { deletedAt: null }, itemVisibilityWhere(userId, ctx.role)] },
    },
    include: {
      item: {
        include: {
          media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
          people: { include: { person: true } },
          _count: { select: { notes: true, media: true } },
        },
      },
    },
    take: 200,
  });

  // 合并档案（作为被合并方或并入方都查），含已撤销的，保证来龙去脉完整
  const mergeRows = await prisma.personMerge.findMany({
    where: { familyId: ctx.familyId, OR: [{ sourceId: personId }, { targetId: personId }] },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const otherIds = [
    ...new Set(
      mergeRows.flatMap((m) => [m.sourceId, m.targetId]).filter((id) => id !== personId),
    ),
  ];
  const otherRows = await prisma.person.findMany({
    where: { id: { in: otherIds } },
    select: { id: true, name: true },
  });
  const otherNames = new Map(otherRows.map((p) => [p.id, p.name]));
  const nameOf = (id: string): { id: string; name: string } =>
    id === personId
      ? { id, name: person.name }
      : { id, name: otherNames.get(id) ?? '已删除的人物' };

  const mergeHistory = mergeRows.map((m) => toMergeDto(m, nameOf(m.sourceId), nameOf(m.targetId)));

  // 合并后的源人物：活关联已被转走，改从最近一次生效中的合并快照还原「历史关联」列表，
  // 让用户在撤销前能核对受影响条目；已撤销的合并不看快照（此时活关联已挂回本人名下）
  let historyItems: { role: PersonRole }[] | null = null;
  if (person.mergedIntoId) {
    const activeOut = mergeRows.find((m) => m.sourceId === personId && !m.undoneAt);
    if (activeOut) {
      const snap = activeOut.snapshot as { links?: { itemId: string; role: PersonRole }[] };
      const ids = (snap.links ?? []).map((l) => l.itemId);
      const rows = await prisma.item.findMany({
        where: {
          id: { in: ids },
          AND: [{ familyId: ctx.familyId }, { deletedAt: null }, itemVisibilityWhere(userId, ctx.role)],
        },
        include: {
          media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
          people: { include: { person: true } },
          _count: { select: { notes: true, media: true } },
        },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      historyItems = (snap.links ?? []).flatMap((l) => {
        const row = byId.get(l.itemId);
        return row ? [{ role: l.role, ...toItemDto(row, ctx.familyId) }] : [];
      });
    }
  }

  return {
    ...toPersonDto(person),
    items: (historyItems ?? links.map((l) => ({ role: l.role, ...toItemDto(l.item, ctx.familyId) }))),
    mergeHistory,
  };
}

export async function createPerson(actorId: string, ctx: FamilyContext, input: PersonInput, meta: ActorMeta) {
  const person = await prisma.$transaction(async (tx) => {
    const created = await tx.person.create({
      data: {
        familyId: ctx.familyId,
        name: input.name,
        aliases: normalizeAliases(input.name, input.aliases),
        relation: input.relation ?? null,
        relationNote: input.relationNote ?? null,
        birthYear: input.birthYear ?? null,
        deathYear: input.deathYear ?? null,
        bio: input.bio ?? null,
        avatarMediaId: input.avatarMediaId ?? null,
        createdBy: actorId,
      },
      include: { _count: { select: { links: true } } },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'person.create',
        targetType: 'person',
        targetId: created.id,
        diff: { name: created.name, aliases: created.aliases } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return created;
  });
  return toPersonDto(person);
}

export async function updatePerson(
  actorId: string,
  ctx: FamilyContext,
  personId: string,
  input: Partial<PersonInput>,
  meta: ActorMeta,
) {
  const before = await prisma.person.findFirst({ where: { id: personId, familyId: ctx.familyId, deletedAt: null } });
  if (!before) throw notFound('人物不存在');
  if (before.mergedIntoId) throw conflict('该人物已被合并，不能直接编辑；如需修改请先撤销合并或编辑合并后的人物');

  const person = await prisma.$transaction(async (tx) => {
    const nextName = input.name ?? before.name;
    const updated = await tx.person.update({
      where: { id: personId },
      data: {
        name: input.name ?? undefined,
        aliases: input.aliases === undefined ? undefined : normalizeAliases(nextName, input.aliases),
        relation: input.relation === undefined ? undefined : input.relation,
        relationNote: input.relationNote === undefined ? undefined : input.relationNote,
        birthYear: input.birthYear === undefined ? undefined : input.birthYear,
        deathYear: input.deathYear === undefined ? undefined : input.deathYear,
        bio: input.bio === undefined ? undefined : input.bio,
        avatarMediaId: input.avatarMediaId === undefined ? undefined : input.avatarMediaId,
      },
      include: { _count: { select: { links: true } } },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'person.update',
        targetType: 'person',
        targetId: personId,
        diff: audit.diffOf(
          {
            name: before.name,
            aliases: before.aliases,
            relation: before.relation,
            relationNote: before.relationNote,
            bio: before.bio,
            birthYear: before.birthYear,
            deathYear: before.deathYear,
          },
          {
            name: updated.name,
            aliases: updated.aliases,
            relation: updated.relation,
            relationNote: updated.relationNote,
            bio: updated.bio,
            birthYear: updated.birthYear,
            deathYear: updated.deathYear,
          },
        ),
        ...meta,
      },
      tx,
    );
    return updated;
  });
  return toPersonDto(person);
}

export async function deletePerson(actorId: string, ctx: FamilyContext, personId: string, meta: ActorMeta) {
  const person = await prisma.person.findFirst({ where: { id: personId, familyId: ctx.familyId, deletedAt: null } });
  if (!person) throw notFound('人物不存在');
  if (person.mergedIntoId) throw conflict('该人物已被合并，不能删除；如需恢复请使用「撤销合并」');

  const linkCount = await prisma.itemPerson.count({ where: { personId } });
  if (linkCount > 0) {
    // 被条目引用时不允许直接删，避免「这东西是谁给的」永久丢线；引导用户改用合并
    throw conflict(`该人物已被 ${linkCount} 个条目引用，请改用「合并到其他人物」`, { linkCount });
  }

  await prisma.$transaction(async (tx) => {
    await tx.person.update({ where: { id: personId }, data: { deletedAt: new Date() } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'person.delete',
        targetType: 'person',
        targetId: personId,
        diff: { name: person.name, aliases: person.aliases } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });
}

interface AffectedLink {
  linkId: string;
  itemId: string;
  role: PersonRole;
  disposition: 'moved' | 'deduped';
}

/**
 * 合并前预览：把受影响条目分成两组——
 * - movable：目标人物还没有同角色关联，合并后直接转挂过去；
 * - conflicts：同一物品同一角色两边都在，转挂会撞唯一约束，源侧关联会被去重删除。
 */
export async function previewMerge(userId: string, ctx: FamilyContext, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw badRequest('不能合并到自己');
  const [source, target] = await Promise.all([
    prisma.person.findFirst({
      where: { id: sourceId, familyId: ctx.familyId, OR: [{ deletedAt: null }, { mergedIntoId: { not: null } }] },
    }),
    prisma.person.findFirst({ where: { id: targetId, familyId: ctx.familyId, deletedAt: null } }),
  ]);
  if (!source || !target) throw notFound('人物不存在');
  if (source.mergedIntoId) throw conflict('该人物已经被合并过，请先撤销或选择其他人物');
  if (target.mergedIntoId) throw conflict('不能并入一个已被合并的人物');

  const sourceLinks = await prisma.itemPerson.findMany({
    where: { personId: sourceId, item: { deletedAt: null } },
  });
  const targetLinkKeys = new Set(
    (
      await prisma.itemPerson.findMany({
        where: { personId: targetId, itemId: { in: sourceLinks.map((l) => l.itemId) } },
        select: { itemId: true, role: true },
      })
    ).map((l) => `${l.itemId} ${l.role}`),
  );

  const affected: AffectedLink[] = sourceLinks.map((l) => ({
    linkId: l.id,
    itemId: l.itemId,
    role: l.role,
    disposition: targetLinkKeys.has(`${l.itemId} ${l.role}`) ? 'deduped' : 'moved',
  }));

  const items = await prisma.item.findMany({
    where: {
      id: { in: affected.map((a) => a.itemId) },
      AND: [{ familyId: ctx.familyId }, { deletedAt: null }, itemVisibilityWhere(userId, ctx.role)],
    },
    include: {
      media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
      people: { include: { person: true } },
      _count: { select: { notes: true, media: true } },
    },
  });
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const toItem = (a: AffectedLink) => ({
    linkId: a.linkId,
    role: a.role,
    item: toItemDto(itemMap.get(a.itemId)!, ctx.familyId),
  });

  return {
    source: toPersonDto(source),
    target: toPersonDto(target),
    movable: affected.filter((a) => a.disposition === 'moved').map(toItem),
    conflicts: affected.filter((a) => a.disposition === 'deduped').map(toItem),
    movedCount: affected.filter((a) => a.disposition === 'moved').length,
    conflictCount: affected.filter((a) => a.disposition === 'deduped').length,
    totalCount: affected.length,
  };
}

export async function mergePerson(
  actorId: string,
  ctx: FamilyContext,
  sourceId: string,
  targetId: string,
  meta: ActorMeta,
) {
  if (sourceId === targetId) throw conflict('不能合并到自己');
  const [source, target] = await Promise.all([
    prisma.person.findFirst({ where: { id: sourceId, familyId: ctx.familyId, deletedAt: null } }),
    prisma.person.findFirst({ where: { id: targetId, familyId: ctx.familyId, deletedAt: null } }),
  ]);
  if (!source || !target) throw notFound('人物不存在');
  if (source.mergedIntoId) throw conflict('该人物已经被合并过，请先撤销或选择其他人物');
  if (target.mergedIntoId) throw conflict('不能并入一个已被合并的人物');

  await prisma.$transaction(async (tx) => {
    const links = await tx.itemPerson.findMany({ where: { personId: sourceId } });
    const existing = await tx.itemPerson.findMany({
      where: { personId: targetId, item: { id: { in: links.map((l) => l.itemId) } } },
    });
    const dupKeys = new Set(existing.map((l) => `${l.itemId} ${l.role}`));

    // 源人物的称呼自动留作目标人物的别名（撤销时按快照原样收回）
    const aliasesBefore = target.aliases;
    const aliasesToAdd = [source.name, ...source.aliases].filter(
      (a) => a !== target.name && !aliasesBefore.includes(a),
    );

    const snapshotLinks = links.map((l): Prisma.InputJsonObject => ({
      linkId: l.id,
      itemId: l.itemId,
      role: l.role,
      disposition: dupKeys.has(`${l.itemId} ${l.role}`) ? 'deduped' : 'moved',
    }));

    const snapshot = {
      source: {
        name: source.name,
        aliases: source.aliases,
        relation: source.relation,
        relationNote: source.relationNote,
        birthYear: source.birthYear,
        deathYear: source.deathYear,
        bio: source.bio,
      },
      targetAliasesBefore: aliasesBefore,
      addedAliases: aliasesToAdd,
      links: snapshotLinks,
    } satisfies Prisma.InputJsonObject;

    let moved = 0;
    let deduped = 0;
    for (const link of links) {
      const isDup = dupKeys.has(`${link.itemId} ${link.role}`);
      if (isDup) {
        await tx.itemPerson.delete({ where: { id: link.id } });
        deduped += 1;
      } else {
        await tx.itemPerson.update({ where: { id: link.id }, data: { personId: targetId } });
        moved += 1;
      }
    }

    // 源人物的称呼自动留作目标人物的别名（撤销时按快照原样收回）
    if (aliasesToAdd.length > 0) {
      await tx.person.update({
        where: { id: targetId },
        data: { aliases: { set: [...aliasesBefore, ...aliasesToAdd].slice(0, 10) } },
      });
    }

    await tx.person.update({
      where: { id: sourceId },
      data: { deletedAt: new Date(), mergedIntoId: targetId },
    });

    await tx.personMerge.create({
      data: {
        familyId: ctx.familyId,
        sourceId,
        targetId,
        createdBy: actorId,
        snapshot,
      },
    });

    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'person.merge',
        targetType: 'person',
        targetId,
        diff: {
          mergedFrom: sourceId,
          sourceName: source.name,
          targetName: target.name,
          moved,
          deduped,
          addedAliases: aliasesToAdd,
        } satisfies Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });

  return getPerson(actorId, ctx, targetId);
}

/**
 * 撤销合并：按快照把关联原样挂回源人物，并收回合并时自动补的别名。
 * 只能撤销最近一次、且双方档案未再发生结构性变化的合并，避免把后来的编辑也卷回去。
 */
export async function undoMerge(actorId: string, ctx: FamilyContext, mergeId: string, meta: ActorMeta) {
  const merge = await prisma.personMerge.findFirst({ where: { id: mergeId, familyId: ctx.familyId } });
  if (!merge) throw notFound('合并记录不存在');
  if (merge.undoneAt) throw conflict('这次合并已经撤销过了');

  const [source, target] = await Promise.all([
    prisma.person.findFirst({ where: { id: merge.sourceId, familyId: ctx.familyId } }),
    prisma.person.findFirst({ where: { id: merge.targetId, familyId: ctx.familyId, deletedAt: null } }),
  ]);
  if (!source || !target) throw notFound('人物不存在');
  // 源人物因合并被软删（deletedAt 有值、mergedIntoId 指向 target）是正常状态。
  if (source.deletedAt && !source.mergedIntoId) throw conflict('源人物已被删除，无法撤销合并');
  if (source.mergedIntoId !== target.id) {
    throw conflict('源人物在合并后又被移动过，请先在人物动态中核对再手动处理');
  }

  const snapshot = merge.snapshot as {
    links?: AffectedLink[];
    targetAliasesBefore?: string[];
    addedAliases?: string[];
  };

  await prisma.$transaction(async (tx) => {
    let restored = 0;
    for (const entry of snapshot.links ?? []) {
      const item = await tx.item.findFirst({ where: { id: entry.itemId, deletedAt: null } });
      if (!item) continue; // 物品已删除的关联无法也无需恢复
      const sourceHas = await tx.itemPerson.findUnique({
        where: { itemId_personId_role: { itemId: entry.itemId, personId: source.id, role: entry.role } },
      });
      if (sourceHas) continue;

      if (entry.disposition === 'moved') {
        // 转挂出去的关联：还在目标名下就取回；若已被人手动删掉/改挂则补建
        const moved = await tx.itemPerson.findUnique({ where: { id: entry.linkId } });
        if (moved && moved.personId === target.id) {
          await tx.itemPerson.update({ where: { id: moved.id }, data: { personId: source.id } });
        } else if (!moved) {
          await tx.itemPerson.create({
            data: { itemId: entry.itemId, personId: source.id, role: entry.role },
          });
        }
      } else {
        // 去重删掉的关联：目标自己的那条仍在，给源侧补建
        await tx.itemPerson.create({
          data: { itemId: entry.itemId, personId: source.id, role: entry.role },
        });
      }
      restored += 1;
    }

    // 收回合并时自动补的别名（用户后来手动加的不动）
    const before = snapshot.targetAliasesBefore ?? target.aliases;
    const added = new Set(snapshot.addedAliases ?? []);
    const aliases = target.aliases.filter((a) => !added.has(a) || before.includes(a));
    if (aliases.join('|') !== target.aliases.join('|')) {
      await tx.person.update({ where: { id: target.id }, data: { aliases: { set: aliases } } });
    }

    await tx.person.update({
      where: { id: source.id },
      data: { deletedAt: null, mergedIntoId: null },
    });
    await tx.personMerge.update({ where: { id: merge.id }, data: { undoneAt: new Date() } });

    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'person.merge_undo',
        targetType: 'person',
        targetId: source.id,
        diff: {
          mergeId: merge.id,
          sourceName: source.name,
          targetName: target.name,
          restored,
        } satisfies Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });

  return getPerson(actorId, ctx, source.id);
}
