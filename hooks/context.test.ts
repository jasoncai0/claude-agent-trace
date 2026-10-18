import { expect, test } from 'claude-code/testing'

import { PAYLOADS_MAX, prevMessageCount, putPayload, putSystem, stepPayload, systemId } from './context'

const msgs = [
  { role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'text', text: 'ls 一下' }] },
  { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
  { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'a b' }], is_error: true }] },
]

test('a step shows only what its request added since the previous one', async () => {
  const { payload, newCount } = stepPayload(msgs, 1)
  expect(newCount).toBe(2)
  expect(payload.parts.map(p => p.kind)).toEqual(['tool_use · Bash', 'tool_result · error'])
  expect(payload.parts[1]?.text).toBe('a b')
})

test('a shrunk conversation (compaction) shows everything', async () => {
  expect(stepPayload(msgs, 10).newCount).toBe(3)
})

test('the previous count comes from the same loop only', async () => {
  const list = [
    { id: 'a', kind: 'model' as const, turn: 1, title: '', detail: '', messageCount: 5 },
    { id: 'b', kind: 'model' as const, turn: 1, title: '', detail: '', messageCount: 2, agentId: 'sub' },
  ]
  expect(prevMessageCount(list, undefined)).toBe(5)
  expect(prevMessageCount(list, 'sub')).toBe(2)
  expect(prevMessageCount(list, 'other')).toBe(0)
})

test('payloads keep only the newest entries', async () => {
  const map = Array.from({ length: PAYLOADS_MAX + 5 }, (_, i) => i).reduce(
    (m, i) => putPayload(m, `k${i}`, { parts: [], omitted: 0 }),
    {} as ReturnType<typeof putPayload>,
  )
  expect(Object.keys(map).length).toBe(PAYLOADS_MAX)
  expect(Object.keys(map).at(-1)).toBe(`k${PAYLOADS_MAX + 4}`)
})

test('an identical system prompt is stored once', async () => {
  const base = { model: 'm', tools: ['Bash'], sections: [{ id: 'intro', scope: 'shared', text: 'hi' }] }
  const snap = { ...base, id: systemId(base), at: 1 }
  expect(putSystem(putSystem([], snap), { ...snap, at: 2 }).length).toBe(1)
})
