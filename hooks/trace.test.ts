import { expect, test } from 'claude-code/testing'

import { append, axis, currentTurn, fromMessages, layout, niceStep, oneLine, tickLabel, timelineSvg, TIMELINE_MAX } from './trace'

test('main-loop inputs advance the turn, tools and subagents stay in it', async () => {
  const a = append([], { id: '1', kind: 'input', title: '用户', detail: 'hi' })
  const b = append(a, { id: '2', kind: 'tool', title: 'Bash {}', detail: '' })
  const c = append(b, { id: '3', kind: 'input', title: '子代理', detail: 'x', agentId: 'ag' })
  const d = append(c, { id: '4', kind: 'input', title: '用户', detail: 'again' })
  expect(d.map(ev => ev.turn)).toEqual([1, 1, 1, 2])
  expect(currentTurn(d)).toBe(2)
})

test('rebuilds history from transcript messages', async () => {
  const list = fromMessages([
    { role: 'user', text: 'run ls', toolUses: [] },
    {
      role: 'assistant',
      text: 'ok',
      toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' }, text: 'a b' }],
    },
  ])
  expect(list.map(ev => [ev.kind, ev.title])).toEqual([
    ['input', '用户'],
    ['model', '助手'],
    ['tool', 'Bash {"command":"ls"}'],
  ])
})

test('time mode places bars by start, call mode by order', async () => {
  const list = [
    { id: 'a', kind: 'model' as const, turn: 1, title: 'm', detail: '', start: 0, end: 50 },
    { id: 'b', kind: 'tool' as const, turn: 1, title: 't', detail: '', start: 50, end: 100 },
  ]
  expect(layout(list, 'time', 100).map(bar => Math.round(bar.x))).toEqual([0, 500])
  expect(layout(list, 'call', 100).map(bar => bar.w)).toEqual([500, 500])
})

test('timeline stays under the Svg source limit with long payloads', async () => {
  const big = Array.from({ length: TIMELINE_MAX * 3 }, (_, i) => ({
    id: String(i),
    kind: 'tool' as const,
    turn: 1,
    title: `Bash <${'x'.repeat(400)}>`,
    detail: 'y'.repeat(2000),
    start: i,
    end: i + 1,
  }))
  const svg = timelineSvg(big, 'time', 1000)
  expect(svg.length < 131072).toBe(true)
  expect(svg.includes('<x')).toBe(false)
})

test('time axis picks round ticks and states the span', async () => {
  expect(niceStep(65_000)).toBe(10_000)
  expect(niceStep(800)).toBe(100)
  expect(tickLabel(90_000)).toBe('1m30s')
  expect(tickLabel(1_500)).toBe('1.5s')
  const list = [
    { id: 'a', kind: 'model' as const, turn: 1, title: 'm', detail: '', start: 0, end: 40_000 },
    { id: 'b', kind: 'tool' as const, turn: 2, title: 't', detail: '', start: 40_000, end: 65_000 },
  ]
  const time = axis(list, 'time', 65_000)
  expect(time.caption).toBe('跨度 1.1m')
  expect(time.ticks.map(t => t.label)).toEqual(['0', '10s', '20s', '30s', '40s', '50s', '1m'])
  expect(axis(list, 'turn', 65_000).ticks.map(t => t.label)).toEqual(['#1 40.0s', '#2 25.0s'])
  expect(axis(list, 'call', 65_000).caption).toBe('2 项 · 跨度 1.1m')
  const svg = timelineSvg(list, 'time', 65_000)
  expect(svg.includes('>30s<')).toBe(true)
  expect(svg.includes('跨度 1.1m')).toBe(true)
})

test('colour codes and control characters never reach rows or the SVG', async () => {
  const raw = '\u001b[31merror\u001b[0m\u0007 done\u0000'
  expect(oneLine(raw)).toBe('error done')
  const svg = timelineSvg([{ id: 'a', kind: 'tool' as const, turn: 1, title: raw, detail: raw, start: 0, end: 1 }], 'time', 1)
  expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg)).toBe(false)
})
