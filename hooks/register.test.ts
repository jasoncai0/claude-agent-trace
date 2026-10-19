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
  expect(await ui.find({ type: 'Text', text: 'Bash ls -la' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /→ file-a file-b/ })).toBeDefined()
  const row = await ui.find({ type: 'Button', text: /^工具$/ })
  expect(row?.key).toBeDefined()
  const id = (row?.key ?? '').replace(/^row-/, '')

  await ui.press({ key: row?.key ?? '' })
  expect(await ui.find({ key: `detail-${id}` })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /"command": "ls -la"/ })).toBeDefined()
  expect(await ui.find({ type: 'Code', text: /^file-a file-b$/ })).toBeDefined()
  await ui.press({ key: `collapse-${id}` })
  expect(await ui.find({ key: `detail-${id}` })).toBeUndefined()

  await ui.input({ key: 'search', text: 'file-a', kind: 'change' })
  const hit = await ui.find({ type: 'Text', text: /→ file-a file-b/ })
  expect(JSON.stringify(hit?.children)).toContain('"backgroundColor":"#f5d76e"')

  await ui.input({ key: 'search', text: 'no-such-thing', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /Bash/ })).toBeUndefined()
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
  expect(await ui.find({ type: 'Text', text: '好的' })).toBeDefined()
  const row = await ui.find({ type: 'Button', text: '助手' })
  expect(await ui.find({ type: 'Text', text: /\+2 输入/ })).toBeDefined()
  await ui.press({ key: row?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: '首 token' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '已完成' })).toBeDefined()
  await ui.press({ key: 'tab-input' })
  expect(await ui.find({ type: 'Code', text: /CLAUDE\.md 内容/ })).toBeDefined()

  await ui.press({ key: 'tab-system' })
  expect(await ui.find({ type: 'Code', text: 'You are Claude Code.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /工具 1 个：Bash/ })).toBeDefined()
  await ui.unmount()
})

test('the command says how many rows there are', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: false } }) as OpEventResult<'ui.open'>)
  const res = JSON.stringify(await $.command.run({ command: 'agent-trace', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }))
  expect(res).toContain('轨迹面板已打开：0 条记录')
  expect(res).toContain('当前没有界面在显示这个面板')
})

test('a turn folds and unfolds its steps and tool calls', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as unknown as ToolCallResult)
  await $.turn.start({ text: '跑一下 ls', turnId: 'T1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Bash ls' })).toBeDefined()

  await ui.press({ key: 'fold-turn:T1' })
  expect(await ui.find({ type: 'Text', text: 'Bash ls' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '0 步 · 1 工具' })).toBeDefined()

  await ui.press({ key: 'fold-turn:T1' })
  expect(await ui.find({ type: 'Text', text: 'Bash ls' })).toBeDefined()
  await ui.unmount()
})

test('the wheel moves the row window under a fixed header', async ($, on) => {
  mock.clock(on)
  const offsets: number[] = []
  on('ui.scroll', async (_$, e) => {
    offsets.push(e.offset)
    return {}
  })
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as unknown as ToolCallResult)
  for (let i = 0; i < 40; i++) await $.tool.call({ tool: 'Bash', tool_use_id: `w${i}`, command: `echo ${i}` })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /跟随最新/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Bash echo 39' })).toBeDefined()

  const moved = await $.ui.scroll({
    component: 'Pane',
    requestId: 'agent-trace',
    offset: 0,
    by: -5,
    bodyRows: 40,
    // padding (1 above, a screen below) plus exactly a screen of drawn rows
    contentRows: 81,
    origin: { kind: 'person' },
  })
  expect(moved.deny).toBeUndefined()
  expect(offsets).toEqual([1])
  expect(await ui.find({ type: 'Text', text: /跟随最新/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Bash echo 39' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /第 20–35 \/ 40 行/ })).toBeDefined()
  await ui.unmount()
})

test('a refused call is marked denied and tool stats filter the tree', async ($, on) => {
  mock.clock(on)
  on('tool.call', async (_$, e) =>
    (e.tool === 'Bash' ? { deny: 'blocked by policy' } : { result: {}, text: 'ok' }) as unknown as ToolCallResult,
  )
  await $.tool.call({ tool: 'Bash', tool_use_id: 'd1', command: 'rm -rf x' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/a.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '⊖' }))?.props.color).toBe('error')

  await ui.press({ key: 'stats' })
  expect(await ui.find({ type: 'Text', text: /1 次 · 总 .* · 失败 1/ })).toBeDefined()
  await ui.press({ key: 'stat-pick-Read' })
  expect(await ui.find({ type: 'Button', text: /只看工具：Read/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Bash rm -rf x' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Read /a.ts' })).toBeDefined()

  await ui.press({ key: 'tool-filter' })
  expect(await ui.find({ type: 'Text', text: 'Bash rm -rf x' })).toBeDefined()
  await ui.unmount()
})

test('unfolding a turn keeps it in place in the window', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as unknown as ToolCallResult)
  for (const t of ['T1', 'T2', 'T3']) {
    await $.turn.start({ text: `turn ${t}`, turnId: t })
    for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', tool_use_id: `${t}-${i}`, command: `echo ${t}-${i}` })
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'top' })
  expect(await ui.find({ type: 'Text', text: /第 1–/ })).toBeDefined()

  await ui.press({ key: 'fold-turn:T1' })
  expect(await ui.find({ type: 'Text', text: /第 1–/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Bash echo T1-0' })).toBeDefined()
  await ui.unmount()
})

test('a window that left room takes on more rows after a scroll', async ($, on) => {
  mock.clock(on)
  on('ui.scroll', async () => ({}))
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as unknown as ToolCallResult)
  for (let i = 0; i < 60; i++) await $.tool.call({ tool: 'Bash', tool_use_id: `c${i}`, command: `echo ${i}` })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = (await ui.find({ type: 'Text', text: /第 \d+–60 \/ 60 行/ }))?.text ?? ''
  await $.ui.scroll({ component: 'Pane', requestId: 'agent-trace', offset: 0, by: 1, bodyRows: 40, contentRows: 61, origin: { kind: 'person' } })
  const after = (await ui.find({ type: 'Text', text: /第 \d+–60 \/ 60 行/ }))?.text ?? ''
  const first = (t: string) => Number(/第 (\d+)–/.exec(t)?.[1] ?? 0)
  expect(first(after) < first(before)).toBe(true)
  await ui.unmount()
})

test('an open detail holds the row window while the wheel turns', async ($, on) => {
  mock.clock(on)
  // The body's own scroll, which the engine performs beneath the plugin.
  on('ui.scroll', async () => ({}))
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as unknown as ToolCallResult)
  for (let i = 0; i < 40; i++) await $.tool.call({ tool: 'Bash', tool_use_id: `h${i}`, command: `echo ${i}` })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'row-tool:h39' })
  const range = (await ui.find({ type: 'Text', text: /第 \d+–\d+ \/ 40 行/ }))?.text
  const turn = (by: number, contentRows: number) =>
    $.ui.scroll({ component: 'Pane', requestId: 'agent-trace', offset: 0, by, bodyRows: 40, contentRows, origin: { kind: 'person' } })

  expect((await turn(-3, 30)).deny).toContain('detail is open')
  expect((await ui.find({ type: 'Text', text: /第 \d+–\d+ \/ 40 行/ }))?.text).toBe(range)
  expect((await turn(3, 80)).deny).toBeUndefined()
  expect(await ui.find({ key: 'detail-tool:h39' })).toBeDefined()
  await ui.unmount()
})

test('clicking a timeline bar jumps to that row and selects it', async ($, on) => {
  mock.clock(on)
  on('ui.scroll', async () => ({}))
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as unknown as ToolCallResult)
  await $.tool.call({ tool: 'Read', tool_use_id: 'j1', file_path: '/only.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Client' })).toBeDefined()
  // the one tool bar fills the tool lane (row 2); column 10 is past the 5-cell lane labels
  await ui.pointer({ type: 'down', x: 10, y: 2, button: 'left', in: 'timeline' })
  expect(await ui.find({ key: 'detail-tool:j1' })).toBeDefined()
  await ui.unmount()
})

test('turn rows carry their number, every timed row its time of day', async ($, on) => {
  mock.clock(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', async () => ({ result: {}, text: 'ok' }) as unknown as ToolCallResult)
  await $.turn.start({ text: 'first', turnId: 'A' })
  await $.turn.start({ text: 'second', turnId: 'B' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'z1', command: 'ls' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '#2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\d\d:\d\d:\d\d$/ })).toBeDefined()
  await ui.unmount()
})
