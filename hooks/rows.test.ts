import { expect, test } from 'claude-code/testing'

import { cacheHit, compactNum, highlight, isContextJump, preview, resultSummary, toolStats, toolSummary } from './rows'

test('a row names the tool and its most telling argument', async () => {
  expect(toolSummary('Bash', { command: 'ls -la', description: 'list' })).toEqual({ name: 'Bash', arg: 'ls -la' })
  expect(toolSummary('Read', { file_path: '/a/b.ts', limit: 20 })).toEqual({ name: 'Read', arg: '/a/b.ts' })
  expect(toolSummary('Grep', { pattern: 'foo', path: 'src' }).arg).toBe('foo in src')
  expect(toolSummary('mcp__github__get_issue', { owner: 'x', number: 3 }).name).toBe('github.get_issue')
  expect(toolSummary('X', { n: 1 }).arg).toBe('{"n":1}')
})

test('a result shows its first line and how many more', async () => {
  expect(resultSummary('\n a \nb\nc')).toBe('a  (+2 行)')
  expect(resultSummary('  ')).toBe('（无输出）')
})

test('search matches split into runs, case-insensitively', async () => {
  expect(highlight('Run LS here, ls', 'ls')).toEqual([
    { text: 'Run ', isMatch: false },
    { text: 'LS', isMatch: true },
    { text: ' here, ', isMatch: false },
    { text: 'ls', isMatch: true },
  ])
  expect(highlight('abc', '')).toEqual([{ text: 'abc', isMatch: false }])
})

test('numbers and long texts are shortened for reading', async () => {
  expect(compactNum(950)).toBe('950')
  expect(compactNum(45_300)).toBe('45.3k')
  expect(preview('1\n2\n3', 2)).toEqual({ head: '1\n2', total: 3, isCut: true })
})

test('cache reuse, context jumps and per-tool totals', async () => {
  const u = (input: number, cacheRead: number, cacheWrite = 0) => ({ input, output: 1, cacheRead, cacheWrite })
  expect(cacheHit(u(10, 90))).toBe(0.9)
  expect(cacheHit(u(0, 0))).toBeUndefined()
  expect(isContextJump(u(1000, 0), u(8000, 0))).toBe(true)
  expect(isContextJump(u(1000, 0), u(2000, 0))).toBe(false)
  expect(isContextJump(undefined, u(8000, 0))).toBe(false)
  const t = (name: string, ms: number, isError = false) => ({ id: name + ms, kind: 'tool' as const, turn: 1, title: name, detail: '', name, start: 0, end: ms, isError })
  expect(toolStats([t('Read', 10), t('Bash', 100, true), t('Bash', 300)])).toEqual([
    { name: 'Bash', count: 2, totalMs: 400, avgMs: 200, errors: 1 },
    { name: 'Read', count: 1, totalMs: 10, avgMs: 10, errors: 0 },
  ])
})
