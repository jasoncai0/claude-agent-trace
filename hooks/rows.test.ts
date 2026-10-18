import { expect, test } from 'claude-code/testing'

import { compactNum, highlight, preview, resultSummary, toolSummary } from './rows'

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
