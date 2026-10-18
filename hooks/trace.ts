import type { SessionMessage } from 'claude-code'

import type { TraceEvent, TraceKind, TraceMode } from '../types'

export const MAX_EVENTS = 2000
const SNIPPET = 160
const LANES: readonly TraceKind[] = ['input', 'model', 'tool']
const LANE_NAMES: Record<TraceKind, string> = { input: '输入', model: '模型', tool: '工具' }
const COLORS: Record<TraceKind, string> = { input: '#5b8def', model: '#8e6cc0', tool: '#e0862a' }
const ERROR_COLOR = '#d9534f'
const WAIT_COLOR = '#c4b3dd'
const STEP_INPUT_COLOR = '#5cb85c'
const INPUT_SHARE = 0.25
const SVG_WIDTH = 1000
const LABEL_WIDTH = 44
const LANE_HEIGHT = 18
const BAR_HEIGHT = 12
const MIN_BAR = 2
// Svg source caps at 131072 chars; a model step draws up to three rects, ~850 chars.
export const TIMELINE_MAX = 120

export const oneLine = (text: string, max = SNIPPET): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export const toJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

// Tool args minus the envelope keys tool.call adds beside them.
export const toolArgs = (e: Record<string, unknown>): Record<string, unknown> => {
  const { tool: _t, tool_use_id: _id, agentId: _a, requestMeta: _m, consent: _c, ...args } = e
  return args
}

export const currentTurn = (list: readonly TraceEvent[]): number =>
  list.reduce((n, ev) => (ev.kind === 'input' && !ev.agentId ? n + 1 : n), 0)

export const append = (list: readonly TraceEvent[], ev: Omit<TraceEvent, 'turn'>): TraceEvent[] => {
  const turn = ev.kind === 'input' && !ev.agentId ? currentTurn(list) + 1 : Math.max(1, currentTurn(list))
  return [...list, { ...ev, turn }].slice(-MAX_EVENTS)
}

export const patch = (list: readonly TraceEvent[], id: string, fields: Partial<TraceEvent>): TraceEvent[] =>
  list.map(ev => (ev.id === id ? { ...ev, ...fields } : ev))

export const matches = (ev: TraceEvent, query: string): boolean => {
  const q = query.trim().toLowerCase()
  return q === '' || `${ev.title} ${ev.detail}`.toLowerCase().includes(q)
}

export const formatMs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`

// Rebuilds an untimed trace from the transcript, for history from before the mod loaded.
export const fromMessages = (messages: readonly SessionMessage[]): TraceEvent[] =>
  messages.reduce<TraceEvent[]>((list, m, i) => {
    if (m.role === 'user') {
      return m.text.trim() ? append(list, { id: `h${i}`, kind: 'input', title: '用户', detail: m.text }) : list
    }
    const withText = m.text.trim()
      ? append(list, { id: `h${i}`, kind: 'model', title: '助手', detail: m.text })
      : list
    return m.toolUses.reduce(
      (acc, use) =>
        append(acc, {
          id: use.tool_use_id,
          kind: 'tool',
          title: `${use.tool} ${toJson(use.input)}`,
          detail: use.text ?? '',
          ...(use.isError ? { isError: true } : {}),
        }),
      withText,
    )
  }, [])

type Bar = { ev: TraceEvent; x: number; w: number }

const timeBars = (timed: readonly TraceEvent[], now: number): Bar[] => {
  const t0 = Math.min(...timed.map(ev => ev.start ?? now))
  const span = Math.max(1, Math.max(...timed.map(ev => ev.end ?? now)) - t0)
  return timed.map(ev => {
    const x = (((ev.start ?? now) - t0) / span) * SVG_WIDTH
    return { ev, x, w: (((ev.end ?? now) - (ev.start ?? now)) / span) * SVG_WIDTH }
  })
}

const turnBars = (timed: readonly TraceEvent[], now: number): Bar[] => {
  const turns = [...new Set(timed.map(ev => ev.turn))]
  const slot = SVG_WIDTH / Math.max(1, turns.length)
  return turns.flatMap((turn, i) =>
    timeBars(
      timed.filter(ev => ev.turn === turn),
      now,
    ).map(bar => ({ ...bar, x: i * slot + (bar.x / SVG_WIDTH) * slot, w: (bar.w / SVG_WIDTH) * slot })),
  )
}

const callBars = (list: readonly TraceEvent[]): Bar[] => {
  const slot = SVG_WIDTH / Math.max(1, list.length)
  return list.map((ev, i) => ({ ev, x: i * slot, w: slot }))
}

export const layout = (list: readonly TraceEvent[], mode: TraceMode, now: number): Bar[] => {
  if (mode === 'call') return callBars(list)
  const timed = list.filter(ev => ev.start !== undefined)
  if (timed.length === 0) return []
  return mode === 'time' ? timeBars(timed, now) : turnBars(timed, now)
}

const escapeXml = (text: string): string =>
  text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c)

export const timelineSvg = (list: readonly TraceEvent[], mode: TraceMode, now: number): string => {
  const bars = layout(list.slice(-TIMELINE_MAX), mode, now)
  const scale = (SVG_WIDTH - LABEL_WIDTH) / SVG_WIDTH
  const labels = LANES.map(
    (kind, row) =>
      `<text x="0" y="${row * LANE_HEIGHT + 13}" font-size="11" fill="#888">${LANE_NAMES[kind]}</text>`,
  ).join('')
  const rect = (row: number, x: number, w: number, fill: string, tip: string, opacity = 0.9): string =>
    `<rect x="${(LABEL_WIDTH + x * scale).toFixed(1)}" y="${row * LANE_HEIGHT + 3}" width="${Math.max(MIN_BAR, w * scale - 1).toFixed(1)}" height="${BAR_HEIGHT}" rx="2" fill="${fill}" opacity="${opacity}"><title>${tip}</title></rect>`
  const rects = bars
    .map(({ ev, x, w }) => {
      const row = LANES.indexOf(ev.kind)
      const total = ev.start !== undefined ? (ev.end ?? now) - ev.start : undefined
      const dur = total !== undefined ? ` · ${formatMs(total)}` : ''
      const tip = escapeXml(`${oneLine(ev.title, 120)}${dur}\n${oneLine(ev.detail, 120)}`)
      const isRunning = ev.end === undefined && ev.start !== undefined
      if (ev.kind !== 'model') {
        return rect(row, x, w, ev.isError ? ERROR_COLOR : COLORS[ev.kind], tip, isRunning ? 0.5 : 0.9)
      }
      // Model bar: light until the first token, dark while streaming; the step's new input on the input lane.
      const wait = ev.firstAt !== undefined && total ? Math.min(1, (ev.firstAt - (ev.start ?? 0)) / total) : 0
      const inputTip = escapeXml(`本步新增输入 ${ev.newCount ?? 0} 条 · ${ev.newChars ?? 0} 字符`)
      return [
        ev.newCount ? rect(LANES.indexOf('input'), x, Math.max(w * INPUT_SHARE, 0), STEP_INPUT_COLOR, inputTip) : '',
        wait > 0 ? rect(row, x, w * wait, WAIT_COLOR, `等待首 token ${formatMs(ev.firstAt! - ev.start!)}`) : '',
        rect(row, x + w * wait, w * (1 - wait), COLORS.model, tip, isRunning ? 0.5 : 0.9),
      ].join('')
    })
    .join('')
  const height = LANES.length * LANE_HEIGHT
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${height}" width="${SVG_WIDTH}" height="${height}">${labels}${rects}</svg>`
}
