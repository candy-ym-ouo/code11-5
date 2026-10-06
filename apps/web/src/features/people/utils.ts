/** 别名输入框（顿号/逗号/空格分隔）→ 去空去重后的数组。 */
export function splitAliases(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[、,，\s]+/)) {
    const v = part.trim();
    if (v) seen.add(v);
  }
  return [...seen].slice(0, 10);
}
