import { expect, test } from 'claude-code/testing'

import { append, currentTurn, fromMessages, layout, timelineSvg, TIMELINE_MAX } from './trace'

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
