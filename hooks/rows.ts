import { oneLine, toJson } from './trace'

const ARG_MAX = 90
const RESULT_MAX = 90

export const compactNum = (n: number): string =>
  n < 1000 ? String(n) : n < 1e6 ? `${+(n / 1000).toFixed(1)}k` : `${+(n / 1e6).toFixed(1)}M`

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

// Keys that best describe a call, in order; the first string one present wins.
const ARG_KEYS = [
  'command',
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
  'skill',
  'subject',
]

// What a row says about a call: the tool's short name and its most telling argument.
export const toolSummary = (tool: string, args: Readonly<Record<string, unknown>>): { name: string; arg: string } => {
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join('.') : tool
  const pattern = str(args.pattern)
  const path = str(args.path) ?? str(args.file_path)
  const picked =
    tool === 'Grep' && pattern
      ? `${pattern}${path ? ` in ${path}` : ''}`
      : (ARG_KEYS.map(k => str(args[k])).find(Boolean) ??
        Object.values(args).map(str).find(Boolean) ??
        (Object.keys(args).length ? toJson(args) : ''))
  return { name, arg: oneLine(picked, ARG_MAX) }
}

// First non-empty line of a result, with how many more lines it had.
export const resultSummary = (text: string): string => {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return '（无输出）'
  const more = lines.length > 1 ? `  (+${lines.length - 1} 行)` : ''
  return `${oneLine(lines[0] ?? '', RESULT_MAX)}${more}`
}

export type Run = { text: string; isMatch: boolean }

// Splits text into runs around case-insensitive matches of query, for highlighting.
export const highlight = (text: string, query: string): Run[] => {
  const q = query.trim().toLowerCase()
  if (q === '') return [{ text, isMatch: false }]
  const lower = text.toLowerCase()
  const runs: Run[] = []
  let at = 0
  for (let hit = lower.indexOf(q); hit !== -1; hit = lower.indexOf(q, at)) {
    if (hit > at) runs.push({ text: text.slice(at, hit), isMatch: false })
    runs.push({ text: text.slice(hit, hit + q.length), isMatch: true })
    at = hit + q.length
  }
  if (at < text.length) runs.push({ text: text.slice(at), isMatch: false })
  return runs
}

// The first n lines of a long text, and how many it has.
export const preview = (text: string, n: number): { head: string; total: number; isCut: boolean } => {
  const lines = text.split('\n')
  return { head: lines.slice(0, n).join('\n'), total: lines.length, isCut: lines.length > n }
}

export const durationTone = (ms: number): 'error' | 'warning' | undefined =>
  ms >= 60_000 ? 'error' : ms >= 10_000 ? 'warning' : undefined
