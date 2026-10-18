import { atom, read, update } from 'claude-code'
import type { On, UiScrollBlock } from 'claude-code'

import type { DetailTab, Payload, SystemSnapshot, TraceEvent, TraceMode } from '../types'
import { latestSystem } from './context'
import { compactNum, durationTone, highlight, preview, resultSummary, toolSummary } from './rows'
import { formatMs, matches, oneLine, timelineSvg } from './trace'

const PANE = 'agent-trace'
const events = atom({ plugin: 'agent-trace', key: 'events' } as const, [] as TraceEvent[])
const mode = atom({ plugin: 'agent-trace', key: 'mode' } as const, 'call' as TraceMode)
const query = atom({ plugin: 'agent-trace', key: 'query' } as const, '')
const selected = atom({ plugin: 'agent-trace', key: 'selected' } as const, '')
const tab = atom({ plugin: 'agent-trace', key: 'tab' } as const, 'input' as DetailTab)
const payloads = atom({ plugin: 'agent-trace', key: 'payloads' } as const, {} as Record<string, Payload>)
const systems = atom({ plugin: 'agent-trace', key: 'systems' } as const, [] as SystemSnapshot[])
const openParts = atom({ plugin: 'agent-trace', key: 'openParts' } as const, [] as string[])

const LIST_MAX = 300
const PREVIEW_LINES = 12
const OPEN_PARTS_MAX = 50
const MATCH_BG = '#f5d76e'
const MATCH_FG = '#1a1a1a'
const SELECTED_BG = 'rgba(91, 141, 239, 0.14)'
const HOVER_BG = 'rgba(128, 128, 128, 0.10)'

const MODES: readonly { value: TraceMode; label: string }[] = [
  { value: 'time', label: '时长' },
  { value: 'turn', label: '轮次' },
  { value: 'call', label: '调用' },
]

const chipOf = (ev: TraceEvent): { label: string; color: string } => {
  if (ev.isError) return { label: ev.kind === 'tool' ? '工具' : '错误', color: '#d9534f' }
  if (ev.kind === 'tool') return { label: ev.agentId ? '工具·子' : '工具', color: '#e0862a' }
  if (ev.kind === 'model') return { label: ev.agentId ? '模型·子' : '模型', color: '#8e6cc0' }
  return ev.agentId ? { label: '子代理', color: '#2a9d8f' } : { label: '用户', color: '#5b8def' }
}

// Older rows carry only the title (`Tool {json}`); recover a summary from it.
const toolLine = (ev: TraceEvent): { name: string; arg: string } => {
  if (ev.name !== undefined) return { name: ev.name, arg: ev.summary ?? '' }
  const [tool = '', ...rest] = ev.title.split(' ')
  try {
    return toolSummary(tool, JSON.parse(rest.join(' ')) as Record<string, unknown>)
  } catch {
    return { name: tool, arg: oneLine(rest.join(' '), 90) }
  }
}

const isJsonKind = (kind: string): boolean => kind.startsWith('参数') || kind.startsWith('tool_use')

export const registerPane = (on: On): void => {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Code, Markdown } = els
    const Input = 'Input' in els ? els.Input : undefined
    const Svg = 'Svg' in els ? els.Svg : undefined
    const isRich = e.surface !== 'terminal'
    const [list, current, q, pick, which, opened, store, snaps] = await Promise.all([
      read($, events),
      read($, mode),
      read($, query),
      read($, selected),
      read($, tab),
      read($, openParts),
      read($, payloads),
      read($, systems),
    ])
    const now = await $.clock.now()
    const rows = list.filter(ev => matches(ev, q))
    const shown = rows.slice(-LIST_MAX)

    const scrollTo = (key: string, block: UiScrollBlock) =>
      $.ui.scroll({ in: PANE, to: { key }, block }).catch(() => undefined)

    const toggleRow = async (id: string) => {
      await update($, selected, old => (old === id ? '' : id))
      if ((await read($, selected)) === id) await scrollTo(`row-${id}`, 'start')
    }

    const togglePart = (key: string) =>
      update($, openParts, old =>
        old.includes(key) ? old.filter(k => k !== key) : [...old, key].slice(-OPEN_PARTS_MAX),
      )

    const marked = (text: string) =>
      highlight(text, q).map(run =>
        run.isMatch ? (
          <Text backgroundColor={MATCH_BG} color={MATCH_FG}>
            {run.text}
          </Text>
        ) : (
          run.text
        ),
      )

    // A long block shows its first lines until opened.
    const partView = (key: string, label: string, text: string, language?: string) => {
      const isOpen = opened.includes(key)
      const { head, total, isCut } = preview(text, PREVIEW_LINES)
      const source = (isOpen || !isCut ? text : `${head}\n…`) || '（空）'
      return (
        <Box key={`part-${key}`} flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>
              {label} · {compactNum(text.length)} 字符 · {total} 行
            </Text>
            {isCut && (
              <Button
                key={`more-${key}`}
                plain
                label={isOpen ? '收起' : '展开全部'}
                onPress={() => togglePart(key)}
              />
            )}
          </Box>
          {language ? <Code source={source} language={language} wrap="wrap" /> : <Code source={source} wrap="wrap" />}
        </Box>
      )
    }

    const detailView = (ev: TraceEvent) => {
      const payload = store[ev.id]
      const parts =
        payload && payload.parts.length > 0 ? (
          <Box flexDirection="column" gap={1}>
            {payload.omitted > 0 && <Text dimColor>前面还有 {payload.omitted} 块未保留</Text>}
            {payload.parts.map((p, i) =>
              partView(`${ev.id}:${i}`, `${p.role} · ${p.kind}`, p.text, isJsonKind(p.kind) ? 'json' : undefined),
            )}
          </Box>
        ) : (
          <Text dimColor>无完整内容（mod 加载前的历史，或已超出保留的最近 150 条）。</Text>
        )
      const collapse = (
        <Button
          key={`collapse-${ev.id}`}
          plain
          label="▴ 收起"
          onPress={async () => {
            await update($, selected, () => '')
            await scrollTo(`row-${ev.id}`, 'nearest')
          }}
        />
      )
      const frame = { marginLeft: 3, paddingX: 1, borderStyle: 'round', borderDimColor: true } as const
      if (ev.kind !== 'model') {
        return (
          <Box key={`detail-${ev.id}`} flexDirection="column" gap={1} {...frame}>
            {parts}
            {collapse}
          </Box>
        )
      }
      const snap = snaps.find(s => s.id === ev.systemId) ?? latestSystem(snaps, ev.title.split(' ')[0] ?? '')
      const tabs: readonly { value: DetailTab; label: string }[] = [
        { value: 'input', label: `本步输入 ${ev.newCount ?? 0}` },
        { value: 'system', label: '系统提示' },
        { value: 'output', label: '输出' },
      ]
      const stats = [
        `请求 ${ev.messageCount ?? '?'} 条消息`,
        `新增 ${ev.newCount ?? 0} 条 / ${compactNum(ev.newChars ?? 0)} 字符`,
        ev.usage &&
          `in ${compactNum(ev.usage.input)} · 缓存读 ${compactNum(ev.usage.cacheRead)} · 缓存写 ${compactNum(ev.usage.cacheWrite)} · out ${compactNum(ev.usage.output)}`,
        ev.firstAt !== undefined && ev.start !== undefined && `首 token ${formatMs(ev.firstAt - ev.start)}`,
      ].filter(Boolean)
      const output = payload?.output ?? ev.detail
      const outPreview = preview(output, PREVIEW_LINES * 2)
      const isOutOpen = opened.includes(`${ev.id}:out`)
      return (
        <Box key={`detail-${ev.id}`} flexDirection="column" gap={1} {...frame}>
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            {tabs.map(t => (
              <Button
                key={`tab-${t.value}`}
                label={t.label}
                variant={t.value === which ? 'primary' : 'secondary'}
                onPress={() => update($, tab, () => t.value)}
              />
            ))}
          </Box>
          <Text dimColor wrap="wrap">
            {stats.join(' · ')}
          </Text>
          {which === 'input' && parts}
          {which === 'system' &&
            (snap === undefined ? (
              <Text dimColor>还没捕获到系统提示：引擎下一次渲染系统提示时记录（通常是下一条消息）。</Text>
            ) : (
              <Box flexDirection="column" gap={1}>
                <Text dimColor wrap="wrap">
                  {snap.model} · {snap.sections.length} 段 ·{' '}
                  {compactNum(snap.sections.reduce((n, s) => n + s.text.length, 0))} 字符 · 工具 {snap.tools.length} 个：
                  {snap.tools.join(', ')}
                </Text>
                {snap.sections.map(s => partView(`${ev.id}:sec:${s.id}`, `${s.id} (${s.scope})`, s.text))}
              </Box>
            ))}
          {which === 'output' &&
            (output ? (
              <Box flexDirection="column" gap={1}>
                <Markdown text={isOutOpen || !outPreview.isCut ? output : `${outPreview.head}\n\n…`} />
                {outPreview.isCut && (
                  <Button
                    key={`more-${ev.id}:out`}
                    plain
                    label={isOutOpen ? '收起' : `展开全部 · ${outPreview.total} 行`}
                    onPress={() => togglePart(`${ev.id}:out`)}
                  />
                )}
              </Box>
            ) : (
              <Text dimColor>（无输出）</Text>
            ))}
          {collapse}
        </Box>
      )
    }

    const rowBody = (ev: TraceEvent) => {
      const isRunning = ev.start !== undefined && ev.end === undefined
      if (ev.kind === 'tool') {
        const { name, arg } = toolLine(ev)
        return [
          <Text weight="semibold">{marked(name)}</Text>,
          ' ',
          ...marked(arg),
          <Text dimColor> → </Text>,
          isRunning ? (
            <Text color="warning">运行中…</Text>
          ) : ev.isError ? (
            <Text color="error">{marked(resultSummary(ev.detail))}</Text>
          ) : (
            <Text dimColor>{marked(resultSummary(ev.detail))}</Text>
          ),
        ]
      }
      if (ev.kind === 'model') {
        const stats = [
          `+${ev.newCount ?? 0} 输入`,
          ev.usage && `in ${compactNum(ev.usage.input)} · 缓存 ${compactNum(ev.usage.cacheRead)} · out ${compactNum(ev.usage.output)}`,
          ev.firstAt !== undefined && ev.start !== undefined && `首 ${formatMs(ev.firstAt - ev.start)}`,
        ].filter(Boolean)
        const said = oneLine(ev.detail, 120)
        return [
          isRunning ? (
            <Text color="warning">生成中…</Text>
          ) : said.startsWith('→') ? (
            <Text dimColor>{marked(said)}</Text>
          ) : said ? (
            marked(said)
          ) : (
            <Text dimColor>（无文本）</Text>
          ),
          <Text dimColor>{`  ${stats.join(' · ')}`}</Text>,
        ]
      }
      return [<Text weight="semibold">{marked(oneLine(ev.detail, 140))}</Text>]
    }

    const rowView = (ev: TraceEvent) => {
      const isPicked = ev.id === pick
      const chip = chipOf(ev)
      const total = ev.start !== undefined ? (ev.end ?? now) - ev.start : undefined
      const tone = total !== undefined ? durationTone(total) : undefined
      const look = isRich
        ? { hover: { backgroundColor: HOVER_BG }, ...(isPicked ? { backgroundColor: SELECTED_BG } : {}) }
        : {}
      return (
        <Box key={`rowbox-${ev.id}`} flexDirection="column" {...look}>
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Button key={`row-${ev.id}`} plain onPress={() => toggleRow(ev.id)}>
                <Text dimColor>{isPicked ? '▾ ' : '▸ '}</Text>
                <Text backgroundColor={chip.color} color="#ffffff">{` ${chip.label} `}</Text>
                <Text dimColor>{` #${ev.turn}  `}</Text>
                {rowBody(ev)}
              </Button>
            </Box>
            {total !== undefined &&
              (tone ? <Text color={tone}>{formatMs(total)}</Text> : <Text dimColor>{formatMs(total)}</Text>)}
          </Box>
          {isPicked && detailView(ev)}
        </Box>
      )
    }

    const lastModel = list.filter(ev => ev.kind === 'model').at(-1)
    const toolbar = (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
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
            if (!lastModel) return
            await update($, tab, () => 'system' as const)
            await update($, selected, () => lastModel.id)
            await scrollTo(`row-${lastModel.id}`, 'start')
          }}
        />
        <Button key="top" label="↑ 顶部" onPress={() => $.ui.scroll({ in: PANE, to: 'start' })} />
        <Button key="end" label="↓ 最新" onPress={() => $.ui.scroll({ in: PANE, to: 'end' })} />
        <Button
          key="clear"
          label="清空"
          onPress={async () => {
            await update($, events, () => [])
            await update($, payloads, () => ({}))
            await update($, selected, () => '')
            await update($, openParts, () => [])
          }}
        />
        <Text dimColor>
          {q ? `匹配 ${rows.length} / ${list.length}` : `${list.length} 条`}
          {shown.length < rows.length ? ` · 显示最近 ${shown.length}` : ''}
        </Text>
      </Box>
    )

    const search = Input && (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Box flexGrow={1} flexShrink={1}>
          <Input
            key="search"
            placeholder="搜索工具、参数、输出、回复…"
            value={q}
            submitLabel="搜索"
            onInput={value => update($, query, () => value)}
            onSubmit={value => update($, query, () => value)}
          />
        </Box>
        {q !== '' && <Button key="clear-search" plain label="✕ 清除" onPress={() => update($, query, () => '')} />}
      </Box>
    )

    const timeline = Svg ? (
      <Svg source={timelineSvg(list, current, now)} alt="轨迹时间轴：输入 / 模型 / 工具" isInteractive />
    ) : (
      <Text dimColor>（时间轴在 Desktop 中显示）</Text>
    )

    const empty = q ? `没有匹配「${q}」的记录。` : '暂无轨迹。发一条消息后这里会出现输入 / 模型 / 工具调用。'

    return (
      <Box flexDirection="column" gap={1}>
        {toolbar}
        {search}
        {timeline}
        <Box flexDirection="column">
          {shown.length === 0 && <Text dimColor>{empty}</Text>}
          {shown.map(rowView)}
        </Box>
      </Box>
    )
  })
}
