import { expect, mock, test } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'

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
  expect(await ui.find({ type: 'Text', text: /Bash .*ls -la.*file-a file-b/ })).toBeDefined()

  await ui.input({ key: 'search', text: 'no-such-thing', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /Bash/ })).toBeUndefined()

  await ui.press({ key: 'mode-time' })
  await ui.unmount()
})

test('pane draws on the terminal without the Svg timeline', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /暂无轨迹/ })).toBeDefined()
  await ui.unmount()
})
