import { expect, mock, test } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'

test('the drawn tree stays within the size Desktop accepts, however many rows are loaded', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => ({ result: {}, text: 'x'.repeat(300) + '\nline2' }) as unknown as ToolCallResult)
  for (let t = 0; t < 8; t++) {
    await $.turn.start({ text: `turn ${t} ` + 'y'.repeat(200), turnId: `T${t}` })
    for (let i = 0; i < 25; i++) await $.tool.call({ tool: 'Bash', tool_use_id: `T${t}-${i}`, command: `cd /Users/mac/workspace && ls -la ${'z'.repeat(120)}` })
  }
  const ui = await $.ui.mount({
    plugin: 'agent-trace', surface: 'desktop', component: 'Pane', requestId: 'agent-trace',
    props: { title: '轨迹', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 53 }, view: {} },
  })
  // load every page a person could ask for
  for (let i = 0; i < 6; i++) if (await ui.find({ key: 'older' })) await ui.press({ key: 'older' })
  const root = await ui.find({ type: 'Box' })
  expect(JSON.stringify(root).length < 160_000).toBe(true)
  expect(await ui.find({ type: 'Text', text: /上方还有 \d+ 行：折叠几轮或用搜索/ })).toBeDefined()
})
