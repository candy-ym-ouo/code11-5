import { describe, expect, it } from 'vitest';
import { mergeNotes, normalizeAliases } from './personUtils';

describe('normalizeAliases', () => {
  it('trims blanks and drops empty entries', () => {
    expect(normalizeAliases([' 老张 ', '', '  ', '张师傅'])).toEqual(['老张', '张师傅']);
  });

  it('dedupes case-insensitively but keeps first spelling', () => {
    expect(normalizeAliases(['Lao Zhang', 'lao zhang', '老张'])).toEqual(['Lao Zhang', '老张']);
  });

  it('drops aliases identical to the primary name', () => {
    expect(normalizeAliases(['外公', '老张'], '外公')).toEqual(['老张']);
    expect(normalizeAliases([' Grandpa '], 'grandpa')).toEqual([]);
  });

  it('caps at 10 aliases and ignores overlong entries', () => {
    const many = Array.from({ length: 12 }, (_, i) => `别名${i}`);
    expect(normalizeAliases(many)).toHaveLength(10);
    expect(normalizeAliases(['a'.repeat(41), '合法'])).toEqual(['合法']);
  });

  it('accepts nullish input', () => {
    expect(normalizeAliases(undefined)).toEqual([]);
    expect(normalizeAliases(null)).toEqual([]);
  });
});

describe('mergeNotes', () => {
  it('keeps existing note when incoming is empty', () => {
    expect(mergeNotes('原话', null)).toBe('原话');
    expect(mergeNotes('原话', '   ')).toBe('原话');
  });

  it('uses incoming note when target has none', () => {
    expect(mergeNotes(null, '来源备注')).toBe('来源备注');
    expect(mergeNotes('  ', '来源备注')).toBe('来源备注');
  });

  it('does not duplicate text already contained', () => {
    expect(mergeNotes('外公送的', '外公送的')).toBe('外公送的');
    expect(mergeNotes('这是外公送的箱子', '外公送的')).toBe('这是外公送的箱子');
  });

  it('joins distinct notes with a Chinese semicolon', () => {
    expect(mergeNotes('甲', '乙')).toBe('甲；乙');
  });

  it('caps merged length at 200', () => {
    const a = 'a'.repeat(150);
    const b = 'b'.repeat(100);
    const merged = mergeNotes(a, b);
    expect(merged).toHaveLength(200);
  });
});
