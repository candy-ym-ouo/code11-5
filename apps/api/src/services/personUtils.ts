/**
 * 人物档案相关的纯函数：别名规范化、关联说明合并。
 * 抽出来单独放是为了不连数据库也能单测。
 */

/** 规范化别名：去空白、去重（忽略大小写）、剔除与本名重复的项，最多 10 个。 */
export function normalizeAliases(aliases: string[] | null | undefined, name?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const nameKey = name?.trim().toLowerCase();
  for (const raw of aliases ?? []) {
    const a = raw.trim();
    if (!a || a.length > 40) continue;
    const key = a.toLowerCase();
    if (nameKey && key === nameKey) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * 合并冲突时拼接两边的「关系说明」：
 * - 目标已有、来源为空：保留目标；
 * - 目标为空：用来源；
 * - 内容重复（目标已包含来源文字）：不重复拼接；
 * - 否则用中文分号连接，总长限制 200（与 item_people.note 上限一致）。
 */
export function mergeNotes(existing: string | null, incoming: string | null): string | null {
  const a = (existing ?? '').trim();
  const b = (incoming ?? '').trim();
  if (!b) return existing;
  if (!a) return incoming;
  if (a.includes(b)) return existing;
  return `${a}；${b}`.slice(0, 200);
}
