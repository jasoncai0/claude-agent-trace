import { expect, mock, test } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'

test('pane draws on mobile and vscode', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as unknown as ToolCallResult)
  await $.turn.start({ text: 'hello', turnId: 'M1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'm1', command: 'ls' })
  for (const surface of ['mobile', 'vscode'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-trace',
      surface,
      component: 'Pane',
      requestId: 'agent-trace',
      props: { title: '轨迹', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: 'Bash ls' })).toBeDefined()
    await ui.unmount()
  }
})
