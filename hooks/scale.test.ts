import { expect, mock, test } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'


const PANE = {
  plugin: 'agent-trace',
  component: 'Pane',
  requestId: 'agent-trace',
  props: { title: '轨迹', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('pane draws with a long, mixed session on desktop', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', async e => ({ result: {}, text: `line one ${'x'.repeat(3000)}\n<tag> & "q"\n`.repeat(3) }) as unknown as ToolCallResult)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text' as const, index: 0, text: 'hi', ref: 1 }
    return { turnId: e.turnId, index: e.index, answer: `答复 <b>${'y'.repeat(3000)}</b>`, toolUses: [{ name: 'Bash', input: { command: 'ls' } }], stopReason: 'tool_use' as const, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30000, cache_creation_input_tokens: 5, model: 'm' } }
  })
  for (let i = 0; i < 60; i++) {
    for await (const _c of $.turn.step({ turnId: `t${i}`, index: 0, model: 'claude-opus', messageCount: i })) void _c
    await clock.advance(700)
    await $.tool.call({ tool: 'Bash', tool_use_id: `u${i}`, command: `echo ${'z'.repeat(800)} <a href="x">` })
    await clock.advance(1300)
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(String(svg?.props.source ?? '').length < 131072).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^Bash echo/ })).toBeDefined()
  await ui.unmount()
})
