import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PVZ_NATIVE_REASONS, pvzNativeReason } from '../src/native-reasons.ts';

const NATIVE_DIR = fileURLToPath(new URL('../src/native/', import.meta.url));
const STRING_LITERAL = '"((?:[^"\\\\]|\\\\.)*)"';
const OUTCOMES = new Set(['executed', 'rejected', 'cancelled']);

const literals = (text: string): string[] =>
  [...text.matchAll(new RegExp(STRING_LITERAL, 'g'))].map((match) => match[1]!);

/** 拼进了运行期数值的原因是碎片,逐条对照没有意义;整条赋值跳过。 */
const concatenates = (expression: string): boolean =>
  expression.replace(new RegExp(STRING_LITERAL, 'g'), '""').includes('+');

/** 从 `(` 起到配对的 `)`,跳过字符串字面量里的括号。 */
function callArguments(source: string, open: number): string {
  const literal = new RegExp(STRING_LITERAL, 'g');
  let depth = 0;
  for (let cursor = open; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '"') {
      literal.lastIndex = cursor;
      const match = literal.exec(source);
      if (match?.index === cursor) {
        cursor = literal.lastIndex - 1;
        continue;
      }
    }
    if (character === '(') depth += 1;
    else if (character === ')' && (depth -= 1) === 0) return source.slice(open, cursor + 1);
  }
  return '';
}

interface NativeStrings {
  /** 出现在 `reason` 位置上的完整原因,回执必须逐条译得出。 */
  reasons: Map<string, string>;
  /** 原生源码里出现过的全部字面量,用来抓映射表里已经没有出处的键。 */
  all: Set<string>;
}

function readNativeStrings(): NativeStrings {
  const reasons = new Map<string, string>();
  const all = new Set<string>();
  for (const file of readdirSync(NATIVE_DIR).filter((name) => /\.(?:h|cpp)$/.test(name))) {
    const source = readFileSync(join(NATIVE_DIR, file), 'utf8');
    for (const literal of literals(source)) all.add(literal);

    const assignment = /\breason\s*=(?!=)/g;
    let match: RegExpExecArray | null;
    while ((match = assignment.exec(source)) !== null) {
      const expression = source.slice(assignment.lastIndex, source.indexOf(';', assignment.lastIndex));
      // `const std::string& reason = {}` 是默认形参,不是一条原因。
      if (/^\s*\{\}/.test(expression) || concatenates(expression)) continue;
      for (const literal of literals(expression)) if (literal) reasons.set(literal, file);
    }

    const send = /\bSend(?:Ack|Result)\s*\(/g;
    while ((match = send.exec(source)) !== null) {
      const args = callArguments(source, send.lastIndex - 1);
      if (args.includes('std::string& reason')) continue;
      for (const literal of literals(args)) {
        if (literal && !OUTCOMES.has(literal)) reasons.set(literal, file);
      }
    }
  }
  return { reasons, all };
}

describe('PvZ 原生原因的中文映射', () => {
  const native = readNativeStrings();

  it('原生每一条 reason 字面量都译得出中文', () => {
    const untranslated = [...native.reasons]
      .filter(([reason]) => !pvzNativeReason(reason))
      .map(([reason, file]) => `${file}: ${reason}`);
    expect(untranslated).toEqual([]);
  });

  it('映射表里没有原生已经不再产出的键', () => {
    const stale = Object.keys(PVZ_NATIVE_REASONS).filter((reason) => !native.all.has(reason));
    expect(stale).toEqual([]);
  });

  it('绝对种植的入口拒绝原因均属于确定失败', () => {
    for (const reason of [
      'planting slot is outside the seed bank',
      'planting cell is outside this board',
      'planting slot is not present in the seed bank',
      'planting slot does not hold the plant the action asked for',
      'planting board is paused',
      'planting seed packet is not active in the seed bank',
      'planting seed packet is still on cooldown',
      'planting seed packet costs more sun than is available',
      'planting cell will not take this plant',
    ]) {
      expect(pvzNativeReason(reason)?.certainty, reason).toBe('failed');
    }
  });

  it('中文短、不含英文原文、不给建议', () => {
    for (const [reason, mapped] of Object.entries(PVZ_NATIVE_REASONS)) {
      expect(mapped.text, reason).not.toBe('');
      expect(mapped.text.length, reason).toBeLessThanOrEqual(40);
      expect(mapped.text, reason).toMatch(/[一-鿿]/u);
      expect(mapped.text, reason).not.toMatch(/建议|不妨|可以试|换一/u);
    }
  });

  it('未验真只留给输入已经进了游戏、效果确证不了的那一类', () => {
    const unknown = Object.entries(PVZ_NATIVE_REASONS)
      .filter(([, mapped]) => mapped.certainty === 'unknown')
      .map(([reason]) => reason);
    expect(unknown).toContain('relative planting was cancelled after the click was delivered');
    expect(unknown).toContain('planting result could not be verified after the board screen changed');
    // 点下去之前就没成的,是确定失败,不是「不知道成没成」。
    expect(pvzNativeReason('relative planting was cancelled')?.certainty).toBe('failed');
    expect(pvzNativeReason('relative planting seed packet is still on cooldown')?.certainty).toBe('failed');
    expect(pvzNativeReason('relative planting cell is outside the board')?.certainty).toBe('failed');
  });
});
