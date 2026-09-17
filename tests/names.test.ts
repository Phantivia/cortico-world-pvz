import { describe, expect, it } from 'vitest';
import { plantTypeOf, specialActionDisplayName, specialActionNameOf } from '../src/names.ts';

it('种子放置与水族馆购买名称说明实际操作，原来的中文名称仍可解析', () => {
  for (const [action, label, oldLabel] of [
    ['launch', '放置种子包', '发射'],
    ['buy_snorkel', '购买潜水僵尸', '购买潜水装备'],
  ]) {
    expect(specialActionDisplayName(action!)).toBe(label);
    expect(specialActionNameOf(label!)).toBe(action);
    expect(specialActionNameOf(oldLabel!)).toBe(action);
  }
});

describe('PvZ 可见植物名解析', () => {
  it.each([
    ['', null],
    ['   ', null],
    ['0x10', null],
    ['1e1', null],
    ['-1', null],
    ['0', 0],
    ['16', 16],
    ['Peashooter', 0],
    ['wall-nut', 3],
  ])('只接受十进制 id 或规范化名称 %#', (value, expected) => {
    expect(plantTypeOf(value)).toBe(expected);
  });
});
