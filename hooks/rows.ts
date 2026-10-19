import type { StepUsage, TraceEvent } from '../types'
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

// Share of the prompt served from the cache; undefined when the step sent nothing.
export const cacheHit = (u: StepUsage): number | undefined => {
  const sent = u.input + u.cacheRead + u.cacheWrite
  return sent > 0 ? u.cacheRead / sent : undefined
}

export const CACHE_LOW = 0.5
const JUMP_RATIO = 3
const JUMP_MIN_TOKENS = 5000

// Tokens a step sent past the cache grew sharply against the loop's previous step.
export const isContextJump = (prev: StepUsage | undefined, cur: StepUsage): boolean => {
  const fresh = (u: StepUsage) => u.input + u.cacheWrite
  return prev !== undefined && fresh(cur) >= JUMP_MIN_TOKENS && fresh(cur) > fresh(prev) * JUMP_RATIO
}

export type ToolStat = { name: string; count: number; totalMs: number; avgMs: number; errors: number }

// Per-tool totals, slowest in total first.
export const toolStats = (events: readonly TraceEvent[]): ToolStat[] => {
  const by = new Map<string, { count: number; totalMs: number; errors: number }>()
  for (const ev of events) {
    if (ev.kind !== 'tool') continue
    const name = ev.name ?? ev.title.split(' ')[0] ?? ''
    const ms = ev.start !== undefined && ev.end !== undefined ? ev.end - ev.start : 0
    const old = by.get(name) ?? { count: 0, totalMs: 0, errors: 0 }
    by.set(name, { count: old.count + 1, totalMs: old.totalMs + ms, errors: old.errors + (ev.isError || ev.isDenied ? 1 : 0) })
  }
  return [...by.entries()]
    .map(([name, v]) => ({ name, ...v, avgMs: v.count ? v.totalMs / v.count : 0 }))
    .sort((a, b) => b.totalMs - a.totalMs)
}
