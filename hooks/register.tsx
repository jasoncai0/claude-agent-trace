// Records the session's trace (inputs, model steps, tool calls, system prompt); the pane draws it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Payload, SystemSnapshot, TraceEvent } from '../types'
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
import { registerPane } from './pane'
import { toolSummary } from './rows'
import { append, formatMs, fromMessages, oneLine, patch, toJson, toolArgs } from './trace'

const COMMAND = 'agent-trace'
const PANE = 'agent-trace'
const events = atom({ plugin: 'agent-trace', key: 'events' } as const, [] as TraceEvent[])
const payloads = atom({ plugin: 'agent-trace', key: 'payloads' } as const, {} as Record<string, Payload>)
const systems = atom({ plugin: 'agent-trace', key: 'systems' } as const, [] as SystemSnapshot[])
const TITLE = '轨迹'
const TITLE_MAX = 400
const DETAIL_MAX = 2000
const FULL_MAX = 20000

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
    const { isPlaced } = await openPane($)
    const list = await read($, events)
    const now = await $.clock.now()
    const lastAt = list.map(ev => ev.end ?? ev.start).filter((t): t is number => t !== undefined).at(-1)
    const age = lastAt !== undefined ? `，最新一条在 ${formatMs(now - lastAt)} 前` : ''
    const placed = isPlaced ? '' : '；但当前没有界面在显示这个面板（Desktop 侧栏可能被收起）'
    return { text: `轨迹面板已打开：${list.length} 条记录${age}${placed}。` }
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
    let thinking = ''
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
        await savePayload($, id, old => ({
          ...(old ?? payload),
          output: clipText(output, FULL_MAX),
          ...(thinking ? { thinking: clipText(thinking, FULL_MAX) } : {}),
        }))
        return res
      }
      if (step.value.kind === 'thinking' && thinking.length < FULL_MAX) thinking += step.value.text
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
    const { name, arg } = toolSummary(e.tool, args)
    const ev = {
      id,
      kind: 'tool' as const,
      title: `${e.tool} ${toJson(args)}`,
      detail: '',
      name,
      summary: arg,
      start,
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    await record($, list => append(list, clip(ev)))
    const argsPart = { role: 'tool', kind: `参数 · ${e.tool}`, text: clipText(pretty(args)) }
    await savePayload($, id, () => ({ parts: [argsPart], omitted: 0 }))
    const ran = await next(e)
    const end = await $.clock.now()
    const detail = ran.deny !== undefined ? `deny: ${ran.deny}` : (ran.text ?? toJson(ran.result))
    const isDenied = ran.deny !== undefined
    const isError = !isDenied && ran.isError === true
    await record($, list =>
      patch(list, id, {
        end,
        detail: detail.slice(0, DETAIL_MAX),
        ...(isError ? { isError } : {}),
        ...(isDenied ? { isDenied } : {}),
      }),
    )
    const resultKind = isDenied ? '结果 · 被拒绝' : isError ? '结果 · 错误' : '结果'
    const resultPart = { role: 'tool', kind: resultKind, text: clipText(detail, FULL_MAX) }
    await savePayload($, id, () => ({ parts: [argsPart, resultPart], omitted: 0 }))
    return ran
  }).catch(($, e, next) => next(e))

  registerPane(on)
}
