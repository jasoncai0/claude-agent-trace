import { expect, mock, test } from 'claude-code/testing'
import type { OpEventResult, ToolCallResult } from 'claude-code'

const PANE = {
  plugin: 'agent-trace',
  component: 'Pane',
  requestId: 'agent-trace',
  props: {
    title: '轨迹',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('records a tool call and draws it in the pane on desktop', async ($, on) => {
  mock.clock(on)
  on('tool.call', async () => ({ result: {}, text: 'file-a file-b' }) as unknown as ToolCallResult)
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = await ui.find({ type: 'Button', text: /工具.*Bash ls -la → file-a file-b/ })
  expect(row?.key).toBeDefined()
  const id = (row?.key ?? '').replace(/^row-/, '')

  await ui.press({ key: row?.key ?? '' })
  expect(await ui.find({ key: `detail-${id}` })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /"command": "ls -la"/ })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /^file-a file-b$/ })).toBeDefined()
  await ui.press({ key: `collapse-${id}` })
  expect(await ui.find({ key: `detail-${id}` })).toBeUndefined()

  await ui.input({ key: 'search', text: 'ls -l', kind: 'change' })
  const hit = await ui.find({ type: 'Text', text: 'ls -l' })
  expect(hit?.props.backgroundColor).toBe('#f5d76e')

  await ui.input({ key: 'search', text: 'no-such-thing', kind: 'change' })
  expect(await ui.find({ type: 'Button', text: /Bash/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /没有匹配/ })).toBeDefined()
  await ui.press({ key: 'mode-time' })
  await ui.unmount()
})

test('pane draws on the terminal without the Svg timeline', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /暂无轨迹/ })).toBeDefined()
  await ui.unmount()
})

test('a model step shows its system prompt, new input and output', async ($, on) => {
  const clock = mock.clock(on)
  on('prompt.compose', async () => ({
    sections: [{ id: 'intro', scope: 'shared' as const, text: 'You are Claude Code.' }],
  }))
  const api = [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>CLAUDE.md 内容</system-reminder>' }] },
    { role: 'user', content: [{ type: 'text', text: 'ls 一下' }] },
  ]
  on('session.messages', async () => ({ value: api }) as OpEventResult<'session.messages'>)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text' as const, index: 0, text: '好的', ref: 1 }
    return { turnId: e.turnId, index: e.index, answer: '好的', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: ['Bash'], outputStyle: null, traits: [] })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 2 })
  for await (const _chunk of stream) await clock.advance(5)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = await ui.find({ type: 'Button', text: /模型.*好的.*\+2 输入/ })
  await ui.press({ key: row?.key ?? '' })
  expect(await ui.find({ type: 'Code', text: /CLAUDE\.md 内容/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /首 token/ })).toBeDefined()

  await ui.press({ key: 'tab-system' })
  expect(await ui.find({ type: 'Code', text: 'You are Claude Code.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /工具 1 个：Bash/ })).toBeDefined()
  await ui.unmount()
})
