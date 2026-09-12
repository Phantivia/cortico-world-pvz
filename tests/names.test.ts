import { describe, expect, it } from 'vitest';
import { plantTypeOf } from '../src/names.ts';

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
