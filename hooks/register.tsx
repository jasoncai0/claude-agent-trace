import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TraceEvent, TraceMode } from '../types'
import { append, formatMs, fromMessages, matches, oneLine, patch, timelineSvg, toJson, toolArgs } from './trace'

const PANE = 'agent-trace'
const COMMAND = 'agent-trace'
const TITLE = '轨迹'
const TITLE_MAX = 400
const DETAIL_MAX = 2000
const LIST_MAX = 300

const events = atom({ plugin: 'agent-trace', key: 'events' } as const, [] as TraceEvent[])
const mode = atom({ plugin: 'agent-trace', key: 'mode' } as const, 'call' as TraceMode)
const query = atom({ plugin: 'agent-trace', key: 'query' } as const, '')

const MODES: readonly { value: TraceMode; label: string }[] = [
  { value: 'time', label: '时长' },
  { value: 'turn', label: '轮次' },
  { value: 'call', label: '调用' },
]

const TAGS: Record<string, { label: string; color: string }> = {
  input: { label: '输入', color: '#5b8def' },
  model: { label: '助手', color: '#8e6cc0' },
  tool: { label: '工具', color: '#e0862a' },
}

const clip = (ev: Omit<TraceEvent, 'turn'>): Omit<TraceEvent, 'turn'> => ({
  ...ev,
  title: oneLine(ev.title, TITLE_MAX),
  detail: ev.detail.slice(0, DETAIL_MAX),
})

// Recording must never break the agent loop: a failed write is logged and dropped.
const record = async ($: EngineInterface, fn: (list: TraceEvent[]) => TraceEvent[]): Promise<void> => {
  try {
    await update($, events, list => fn(list ?? []))
  } catch (err) {
    $.ui.log(`agent-trace: write failed: ${String(err)}`, { to: 'debug' })
  }
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // /trace is taken by oh-my-claudecode; a refused registration must not skip the backfill.
    await $.command
      .register({ name: 'agent-trace', description: '打开轨迹面板，查看 agent 运行 trace' })
      .catch(err => $.ui.log(`agent-trace: /${COMMAND} not registered: ${String(err)}`))
    const list = await read($, events)
    if (list.length === 0) {
      const history = fromMessages(await $.session.messages())
      await record($, () => history)
    }
    return next(e)
  })

  on('command.run', { command: 'agent-trace' }, async $ => {
    await openPane($)
    return { text: '轨迹面板已打开。' }
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const ev = {
      id: `turn:${e.turnId}`,
      kind: 'input' as const,
      title: e.agentId ? `子代理 ${e.agentId}` : '用户',
      detail: e.text,
      start: now,
      end: now,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    await record($, list => append(list, clip(ev)))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = `step:${e.agentId ?? 'main'}:${e.turnId}:${e.index}`
    const start = await $.clock.now()
    const ev = {
      id,
      kind: 'model' as const,
      title: e.model,
      detail: '',
      start,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    await record($, list => append(list, ev))
    const res = yield* next(e)
    const end = await $.clock.now()
    const tokens = res.usage ? ` · in ${res.usage.input_tokens} / out ${res.usage.output_tokens}` : ''
    await record($, list =>
      patch(list, id, { end, title: `${e.model}${tokens}`, detail: res.answer.slice(0, DETAIL_MAX) }),
    )
    return res
  })

  on('tool.call', async ($, e, next) => {
    const id = `tool:${e.tool_use_id ?? Math.random().toString(36).slice(2)}`
    const start = await $.clock.now()
    const ev = {
      id,
      kind: 'tool' as const,
      title: `${e.tool} ${toJson(toolArgs(e as Record<string, unknown>))}`,
      detail: '',
      start,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    await record($, list => append(list, clip(ev)))
    const ran = await next(e)
    const end = await $.clock.now()
    const detail = ran.deny !== undefined ? `deny: ${ran.deny}` : (ran.text ?? toJson(ran.result))
    const isError = ran.deny !== undefined || ran.isError === true
    await record($, list =>
      patch(list, id, { end, detail: detail.slice(0, DETAIL_MAX), ...(isError ? { isError } : {}) }),
    )
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const Svg = 'Svg' in els ? els.Svg : undefined
    const list = await read($, events)
    const current = await read($, mode)
    const q = await read($, query)
    const now = await $.clock.now()
    const rows = list.filter(ev => matches(ev, q) && !(ev.kind === 'model' && ev.detail.trim() === ''))
    const shown = rows.slice(-LIST_MAX)

    const toolbar = (
      <Box flexDirection="row" gap={1} alignItems="center">
        {MODES.map(m => (
          <Button
            key={`mode-${m.value}`}
            label={m.label}
            variant={m.value === current ? 'primary' : 'secondary'}
            onPress={() => update($, mode, () => m.value)}
          />
        ))}
        <Button key="clear" label="清空" onPress={() => update($, events, () => [])} />
        <Text dimColor>
          {list.length} 条 · {shown.length < rows.length ? `显示最近 ${shown.length}` : `匹配 ${rows.length}`}
        </Text>
      </Box>
    )

    const search = Input && (
      <Input
        key="search"
        placeholder="搜索"
        value={q}
        submitLabel="搜索"
        onInput={value => update($, query, () => value)}
        onSubmit={value => update($, query, () => value)}
      />
    )

    const timeline = Svg ? (
      <Svg source={timelineSvg(list, current, now)} alt="轨迹时间轴：输入 / 模型 / 工具" isInteractive />
    ) : (
      <Text dimColor>（时间轴在 Desktop 中显示）</Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {toolbar}
        {search}
        {timeline}
        <Box flexDirection="column">
          {shown.length === 0 && <Text dimColor>暂无轨迹。发一条消息后这里会出现输入 / 模型 / 工具调用。</Text>}
          {shown.map(ev => {
            const tag = TAGS[ev.kind] ?? { label: ev.kind, color: '#888' }
            const dur = ev.start !== undefined ? formatMs((ev.end ?? now) - ev.start) : ''
            const body =
              ev.kind === 'tool'
                ? `${ev.title} → ${ev.end === undefined ? '运行中…' : oneLine(ev.detail)}`
                : oneLine(ev.detail)
            return (
              <Box key={ev.id} flexDirection="row" gap={1}>
                <Text backgroundColor={ev.isError ? '#d9534f' : tag.color} color="#ffffff">
                  {` ${ev.agentId ? `${tag.label}*` : tag.label} `}
                </Text>
                <Text dimColor>#{ev.turn}</Text>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-end">{body}</Text>
                </Box>
                {current === 'time' && dur !== '' && <Text dimColor>{dur}</Text>}
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
