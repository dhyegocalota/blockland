import { describe, expect, it } from 'vitest';
import { appendChatLine, dropChatLine, type ChatLine } from './chat';

const line = (id: number): ChatLine => ({ id, name: `n${id}`, text: `t${id}` });

describe('appendChatLine', () => {
  it('adds a line to the end', () => {
    expect(appendChatLine({ lines: [line(1)], line: line(2), cap: 6 })).toEqual([line(1), line(2)]);
  });

  it('keeps only the most recent lines up to the cap', () => {
    const lines = [line(1), line(2), line(3)];
    expect(appendChatLine({ lines, line: line(4), cap: 3 })).toEqual([line(2), line(3), line(4)]);
  });
});

describe('dropChatLine', () => {
  it('removes the line with the given id', () => {
    expect(dropChatLine({ lines: [line(1), line(2)], id: 1 })).toEqual([line(2)]);
  });

  it('leaves the list unchanged when the id is absent', () => {
    expect(dropChatLine({ lines: [line(1)], id: 9 })).toEqual([line(1)]);
  });
});
