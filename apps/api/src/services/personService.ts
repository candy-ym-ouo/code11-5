import type { Person, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { conflict, notFound } from '../http/errors';
import * as audit from './auditService';
import { toItemDto, toPersonDto } from '../serializers';
import type { FamilyContext } from './permissionService';
import { itemVisibilityWhere } from './visibility';
import { mergeNotes, normalizeAliases } from './personUtils';

export { mergeNotes, normalizeAliases } from './personUtils';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface PersonInput {
  name?: string;
  aliases?: string[] | null;
  relation?: string | null;
  relationNote?: string | null;
  birthYear?: number | null;
  deathYear?: number | null;
  bio?: string | null;
  avatarMediaId?: string | null;
}

const PERSON_LIST_INCLUDE = { _count: { select: { links: true } } } satisfies Prisma.PersonInclude;

async function findAlivePerson(familyId: string, personId: string) {
  return prisma.person.findFirst({
    where: { id: personId, familyId, deletedAt: null },
  });
}

export async function listPeople(ctx: FamilyContext, q?: string, opts: { includeMerged?: boolean } = {}) {
  const where: Prisma.PersonWhereInput = { familyId: ctx.familyId, deletedAt: null };
  if (!opts.includeMerged) where.mergedIntoId = null;
  if (q) {
    const contains = { contains: q, mode: 'insensitive' as const };
    // aliases 是数组：PostgreSQL 支持 ILIKE ANY，但 Prisma 没有直接封装，
    // 用字符串数组的 has（等值）覆盖中文/精确叫法，拉丁字母模糊匹配交给 name/relation。
    where.OR = [{ name: contains }, { relation: contains }, { aliases: { has: q } }];
  }
  const rows = await prisma.person.findMany({
    where,
    include: PERSON_LIST_INCLUDE,
    orderBy: [{ mergedIntoId: 'asc' }, { name: 'asc' }],
    take: 500,
  });
  return rows.map(toPersonDto);
}

async function personMerges(familyId: string, personId: string) {
  const rows = await prisma.personMerge.findMany({
    where: {
      familyId,
      OR: [{ sourceId: personId }, { targetId: personId }],
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return rows.map((m) => ({
    id: m.id,
    sourceId: m.sourceId,
    sourceName: m.sourceName,
    targetId: m.targetId,
    targetName: m.targetName,
    undone: Boolean(m.undoneAt),
    undoneAt: m.undoneAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  }));
}

export async function getPerson(userId: string, ctx: FamilyContext, personId: string) {
  const person = await prisma.person.findFirst({
    where: { id: personId, familyId: ctx.familyId, deletedAt: null },
    include: PERSON_LIST_INCLUDE,
  });
  if (!person) throw notFound('人物不存在');

  // 已合并的人物：不直接展开，返回 409 + 去向，前端据此给出「已并入 X」的追溯入口
  if (person.mergedIntoId) {
    const mergedInto = await prisma.person.findFirst({
      where: { id: person.mergedIntoId, familyId: ctx.familyId, deletedAt: null },
      select: { id: true, name: true },
    });
    throw conflict('该人物已合并', {
      merged: true,
      person: toPersonDto(person),
      mergedInto: mergedInto ?? null,
      merges: await personMerges(ctx.familyId, personId),
    });
  }

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
    orderBy: { item: { sortAt: 'desc' } },
    take: 200,
  });

  return {
    ...toPersonDto(person),
    items: links.map((l) => ({ role: l.role, note: l.note, ...toItemDto(l.item, ctx.familyId) })),
    merges: await personMerges(ctx.familyId, personId),
  };
}

export async function createPerson(actorId: string, ctx: FamilyContext, input: PersonInput, meta: ActorMeta) {
  const aliases = normalizeAliases(input.aliases, input.name);
  const person = await prisma.$transaction(async (tx) => {
    const created = await tx.person.create({
      data: {
        familyId: ctx.familyId,
        name: input.name!,
        aliases,
        relation: input.relation ?? null,
        relationNote: input.relationNote ?? null,
        birthYear: input.birthYear ?? null,
        deathYear: input.deathYear ?? null,
        bio: input.bio ?? null,
        avatarMediaId: input.avatarMediaId ?? null,
        createdBy: actorId,
      },
      include: PERSON_LIST_INCLUDE,
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'person.create',
        targetType: 'person',
        targetId: created.id,
        diff: { name: created.name, aliases } as Prisma.InputJsonValue,
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
  const before = await findAlivePerson(ctx.familyId, personId);
  if (!before) throw notFound('人物不存在');
  if (before.mergedIntoId) throw conflict('该人物已被合并，请先撤销合并再修改');

  const aliases = input.aliases === undefined ? undefined : normalizeAliases(input.aliases, input.name ?? before.name);

  const person = await prisma.$transaction(async (tx) => {
    const updated = await tx.person.update({
      where: { id: personId },
      data: {
        name: input.name ?? undefined,
        aliases,
        relation: input.relation === undefined ? undefined : input.relation,
        relationNote: input.relationNote === undefined ? undefined : input.relationNote,
        birthYear: input.birthYear === undefined ? undefined : input.birthYear,
        deathYear: input.deathYear === undefined ? undefined : input.deathYear,
        bio: input.bio === undefined ? undefined : input.bio,
        avatarMediaId: input.avatarMediaId === undefined ? undefined : input.avatarMediaId,
      },
      include: PERSON_LIST_INCLUDE,
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
  const person = await findAlivePerson(ctx.familyId, personId);
  if (!person) throw notFound('人物不存在');
  if (person.mergedIntoId) throw conflict('该人物已被合并，请先撤销合并');

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
        diff: { name: person.name } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });
}

interface MergeLinkRow {
  linkId: string;
  itemId: string;
  role: string;
  note: string | null;
}

function snapshotPerson(p: Person): Prisma.InputJsonValue {
  return {
    id: p.id,
    name: p.name,
    aliases: p.aliases,
    relation: p.relation,
    relationNote: p.relationNote,
    birthYear: p.birthYear,
    deathYear: p.deathYear,
    bio: p.bio,
    avatarMediaId: p.avatarMediaId,
    createdAt: p.createdAt.toISOString(),
  } as unknown as Prisma.InputJsonValue;
}

/**
 * 合并预览：按「条目 + 关联方式」比对来源与目标。
 * - moved：来源独有，合并后会整体挪到目标（保留关系说明）
 * - conflicts：同一条目、同一种关联方式两边都有，去重后保留目标的一条，
 *   关系说明并列展示，让用户在确认前看到将被折叠/丢弃的内容
 */
export async function previewMerge(userId: string, ctx: FamilyContext, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw conflict('不能合并到自己');
  const [source, target] = await Promise.all([
    findAlivePerson(ctx.familyId, sourceId),
    findAlivePerson(ctx.familyId, targetId),
  ]);
  if (!source || !target) throw notFound('人物不存在');
  if (source.mergedIntoId || target.mergedIntoId) throw conflict('已合并的人物不能再次合并，请先撤销相关合并');

  const itemFilter: Prisma.ItemWhereInput = {
    AND: [{ familyId: ctx.familyId }, { deletedAt: null }, itemVisibilityWhere(userId, ctx.role)],
  };
  const [sourceLinks, targetLinks, items] = await prisma.$transaction([
    prisma.itemPerson.findMany({ where: { personId: sourceId, item: itemFilter } }),
    prisma.itemPerson.findMany({ where: { personId: targetId, item: itemFilter } }),
    prisma.item.findMany({
      where: {
        AND: [
          { familyId: ctx.familyId },
          { deletedAt: null },
          itemVisibilityWhere(userId, ctx.role),
          { people: { some: { personId: { in: [sourceId, targetId] } } } },
        ],
      },
      select: { id: true, title: true, category: true, status: true },
      orderBy: { sortAt: 'desc' },
      take: 500,
    }),
  ]);

  const targetKeys = new Set(targetLinks.map((l) => `${l.itemId} ${l.role}`));
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const toEntry = (l: MergeLinkRow & { conflict: boolean; targetNote?: string | null }) => {
    const item = itemMap.get(l.itemId);
    return {
      linkId: l.linkId,
      itemId: l.itemId,
      itemTitle: item?.title ?? '（无权查看或已删除的条目）',
      category: item?.category ?? null,
      status: item?.status ?? null,
      role: l.role,
      sourceNote: l.note,
      targetNote: l.targetNote ?? null,
      conflict: l.conflict,
    };
  };

  const targetNoteByKey = new Map(targetLinks.map((l) => [`${l.itemId} ${l.role}`, l.note]));
  const moved = sourceLinks
    .filter((l) => !targetKeys.has(`${l.itemId} ${l.role}`))
    .map((l) => toEntry({ linkId: l.id, itemId: l.itemId, role: l.role, note: l.note, conflict: false }));
  const conflicts = sourceLinks
    .filter((l) => targetKeys.has(`${l.itemId} ${l.role}`))
    .map((l) =>
      toEntry({
        linkId: l.id,
        itemId: l.itemId,
        role: l.role,
        note: l.note,
        targetNote: targetNoteByKey.get(`${l.itemId} ${l.role}`) ?? null,
        conflict: true,
      }),
    );

  // 受可见性限制看不到的条目也要给个数，避免「预览 3 条、实际合并了 5 条」的困惑
  const [totalSource, totalTarget, trashedLinks] = await Promise.all([
    prisma.itemPerson.count({ where: { personId: sourceId } }),
    prisma.itemPerson.count({ where: { personId: targetId } }),
    prisma.itemPerson.count({
      where: { personId: { in: [sourceId, targetId] }, item: { deletedAt: { not: null } } },
    }),
  ]);
  const visibleLinkCount = new Set([...sourceLinks, ...targetLinks].map((l) => l.id)).size;
  const hiddenCount = totalSource + totalTarget - visibleLinkCount - trashedLinks;

  return {
    source: toPersonDto(source),
    target: toPersonDto(target),
    moved,
    conflicts,
    movedCount: moved.length,
    conflictCount: conflicts.length,
    hiddenCount: Math.max(0, hiddenCount),
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
    findAlivePerson(ctx.familyId, sourceId),
    findAlivePerson(ctx.familyId, targetId),
  ]);
  if (!source || !target) throw notFound('人物不存在');
  if (source.mergedIntoId || target.mergedIntoId) throw conflict('已合并的人物不能再次合并，请先撤销相关合并');

  await prisma.$transaction(async (tx) => {
    const links = await tx.itemPerson.findMany({ where: { personId: sourceId } });

    // 先写合并记录（含完整快照），保证之后的每一步都能据此追溯/还原
    const movedSnap: MergeLinkRow[] = [];
    const conflictSnap: (MergeLinkRow & { targetLinkId: string; targetNote: string | null })[] = [];
    for (const link of links) {
      const existing = await tx.itemPerson.findUnique({
        where: { itemId_personId_role: { itemId: link.itemId, personId: targetId, role: link.role } },
      });
      if (existing) {
        conflictSnap.push({
          linkId: link.id,
          itemId: link.itemId,
          role: link.role,
          note: link.note,
          targetLinkId: existing.id,
          targetNote: existing.note,
        });
      } else {
        movedSnap.push({ linkId: link.id, itemId: link.itemId, role: link.role, note: link.note });
      }
    }

    await tx.personMerge.create({
      data: {
        familyId: ctx.familyId,
        sourceId,
        sourceName: source.name,
        targetId,
        targetName: target.name,
        sourceSnapshot: snapshotPerson(source),
        linksSnapshot: { moved: movedSnap, conflicts: conflictSnap } as unknown as Prisma.InputJsonValue,
        createdBy: actorId,
      },
    });

    for (const link of links) {
      const existing = await tx.itemPerson.findUnique({
        where: { itemId_personId_role: { itemId: link.itemId, personId: targetId, role: link.role } },
      });
      if (existing) {
        // 同条目同角色：保留目标的一条；来源的关系说明不丢失，追加进目标 note
        const mergedNote = mergeNotes(existing.note, link.note);
        if (mergedNote !== existing.note) {
          await tx.itemPerson.update({ where: { id: existing.id }, data: { note: mergedNote } });
        }
        await tx.itemPerson.delete({ where: { id: link.id } });
      } else {
        await tx.itemPerson.update({ where: { id: link.id }, data: { personId: targetId } });
      }
    }

    // 来源人物的别名并入目标（去重），名字本身也记为目标的别名，方便以后还能搜到
    const aliasExtra = [source.name, ...source.aliases].filter(
      (a) => !target.aliases.some((x) => x.toLowerCase() === a.toLowerCase()) && a.toLowerCase() !== target.name.toLowerCase(),
    );
    if (aliasExtra.length) {
      await tx.person.update({
        where: { id: targetId },
        data: { aliases: normalizeAliases([...target.aliases, ...aliasExtra], target.name) },
      });
    }

    await tx.person.update({ where: { id: sourceId }, data: { deletedAt: new Date(), mergedIntoId: targetId } });
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
          moved: movedSnap.length,
          conflicts: conflictSnap.length,
        } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });

  return getPerson(actorId, ctx, targetId);
}

/**
 * 撤销最近一次合并（必须尚未撤销）。
 * 还原策略全部以合并快照为准，不碰合并之后新增/修改的关联：
 * - moved：目标身上的同一 linkId 若仍是当时挪过去的（person 未再变），重新指回来源；
 *   若这条关联已被用户编辑/删除（id 对不上），按快照新建一条；
 * - conflicts：目标的关联保留不动；来源那条按快照重建（不存在同 item+person+role 时），
 *   合并时并入 note 的文字保留在目标上，不强行摘除。
 * - 目标在合并后获得的别名保留，但把来源名字/别名从目标别名中去掉（恢复原状）。
 */
export async function undoMerge(
  actorId: string,
  ctx: FamilyContext,
  mergeId: string,
  meta: ActorMeta,
): Promise<{ restoredId: string }> {
  const record = await prisma.personMerge.findFirst({ where: { id: mergeId, familyId: ctx.familyId } });
  if (!record) throw notFound('合并记录不存在');
  if (record.undoneAt) throw conflict('这次合并已经撤销过了');

  const source = await prisma.person.findFirst({ where: { id: record.sourceId, familyId: ctx.familyId } });
  if (!source) throw notFound('来源人物已不存在，无法还原');
  if (!source.mergedIntoId || source.mergedIntoId !== record.targetId) {
    throw conflict('来源人物在此之后又发生过合并，请先撤销最近的一次合并');
  }

  const snap = record.linksSnapshot as unknown as {
    moved: MergeLinkRow[];
    conflicts: (MergeLinkRow & { targetLinkId: string })[];
  };

  await prisma.$transaction(async (tx) => {
    for (const l of snap.moved ?? []) {
      const current = await tx.itemPerson.findUnique({ where: { id: l.linkId } });
      if (current && current.personId === record.targetId && current.itemId === l.itemId && current.role === l.role) {
        // 合并后没被动过：直接指回来源
        await tx.itemPerson.update({
          where: { id: l.linkId },
          data: { personId: record.sourceId, note: l.note },
        });
      } else if (!current) {
        // 被删除了：按快照重建（唯一键若被占用则跳过，尊重现状）
        const clash = await tx.itemPerson.findUnique({
          where: { itemId_personId_role: { itemId: l.itemId, personId: record.sourceId, role: l.role as never } },
        });
        if (!clash) {
          await tx.itemPerson.create({
            data: { id: l.linkId, itemId: l.itemId, personId: record.sourceId, role: l.role as never, note: l.note },
          });
        }
      }
      // current 存在但 personId 已不是目标（被再次编辑过）：保持现状，不覆盖用户的新选择
    }

    for (const l of snap.conflicts ?? []) {
      const clash = await tx.itemPerson.findUnique({
        where: { itemId_personId_role: { itemId: l.itemId, personId: record.sourceId, role: l.role as never } },
      });
      if (!clash) {
        const item = await tx.item.findUnique({ where: { id: l.itemId }, select: { deletedAt: true } });
        if (item && !item.deletedAt) {
          await tx.itemPerson.create({
            data: { itemId: l.itemId, personId: record.sourceId, role: l.role as never, note: l.note },
          });
        }
      }
    }

    // 目标别名回滚：只移除当时从来源并进去的那些
    const broughtIn = new Set([record.sourceName, ...((record.sourceSnapshot as { aliases?: string[] }).aliases ?? [])].map((s) => s.toLowerCase()));
    const target = await tx.person.findUnique({ where: { id: record.targetId }, select: { aliases: true, name: true } });
    if (target) {
      const kept = target.aliases.filter((a) => !broughtIn.has(a.toLowerCase()));
      if (kept.length !== target.aliases.length) {
        await tx.person.update({ where: { id: record.targetId }, data: { aliases: kept } });
      }
    }

    // 来源档案字段按快照还原（合并期间来源不可编辑，快照即为最后状态）
    const s = record.sourceSnapshot as Record<string, unknown>;
    await tx.person.update({
      where: { id: record.sourceId },
      data: {
        name: s.name as string,
        aliases: (s.aliases as string[]) ?? [],
        relation: (s.relation as string | null) ?? null,
        relationNote: (s.relationNote as string | null) ?? null,
        birthYear: (s.birthYear as number | null) ?? null,
        deathYear: (s.deathYear as number | null) ?? null,
        bio: (s.bio as string | null) ?? null,
        avatarMediaId: (s.avatarMediaId as string | null) ?? null,
        mergedIntoId: null,
        deletedAt: null,
      },
    });

    await tx.personMerge.update({
      where: { id: record.id },
      data: { undoneAt: new Date(), undoneById: actorId },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId,
        action: 'person.merge_undo',
        targetType: 'person',
        targetId: record.sourceId,
        diff: {
          mergeId: record.id,
          sourceId: record.sourceId,
          sourceName: record.sourceName,
          targetId: record.targetId,
          targetName: record.targetName,
          restoredLinks: (snap.moved ?? []).length + (snap.conflicts ?? []).length,
        } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
  });

  return { restoredId: record.sourceId };
}

/** 人物档案上的合并历史（含作为来源与作为目标两个方向），用于「历史关联可追溯」。 */
export async function listMergeHistory(ctx: FamilyContext, personId: string) {
  const person = await prisma.person.findFirst({
    where: { id: personId, familyId: ctx.familyId, deletedAt: null },
    select: { id: true },
  });
  if (!person) throw notFound('人物不存在');
  return personMerges(ctx.familyId, personId);
}
