import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DetailTab, Payload, SystemSnapshot, TraceEvent, TraceMode } from '../types'
import {
  clipText,
  latestSystem,
  pretty,
  prevMessageCount,
  putPayload,
  putSystem,
  stepPayload,
  systemId,
} from './context'
import { append, formatMs, fromMessages, matches, oneLine, patch, timelineSvg, toJson, toolArgs } from './trace'

const PANE = 'agent-trace'
const COMMAND = 'agent-trace'
const TITLE = '轨迹'
const TITLE_MAX = 400
const DETAIL_MAX = 2000
const FULL_MAX = 20000
const LIST_MAX = 300

const events = atom({ plugin: 'agent-trace', key: 'events' } as const, [] as TraceEvent[])
const mode = atom({ plugin: 'agent-trace', key: 'mode' } as const, 'call' as TraceMode)
const query = atom({ plugin: 'agent-trace', key: 'query' } as const, '')
const selected = atom({ plugin: 'agent-trace', key: 'selected' } as const, '')
const tab = atom({ plugin: 'agent-trace', key: 'tab' } as const, 'input' as DetailTab)
const payloads = atom({ plugin: 'agent-trace', key: 'payloads' } as const, {} as Record<string, Payload>)
const systems = atom({ plugin: 'agent-trace', key: 'systems' } as const, [] as SystemSnapshot[])

const MODES: readonly { value: TraceMode; label: string }[] = [
  { value: 'time', label: '时长' },
  { value: 'turn', label: '轮次' },
  { value: 'call', label: '调用' },
]

const TAGS: Record<string, { label: string; color: string }> = {
  input: { label: '输入', color: '#5b8def' },
  model: { label: '模型', color: '#8e6cc0' },
  tool: { label: '工具', color: '#e0862a' },
}

const clip = (ev: Omit<TraceEvent, 'turn'>): Omit<TraceEvent, 'turn'> => ({
  ...ev,
  title: oneLine(ev.title, TITLE_MAX),
  detail: ev.detail.slice(0, DETAIL_MAX),
})

// Recording must never break the agent loop: a failed write is logged and dropped.
const safely = async ($: EngineInterface, label: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn()
  } catch (err) {
    $.ui.log(`agent-trace: ${label} failed: ${String(err)}`, { to: 'debug' })
  }
}

const record = ($: EngineInterface, fn: (list: TraceEvent[]) => TraceEvent[]) =>
  safely($, 'write', () => update($, events, list => fn(list ?? [])))

const savePayload = ($: EngineInterface, id: string, fn: (old: Payload | undefined) => Payload) =>
  safely($, 'payload', () => update($, payloads, map => putPayload(map ?? {}, id, fn(map?.[id]))))

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: TITLE })

const usageText = (ev: TraceEvent): string =>
  ev.usage
    ? `in ${ev.usage.input} · 缓存读 ${ev.usage.cacheRead} · 缓存写 ${ev.usage.cacheWrite} · out ${ev.usage.output}`
    : ''

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

  // The system prompt as sent: every section and the tool list, deduplicated by content.
  on('prompt.compose', async ($, e, next) => {
    const res = await next(e)
    const base = {
      model: e.model,
      tools: [...e.tools],
      sections: res.sections.map(s => ({ id: s.id, scope: s.scope, text: s.text })),
    }
    const at = await $.clock.now()
    await safely($, 'system', () =>
      update($, systems, list => putSystem(list ?? [], { ...base, id: systemId(base), at })),
    )
    return res
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const id = `turn:${e.turnId}`
    const ev = {
      id,
      kind: 'input' as const,
      title: e.agentId ? `子代理 ${e.agentId}` : '用户',
      detail: e.text,
      start: now,
      end: now,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    await record($, list => append(list, clip(ev)))
    await savePayload($, id, () => ({
      parts: [{ role: 'user', kind: 'prompt', text: clipText(e.text, FULL_MAX) }],
      omitted: 0,
    }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = `step:${e.agentId ?? 'main'}:${e.turnId}:${e.index}`
    const scope = e.agentId ? { agentId: e.agentId } : {}
    const start = await $.clock.now()
    const fetched = await $.session.messages({ as: 'api', ...scope }).catch(err => ({ deny: String(err) }))
    const messages = Array.isArray(fetched) ? fetched : []
    const prev = prevMessageCount(await read($, events), e.agentId)
    const { payload, newCount, newChars } = stepPayload(messages, prev)
    const ev = {
      id,
      kind: 'model' as const,
      title: e.model,
      detail: '',
      start,
      messageCount: messages.length,
      newCount,
      newChars,
      ...scope,
    }
    await record($, list => append(list, ev))
    await savePayload($, id, () => payload)

    // Read the stream by hand to time the first content chunk; every chunk passes on unchanged.
    const stream = next(e)
    let firstAt: number | undefined
    for (;;) {
      const step = await stream.next()
      if (step.done) {
        const res = step.value
        const end = await $.clock.now()
        const usage = res.usage
          ? {
              input: res.usage.input_tokens,
              output: res.usage.output_tokens,
              cacheRead: res.usage.cache_read_input_tokens,
              cacheWrite: res.usage.cache_creation_input_tokens,
            }
          : undefined
        const calls = res.toolUses.map(use => use.name).join(', ')
        const system = latestSystem(await read($, systems), e.model)
        await record($, list =>
          patch(list, id, {
            end,
            ...(firstAt !== undefined ? { firstAt } : {}),
            ...(usage ? { usage } : {}),
            ...(system ? { systemId: system.id } : {}),
            detail: (res.answer || (calls ? `→ ${calls}` : '')).slice(0, DETAIL_MAX),
          }),
        )
        const output = [res.answer, ...res.toolUses.map(use => `→ ${use.name} ${pretty(use.input)}`)]
          .filter(Boolean)
          .join('\n\n')
        await savePayload($, id, old => ({ ...(old ?? payload), output: clipText(output, FULL_MAX) }))
        return res
      }
      if (firstAt === undefined && ['text', 'thinking', 'tool'].includes(step.value.kind)) {
        firstAt = await $.clock.now()
      }
      yield step.value
    }
  })

  on('tool.call', async ($, e, next) => {
    const id = `tool:${e.tool_use_id ?? Math.random().toString(36).slice(2)}`
    const args = toolArgs(e as Record<string, unknown>)
    const start = await $.clock.now()
    const ev = {
      id,
      kind: 'tool' as const,
      title: `${e.tool} ${toJson(args)}`,
      detail: '',
      start,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    await record($, list => append(list, clip(ev)))
    const argsPart = { role: 'tool', kind: `参数 · ${e.tool}`, text: clipText(pretty(args)) }
    await savePayload($, id, () => ({ parts: [argsPart], omitted: 0 }))
    const ran = await next(e)
    const end = await $.clock.now()
    const detail = ran.deny !== undefined ? `deny: ${ran.deny}` : (ran.text ?? toJson(ran.result))
    const isError = ran.deny !== undefined || ran.isError === true
    await record($, list =>
      patch(list, id, { end, detail: detail.slice(0, DETAIL_MAX), ...(isError ? { isError } : {}) }),
    )
    const resultPart = { role: 'tool', kind: isError ? '结果 · 错误' : '结果', text: clipText(detail, FULL_MAX) }
    await savePayload($, id, () => ({ parts: [argsPart, resultPart], omitted: 0 }))
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Code, Markdown } = els
    const Input = 'Input' in els ? els.Input : undefined
    const Svg = 'Svg' in els ? els.Svg : undefined
    const list = await read($, events)
    const current = await read($, mode)
    const q = await read($, query)
    const pick = await read($, selected)
    const now = await $.clock.now()
    const rows = list.filter(ev => matches(ev, q))
    const shown = rows.slice(-LIST_MAX)
    const chosen = pick ? list.find(ev => ev.id === pick) : undefined

    const parts = (payload: Payload | undefined) =>
      payload === undefined || payload.parts.length === 0 ? (
        <Text dimColor>无完整内容（mod 加载前的历史，或已超出保留的最近 150 条）。</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {payload.omitted > 0 && <Text dimColor>前面还有 {payload.omitted} 块未保留</Text>}
          {payload.parts.map((p, i) => (
            <Box key={`part-${i}`} flexDirection="column">
              <Text dimColor>
                {p.role} · {p.kind} · {p.text.length} 字符
              </Text>
              <Code source={p.text || '（空）'} wrap="wrap" />
            </Box>
          ))}
        </Box>
      )

    const systemView = (snap: SystemSnapshot | undefined) =>
      snap === undefined ? (
        <Text dimColor>还没捕获到系统提示：引擎下一次渲染系统提示时记录（通常是下一条消息）。</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>
            {snap.model} · {snap.sections.length} 段 · {snap.sections.reduce((n, s) => n + s.text.length, 0)} 字符 ·
            工具 {snap.tools.length} 个
          </Text>
          <Text wrap="wrap">工具：{snap.tools.join(', ')}</Text>
          {snap.sections.map(s => (
            <Box key={`sec-${s.id}`} flexDirection="column">
              <Text weight="semibold">
                {s.id} <Text dimColor>({s.scope}, {s.text.length} 字符)</Text>
              </Text>
              <Code source={s.text || '（空）'} wrap="wrap" />
            </Box>
          ))}
        </Box>
      )

    const detail = async (ev: TraceEvent) => {
      const payload = (await read($, payloads))[ev.id]
      const dur = ev.start !== undefined ? formatMs((ev.end ?? now) - ev.start) : ''
      const close = <Button key="detail-close" label="关闭" role="dismiss" onPress={() => update($, selected, () => '')} />
      if (ev.kind !== 'model') {
        return (
          <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text weight="semibold">
                {TAGS[ev.kind]?.label} #{ev.turn} {dur}
              </Text>
              {close}
            </Box>
            {parts(payload)}
          </Box>
        )
      }
      const which = await read($, tab)
      const snaps = await read($, systems)
      const snap = snaps.find(s => s.id === ev.systemId) ?? latestSystem(snaps, ev.title.split(' ')[0] ?? '')
      const first = ev.firstAt !== undefined && ev.start !== undefined ? ` · 首 token ${formatMs(ev.firstAt - ev.start)}` : ''
      const tabs: readonly { value: DetailTab; label: string }[] = [
        { value: 'input', label: `本步输入 ${ev.newCount ?? 0}` },
        { value: 'system', label: '系统提示' },
        { value: 'output', label: '输出' },
      ]
      return (
        <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text weight="semibold">
              模型 #{ev.turn} {dur}
              {first}
            </Text>
            {tabs.map(t => (
              <Button
                key={`tab-${t.value}`}
                label={t.label}
                variant={t.value === which ? 'primary' : 'secondary'}
                onPress={() => update($, tab, () => t.value)}
              />
            ))}
            {close}
          </Box>
          <Text dimColor wrap="wrap">
            请求共 {ev.messageCount ?? '?'} 条消息，本步新增 {ev.newCount ?? 0} 条 / {ev.newChars ?? 0} 字符
            {ev.usage ? ` · ${usageText(ev)}` : ''}
          </Text>
          {which === 'input' && parts(payload)}
          {which === 'system' && systemView(snap)}
          {which === 'output' &&
            (payload?.output ? <Markdown text={payload.output} /> : <Text dimColor>{ev.detail || '（无）'}</Text>)}
        </Box>
      )
    }

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
        <Button
          key="system"
          label="系统提示"
          onPress={async () => {
            await update($, tab, () => 'system' as const)
            await update($, selected, () => list.filter(ev => ev.kind === 'model').at(-1)?.id ?? '')
          }}
        />
        <Button
          key="clear"
          label="清空"
          onPress={async () => {
            await update($, events, () => [])
            await update($, payloads, () => ({}))
            await update($, selected, () => '')
          }}
        />
        <Text dimColor>
          {list.length} 条 · {shown.length < rows.length ? `显示最近 ${shown.length}` : `匹配 ${rows.length}`} · 点一行看完整内容
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
        {chosen && (await detail(chosen))}
        <Box flexDirection="column">
          {shown.length === 0 && <Text dimColor>暂无轨迹。发一条消息后这里会出现输入 / 模型 / 工具调用。</Text>}
          {shown.map(ev => {
            const tag = TAGS[ev.kind] ?? { label: ev.kind, color: '#888' }
            const dur = ev.start !== undefined ? ` ${formatMs((ev.end ?? now) - ev.start)}` : ''
            const body =
              ev.kind === 'tool'
                ? `${oneLine(ev.title)} → ${ev.end === undefined ? '运行中…' : oneLine(ev.detail)}`
                : ev.kind === 'model'
                  ? `${ev.end === undefined ? '生成中…' : oneLine(ev.detail) || '（无文本）'}  ·  +${ev.newCount ?? 0} 条输入${ev.usage ? ` · in ${ev.usage.input}+${ev.usage.cacheRead} 缓存 / out ${ev.usage.output}` : ''}`
                  : oneLine(ev.detail)
            return (
              <Button
                key={`row-${ev.id}`}
                plain
                onPress={() => update($, selected, old => (old === ev.id ? '' : ev.id))}
              >
                {ev.id === pick ? '▶ ' : ''}
                <Text backgroundColor={ev.isError ? '#d9534f' : tag.color} color="#ffffff">
                  {` ${ev.agentId ? `${tag.label}*` : tag.label} `}
                </Text>
                <Text dimColor> #{ev.turn} </Text>
                {body}
                {current === 'time' && <Text dimColor>{dur}</Text>}
              </Button>
            )
          })}
        </Box>
      </Box>
    )
  })
}
