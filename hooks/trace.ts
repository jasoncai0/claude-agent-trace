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
const AXIS_HEIGHT = 16
const TICK_TARGET = 8
const TICK_STEPS = [100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5]
// Room kept clear at the axis' right end for the span label.
const SPAN_ROOM = 110
// A tick label closer than this to the previous drawn one keeps its gridline only.
const LABEL_GAP = 70
const SVG_WIDTH = 1000
const LABEL_WIDTH = 44
const LANE_HEIGHT = 18
const BAR_HEIGHT = 12
const MIN_BAR = 2
// Svg source caps at 131072 chars; a model step draws up to three rects, ~850 chars.
export const TIMELINE_MAX = 120

// Terminal colour codes and control characters: noise in a row, and invalid inside the SVG.
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export const clean = (text: string): string => text.replace(ANSI, '').replace(CONTROL, '')

export const oneLine = (text: string, max = SNIPPET): string => {
  const flat = clean(text).replace(/\s+/g, ' ').trim()
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

const rangeOf = (timed: readonly TraceEvent[], now: number): { t0: number; span: number } => {
  const t0 = Math.min(...timed.map(ev => ev.start ?? now))
  return { t0, span: Math.max(1, Math.max(...timed.map(ev => ev.end ?? now)) - t0) }
}

const timeBars = (timed: readonly TraceEvent[], now: number): Bar[] => {
  const { t0, span } = rangeOf(timed, now)
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

// The smallest round step that gives at most TICK_TARGET ticks; whole hours past the table.
export const niceStep = (span: number): number =>
  TICK_STEPS.find(step => step >= span / TICK_TARGET) ?? Math.ceil(span / TICK_TARGET / 36e5) * 36e5

export const tickLabel = (ms: number): string => {
  if (ms === 0) return '0'
  if (ms < 1e3) return `${ms}ms`
  if (ms < 6e4) return `${+(ms / 1e3).toFixed(1)}s`
  if (ms < 36e5) return ms % 6e4 === 0 ? `${ms / 6e4}m` : `${Math.floor(ms / 6e4)}m${Math.round((ms % 6e4) / 1e3)}s`
  return ms % 36e5 === 0 ? `${ms / 36e5}h` : `${Math.floor(ms / 36e5)}h${Math.round((ms % 36e5) / 6e4)}m`
}

type Tick = { x: number; label: string; isStart?: true }

// Ticks (x in 0..SVG_WIDTH) and the span label under the lanes, per mode.
export const axis = (
  list: readonly TraceEvent[],
  mode: TraceMode,
  now: number,
): { ticks: Tick[]; caption: string } => {
  const timed = list.filter(ev => ev.start !== undefined)
  if (timed.length === 0) return { ticks: [], caption: list.length ? `${list.length} 项 · 无耗时数据` : '' }
  const { span } = rangeOf(timed, now)
  const caption = `跨度 ${formatMs(span)}`
  if (mode === 'time') {
    const step = niceStep(span)
    const count = Math.floor(span / step)
    const ticks = Array.from({ length: count + 1 }, (_, k) => ({ x: ((k * step) / span) * SVG_WIDTH, label: tickLabel(k * step) }))
    return { ticks, caption }
  }
  if (mode === 'turn') {
    const turns = [...new Set(timed.map(ev => ev.turn))]
    const slot = SVG_WIDTH / turns.length
    const ticks = turns.map((turn, i) => ({
      x: i * slot,
      label: `#${turn} ${formatMs(rangeOf(timed.filter(ev => ev.turn === turn), now).span)}`,
      isStart: true as const,
    }))
    return { ticks, caption: `${turns.length} 轮 · ${caption}` }
  }
  return { ticks: [], caption: `${list.length} 项 · ${caption}` }
}

const escapeXml = (text: string): string =>
  clean(text).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c)

// Drawn at `width` CSS pixels so labels keep their size in a narrow pane.
export const timelineSvg = (
  list: readonly TraceEvent[],
  mode: TraceMode,
  now: number,
  width = SVG_WIDTH,
  selected = '',
): string => {
  const view = list.slice(-TIMELINE_MAX)
  const bars = layout(view, mode, now)
  const scale = (width - LABEL_WIDTH) / SVG_WIDTH
  const lanesHeight = LANES.length * LANE_HEIGHT
  const labels = LANES.map(
    (kind, row) =>
      `<text x="0" y="${row * LANE_HEIGHT + 13}" font-size="11" fill="#888">${LANE_NAMES[kind]}</text>`,
  ).join('')
  const { ticks, caption } = axis(view, mode, now)
  const axisY = lanesHeight + 12
  const placed = ticks
    .map(t => ({ ...t, px: LABEL_WIDTH + t.x * scale }))
    .filter(t => t.px <= width - SPAN_ROOM)
  const labelled = placed.reduce<number[]>(
    (kept, t) => (kept.length === 0 || t.px - kept[kept.length - 1]! >= LABEL_GAP ? [...kept, t.px] : kept),
    [],
  )
  const grid = placed
    .map(
      (t, i) =>
        `<line x1="${t.px.toFixed(1)}" x2="${t.px.toFixed(1)}" y1="0" y2="${lanesHeight}" stroke="#888" stroke-opacity="0.25"/>` +
        (labelled.includes(t.px)
          ? `<text x="${t.px.toFixed(1)}" y="${axisY}" font-size="10" fill="#888"${i === 0 || t.isStart ? '' : ' text-anchor="middle"'}>${escapeXml(t.label)}</text>`
          : ''),
    )
    .join('')
  const axisRow =
    `<text x="0" y="${axisY}" font-size="11" fill="#888">时间</text>${grid}` +
    `<text x="${width}" y="${axisY}" font-size="10" fill="#888" text-anchor="end">${escapeXml(caption)}</text>`
  const rect = (row: number, x: number, w: number, fill: string, tip: string, opacity = 0.9, isPicked = false): string =>
    `<rect${isPicked ? ' stroke="#3d6fd6" stroke-width="2"' : ''} x="${(LABEL_WIDTH + x * scale).toFixed(1)}" y="${row * LANE_HEIGHT + 3}" width="${Math.max(MIN_BAR, w * scale - 1).toFixed(1)}" height="${BAR_HEIGHT}" rx="2" fill="${fill}" opacity="${opacity}"><title>${tip}</title></rect>`
  const rects = bars
    .map(({ ev, x, w }) => {
      const row = LANES.indexOf(ev.kind)
      const total = ev.start !== undefined ? (ev.end ?? now) - ev.start : undefined
      const dur = total !== undefined ? ` · ${formatMs(total)}` : ''
      const tip = escapeXml(`${oneLine(ev.title, 120)}${dur}\n${oneLine(ev.detail, 120)}`)
      const isRunning = ev.end === undefined && ev.start !== undefined
      if (ev.kind !== 'model') {
        return rect(row, x, w, ev.isError ? ERROR_COLOR : COLORS[ev.kind], tip, isRunning ? 0.5 : 0.9, ev.id === selected)
      }
      // Model bar: light until the first token, dark while streaming; the step's new input on the input lane.
      const wait = ev.firstAt !== undefined && total ? Math.min(1, (ev.firstAt - (ev.start ?? 0)) / total) : 0
      const inputTip = escapeXml(`本步新增输入 ${ev.newCount ?? 0} 条 · ${ev.newChars ?? 0} 字符`)
      return [
        ev.newCount ? rect(LANES.indexOf('input'), x, Math.max(w * INPUT_SHARE, 0), STEP_INPUT_COLOR, inputTip) : '',
        wait > 0 ? rect(row, x, w * wait, WAIT_COLOR, `等待首 token ${formatMs(ev.firstAt! - ev.start!)}`) : '',
        rect(row, x + w * wait, w * (1 - wait), COLORS.model, tip, isRunning ? 0.5 : 0.9, ev.id === selected),
      ].join('')
    })
    .join('')
  const height = lanesHeight + AXIS_HEIGHT
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${labels}${axisRow}${rects}</svg>`
}
