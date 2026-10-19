import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import type { DetailTab, Payload, SystemSnapshot, TraceEvent, TraceMode } from '../types'
import { latestSystem, pretty } from './context'
import {
  CACHE_LOW,
  cacheHit,
  compactNum,
  durationTone,
  highlight,
  isContextJump,
  preview,
  resultSummary,
  toolStats,
  toolSummary,
} from './rows'
import { nodeStatus, statusOf } from './status'
import type { Status } from './status'
import { currentTurn, formatMs, matches, oneLine, TIMELINE_HEIGHT, timelineModel, timelineSvg } from './trace'
import { planJump } from './jump'
import { buildTree, countOf, filterTree, flatten, isOpenBy, spanOf } from './tree'
import type { FlatRow, TreeNode } from './tree'

const PANE = 'agent-trace'
const events = atom({ plugin: 'agent-trace', key: 'events' } as const, [] as TraceEvent[])
const mode = atom({ plugin: 'agent-trace', key: 'mode' } as const, 'call' as TraceMode)
const query = atom({ plugin: 'agent-trace', key: 'query' } as const, '')
const selected = atom({ plugin: 'agent-trace', key: 'selected' } as const, '')
const tab = atom({ plugin: 'agent-trace', key: 'tab' } as const, 'overview' as DetailTab)
const payloads = atom({ plugin: 'agent-trace', key: 'payloads' } as const, {} as Record<string, Payload>)
const systems = atom({ plugin: 'agent-trace', key: 'systems' } as const, [] as SystemSnapshot[])
const openParts = atom({ plugin: 'agent-trace', key: 'openParts' } as const, [] as string[])
const toggled = atom({ plugin: 'agent-trace', key: 'toggled' } as const, [] as string[])
// How many of the newest rows are drawn.
const rowLimit = atom({ plugin: 'agent-trace', key: 'rowLimit' } as const, 40)
const toolFilter = atom({ plugin: 'agent-trace', key: 'toolFilter' } as const, '')
const showStats = atom({ plugin: 'agent-trace', key: 'showStats' } as const, false)

// The pane scrolls natively (Desktop has no sticky header; pinning one by snapping the body back made it shake).
// Desktop silently drops a pane tree past a few hundred kB (178 kB drew, 340 kB did not), so only the newest rows
// are drawn, a page at a time, and never more than fit a size budget beside the timeline and the open detail.
const ROW_PAGE = 40
const ROW_MAX = 160
const TREE_BUDGET = 150_000
// Serialized characters per row (measured about 2.1 kB) and for the header around the rows.
const ROW_COST = 2300
const HEADER_COST = 10_000
// What one block of a closed detail part costs at most: its first lines.
const PART_PREVIEW_COST = 3000
const STATS_MAX = 8
const OPEN_TURNS = 2
const TOGGLED_MAX = 200
const BAR_CELLS = 12
// Cells each tree level indents: the fold column, so a child's fold sits under its parent's dot.
const INDENT = 2
// Deeper levels stop indenting, so nested subagent runs keep room for their text.
const INDENT_LEVELS_MAX = 4
// Below this many body columns the latency bars are left out to give the text room.
const BAR_MIN_COLUMNS = 70
const PREVIEW_LINES = 12
const OPEN_PARTS_MAX = 50
const MAIN_MAX = 56
const REST_MAX = 110
const LABEL_COLUMNS = 10
// CSS pixels per body column on the desktop surface, to draw the timeline near the pane's width
// (the Svg scales down to the slot, never up past its markup width).
const PX_PER_COLUMN = 8.6
const TIMELINE_MIN_WIDTH = 320
const TIMELINE_MIN_COLUMNS = 30
const MATCH_BG = '#f5d76e'
const MATCH_FG = '#1a1a1a'
const SELECTED_BG = 'rgba(128, 128, 128, 0.14)'
const HOVER_BG = 'rgba(128, 128, 128, 0.07)'

type Chip = { label: string; fg: string; bg: string; solid: string }
const CHIPS: Record<'user' | 'sub' | 'model' | 'tool' | 'error', Chip> = {
  user: { label: '用户', fg: '#3d6fd6', bg: 'rgba(91, 141, 239, 0.14)', solid: '#5b8def' },
  sub: { label: '子代理', fg: '#1f8a7e', bg: 'rgba(42, 157, 143, 0.14)', solid: '#2a9d8f' },
  model: { label: '助手', fg: '#7b55b5', bg: 'rgba(142, 108, 192, 0.16)', solid: '#8e6cc0' },
  tool: { label: '工具', fg: '#c2620c', bg: 'rgba(224, 134, 42, 0.16)', solid: '#e0862a' },
  error: { label: '错误', fg: '#c9302c', bg: 'rgba(217, 83, 79, 0.14)', solid: '#d9534f' },
}

const MODES: readonly { value: TraceMode; label: string }[] = [
  { value: 'time', label: '⏱ 时长' },
  { value: 'turn', label: '轮次' },
  { value: 'call', label: '调用' },
]

const STATUS_MARKS: Record<Status, { mark: string; color?: string; label: string }> = {
  ok: { mark: ' ', label: '成功' },
  running: { mark: '◌', color: 'warning', label: '运行中' },
  interrupted: { mark: '⊘', color: 'warning', label: '已中断' },
  denied: { mark: '⊖', color: 'error', label: '被拒绝' },
  error: { mark: '✕', color: 'error', label: '失败' },
}

const percent = (r: number): string => `${Math.round(r * 100)}%`

const toolNameOf = (ev: TraceEvent): string => ev.name ?? ev.title.split(' ')[0] ?? ''

const chipOf = (ev: TraceEvent): Chip => {
  if (ev.isError) return CHIPS.error
  if (ev.kind === 'tool') return CHIPS.tool
  if (ev.kind === 'model') return CHIPS.model
  return ev.agentId ? CHIPS.sub : CHIPS.user
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

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

const clockTime = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

const timeOfDay = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// `step:<loop>:<turnId>:<index>` → the step's place in its turn, from 1.
const stepNumber = (ev: TraceEvent): number => Number(ev.id.split(':').at(-1) ?? 0) + 1

export const registerPane = (on: On): void => {
  // ponytail: the tree of the latest draw, for a timeline click; a reload resets it until the next draw.
  let lastWhole: TreeNode[] = []

  // A click on a timeline bar opens the folds above that row, draws it, selects it and scrolls to it.
  on('ui.message', { component: 'Pane', requestId: PANE, element: 'timeline' }, async ($, e) => {
    const id = (e.data as { jump?: unknown } | null)?.jump
    if (typeof id !== 'string') return {}
    const plan = planJump(lastWhole, await read($, toggled), OPEN_TURNS, id)
    if (!plan) return {}
    await update($, query, () => '')
    await update($, toolFilter, () => '')
    await update($, toggled, () => plan.toggled)
    await update($, rowLimit, v => Math.min(ROW_MAX, Math.max(v ?? ROW_PAGE, plan.total - plan.index)))
    await update($, tab, () => 'overview' as const)
    await update($, selected, () => id)
    await $.ui.scroll({ in: PANE, to: { key: `rowbox-${id}` }, block: 'start' }).catch(() => undefined)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Code, Markdown } = els
    const Input = 'Input' in els ? els.Input : undefined
    const Svg = 'Svg' in els ? els.Svg : undefined
    const Client = 'Client' in els ? els.Client : undefined
    const isRich = e.surface !== 'terminal'
    const [list, current, q, pick, which, opened, store, snaps, flipped, limitRows, onlyTool, isStatsOpen] =
      await Promise.all([
      read($, events),
      read($, mode),
      read($, query),
      read($, selected),
      read($, tab),
      read($, openParts),
      read($, payloads),
      read($, systems),
      read($, toggled),
      read($, rowLimit),
      read($, toolFilter),
      read($, showStats),
    ])
    const now = await $.clock.now()
    const lastTurn = currentTurn(list)
    const stats = toolStats(list)
    const isShown = (ev: TraceEvent) =>
      (!q || matches(ev, q)) && (!onlyTool || (ev.kind === 'tool' && toolNameOf(ev) === onlyTool))
    const isFiltering = q !== '' || onlyTool !== ''
    const matchCount = isFiltering ? list.filter(isShown).length : list.length
    const whole = buildTree(list)
    const top = isFiltering ? filterTree(whole, isShown) : whole
    const isOpen = isFiltering ? () => true : isOpenBy(whole, flipped, OPEN_TURNS)
    // Each model step's previous step in its own loop, for spotting a context jump.
    const prevUsage = new Map<string, TraceEvent['usage']>()
    list
      .filter(ev => ev.kind === 'model')
      .reduce<Map<string, TraceEvent['usage']>>((last, ev) => {
        const loop = ev.agentId ?? ''
        prevUsage.set(ev.id, last.get(loop))
        return ev.usage ? new Map(last).set(loop, ev.usage) : last
      }, new Map())
    const allRows = flatten(top, isOpen, n => flipped.includes(`all:${n.id}`))
    // An estimate of what the open detail adds to the tree: closed parts show their first lines, open ones all.
    const detailCost = (): number => {
      const ev = list.find(x => x.id === pick)
      if (!ev) return 0
      const cost = (key: string, text: string) => (opened.includes(key) ? text.length : Math.min(text.length, PART_PREVIEW_COST))
      const payload = store[ev.id]
      const parts = (payload?.parts ?? []).reduce((n, p, i) => n + cost(`${ev.id}:${i}`, p.text), 0)
      const snap = which === 'system' ? (snaps.find(x => x.id === ev.systemId) ?? snaps.at(-1)) : undefined
      const system = (snap?.sections ?? []).reduce((n, x) => n + cost(`${ev.id}:sec:${x.id}`, x.text), 0)
      const output = cost(`${ev.id}:out`, payload?.output ?? '') + (payload?.thinking?.length ?? 0)
      return 8000 + parts + system + output
    }
    const model = timelineModel(list, current, now, pick, Math.max(TIMELINE_MIN_COLUMNS, e.props.bodyColumns - 2))
    const rowRoom = Math.max(
      ROW_PAGE / 2,
      Math.floor((TREE_BUDGET - HEADER_COST - JSON.stringify(model).length - detailCost()) / ROW_COST),
    )
    const flat = allRows.slice(-Math.min(ROW_MAX, limitRows, rowRoom))
    const startRow = allRows.length - flat.length
    lastWhole = whole

    const scrollToRow = (id: string, block: 'start' | 'nearest') =>
      $.ui.scroll({ in: PANE, to: { key: `rowbox-${id}` }, block }).catch(() => undefined)

    // Opening a row's detail brings the row to the top, so the detail opens in view.
    const toggleRow = async (id: string) => {
      await update($, selected, old => (old === id ? '' : id))
      if ((await read($, selected)) === id) await scrollToRow(id, 'start')
    }

    const toggleFold = async (id: string) => {
      await update($, toggled, old => (old.includes(id) ? old.filter(k => k !== id) : [...old, id].slice(-TOGGLED_MAX)))
      await scrollToRow(id.startsWith('all:') ? id.slice('all:'.length) : id, 'nearest')
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

    const chipView = (chip: Chip) =>
      isRich ? (
        <Text size="footnote" weight="medium" color={chip.fg} backgroundColor={chip.bg}>
          {` ${chip.label} `}
        </Text>
      ) : (
        <Text backgroundColor={chip.solid} color="#ffffff">{` ${chip.label} `}</Text>
      )

    const kv = (label: string, value: string) => (
      <Box key={`kv-${label}`} flexDirection="row" gap={1}>
        <Box width={LABEL_COLUMNS} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="wrap">{value}</Text>
        </Box>
      </Box>
    )

    const heading = (text: string) => <Text weight="semibold">{text}</Text>

    // A long block shows its first lines until opened.
    const partView = (key: string, label: string, text: string, language?: string) => {
      const isOpen = opened.includes(key)
      const { head, total, isCut } = preview(text, PREVIEW_LINES)
      const source = (isOpen || !isCut ? text : `${head}\n…`) || '（空）'
      return (
        <Box key={`part-${key}`} flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor size="footnote">
              {label} · {compactNum(text.length)} 字符 · {total} 行
            </Text>
            {isCut && (
              <Button key={`more-${key}`} plain label={isOpen ? '收起' : '展开全部'} onPress={() => togglePart(key)} />
            )}
          </Box>
          {language ? <Code source={source} language={language} wrap="wrap" /> : <Code source={source} wrap="wrap" />}
        </Box>
      )
    }

    const tabsView = (items: readonly { value: DetailTab; label: string }[], active: DetailTab) => (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {items.map(t => (
          <Button
            key={`tab-${t.value}`}
            label={t.label}
            variant={t.value === active ? 'primary' : 'secondary'}
            onPress={() => update($, tab, () => t.value)}
          />
        ))}
      </Box>
    )

    const timingView = (ev: TraceEvent) => {
      if (ev.start === undefined) return null
      const total = (ev.end ?? now) - ev.start
      const first = ev.firstAt !== undefined ? ev.firstAt - ev.start : undefined
      const gen = ev.end !== undefined && ev.firstAt !== undefined ? ev.end - ev.firstAt : undefined
      const rate = gen && ev.usage ? `${(ev.usage.output / (gen / 1000)).toFixed(1)} tok/s` : undefined
      return (
        <Box flexDirection="column">
          {heading(ev.kind === 'model' ? '请求计时' : '计时')}
          {kv('开始时间', clockTime(ev.start))}
          {kv('总时长', ev.end === undefined ? `${formatMs(total)}（进行中）` : formatMs(total))}
          {first !== undefined && kv('首 token', formatMs(first))}
          {gen !== undefined && kv('生成', formatMs(gen))}
          {rate !== undefined && kv('吞吐量', rate)}
        </Box>
      )
    }

    const partsView = (ev: TraceEvent, payload: Payload | undefined) =>
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

    const rawView = (ev: TraceEvent, payload: Payload | undefined) =>
      partView(`${ev.id}:raw`, '原始记录', pretty({ event: ev, payload }), 'json')

    const modelDetail = (ev: TraceEvent, payload: Payload | undefined) => {
      const active: DetailTab = which === 'raw' || which === 'input' || which === 'system' ? which : 'overview'
      const snap = snaps.find(s => s.id === ev.systemId) ?? latestSystem(snaps, ev.title.split(' ')[0] ?? '')
      const output = payload?.output ?? ev.detail
      const outPreview = preview(output, PREVIEW_LINES)
      const isOutOpen = opened.includes(`${ev.id}:out`)
      const isThinkOpen = opened.includes(`${ev.id}:think`)
      const usage = ev.usage
      const tabs = [
        { value: 'overview' as const, label: '概述' },
        { value: 'input' as const, label: `输入 ${ev.newCount ?? 0}` },
        { value: 'system' as const, label: '系统提示' },
        { value: 'raw' as const, label: '原始' },
      ]
      const overview = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            {kv('来源', `请求 #${stepNumber(ev)} · ${ev.messageCount ?? '?'} 条消息（本步新增 ${ev.newCount ?? 0}）`)}
            {kv('状态', ev.end === undefined ? '生成中…' : '已完成')}
            {kv('模型', ev.title.split(' ')[0] ?? '')}
            {usage &&
              kv(
                'Token',
                `${compactNum(usage.input + usage.cacheRead + usage.cacheWrite)} 输入（缓存读 ${compactNum(usage.cacheRead)} / 写 ${compactNum(usage.cacheWrite)}）→ ${compactNum(usage.output)} 输出`,
              )}
            {usage && cacheHit(usage) !== undefined && kv('缓存命中', percent(cacheHit(usage) ?? 0))}
            {usage && isContextJump(prevUsage.get(ev.id), usage) && kv('提示', '本步未命中缓存的输入比上一步多 3 倍以上')}
          </Box>
          <Box flexDirection="column" gap={1}>
            {heading('预览')}
            {payload?.thinking && (
              <Box flexDirection="column">
                <Button
                  key={`think-${ev.id}`}
                  plain
                  label={`${isThinkOpen ? '▾' : '▸'} 思考 · ${compactNum(payload.thinking.length)} 字符`}
                  onPress={() => togglePart(`${ev.id}:think`)}
                />
                {isThinkOpen && (
                  <Text dimColor italic wrap="wrap">
                    {payload.thinking}
                  </Text>
                )}
              </Box>
            )}
            {output ? (
              <Box flexDirection="column">
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
            )}
          </Box>
          {timingView(ev)}
        </Box>
      )
      const system =
        snap === undefined ? (
          <Text dimColor wrap="wrap">
            没抓到系统提示：引擎只在会话启动时生成一次并缓存，mod 晚于会话启动加载就拿不到。新开一个会话（mod 已加载）即可看到。
          </Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Text dimColor wrap="wrap">
              {snap.model} · {snap.sections.length} 段 · {compactNum(snap.sections.reduce((n, s) => n + s.text.length, 0))}{' '}
              字符 · 工具 {snap.tools.length} 个：{snap.tools.join(', ')}
            </Text>
            {snap.sections.map(s => partView(`${ev.id}:sec:${s.id}`, `${s.id} (${s.scope})`, s.text))}
          </Box>
        )
      return (
        <Box flexDirection="column" gap={1}>
          {tabsView(tabs, active)}
          {active === 'overview' && overview}
          {active === 'input' && partsView(ev, payload)}
          {active === 'system' && system}
          {active === 'raw' && rawView(ev, payload)}
        </Box>
      )
    }

    const toolDetail = (ev: TraceEvent, payload: Payload | undefined) => {
      const active: DetailTab = which === 'raw' ? 'raw' : 'overview'
      const { name } = toolLine(ev)
      const status = STATUS_MARKS[statusOf(ev, lastTurn)].label
      return (
        <Box flexDirection="column" gap={1}>
          {tabsView(
            [
              { value: 'overview', label: '概述' },
              { value: 'raw', label: '原始' },
            ],
            active,
          )}
          {active === 'overview' && (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="column">
                {kv('工具', name)}
                {kv('状态', status)}
              </Box>
              {partsView(ev, payload)}
              {timingView(ev)}
            </Box>
          )}
          {active === 'raw' && rawView(ev, payload)}
        </Box>
      )
    }

    const inputDetail = (ev: TraceEvent, payload: Payload | undefined) => (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {kv('来源', ev.agentId ? `子代理 ${ev.agentId}` : '用户')}
          {ev.start !== undefined && kv('时间', clockTime(ev.start))}
        </Box>
        {partsView(ev, payload)}
      </Box>
    )

    const detailView = (ev: TraceEvent) => {
      const payload = store[ev.id]
      const where = ev.kind === 'model' ? `第 ${ev.turn} 轮 · 第 ${stepNumber(ev)} 步` : `第 ${ev.turn} 轮`
      const close = async () => {
        await update($, selected, () => '')
        await scrollToRow(ev.id, 'nearest')
      }
      return (
        <Box
          key={`detail-${ev.id}`}
          flexDirection="column"
          gap={1}
          marginLeft={2}
          marginBottom={1}
          paddingX={1}
          borderStyle="round"
          borderDimColor
        >
          <Box flexDirection="row" gap={1} alignItems="center">
            {chipView(chipOf(ev))}
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor>{where}</Text>
            </Box>
            <Button key={`close-${ev.id}`} plain role="dismiss" label="✕" onPress={close} />
          </Box>
          {ev.kind === 'model' && modelDetail(ev, payload)}
          {ev.kind === 'tool' && toolDetail(ev, payload)}
          {ev.kind === 'input' && inputDetail(ev, payload)}
          <Button key={`collapse-${ev.id}`} plain label="▴ 收起" onPress={close} />
        </Box>
      )
    }

    // The clickable part of a row: a Button's own text (Desktop draws a Button's children unstyled).
    const rowMain = (ev: TraceEvent): string => {
      if (ev.kind === 'tool') {
        const { name, arg } = toolLine(ev)
        return oneLine(`${name} ${arg}`, MAIN_MAX)
      }
      if (ev.kind === 'model') {
        if (ev.end === undefined) return '生成中…'
        return oneLine(ev.detail, MAIN_MAX) || '（无文本）'
      }
      return oneLine(ev.detail, MAIN_MAX * 2)
    }

    const rowRest = (ev: TraceEvent): string => {
      if (ev.kind === 'tool') {
        if (ev.end === undefined) return '→ 运行中…'
        return `→ ${oneLine(resultSummary(ev.detail), REST_MAX)}`
      }
      if (ev.kind === 'model') {
        return [
          `+${ev.newCount ?? 0} 输入`,
          ev.usage && `${compactNum(ev.usage.input + ev.usage.cacheRead)} in · ${compactNum(ev.usage.output)} out`,
          ev.firstAt !== undefined && ev.start !== undefined && `首 ${formatMs(ev.firstAt - ev.start)}`,
        ]
          .filter(Boolean)
          .join(' · ')
      }
      return ''
    }

    // Coloured flags after a model row's numbers: low cache reuse, and a jump in uncached input.
    const badges = (ev: TraceEvent) => {
      if (ev.kind !== 'model' || !ev.usage) return null
      const hit = cacheHit(ev.usage)
      const isJump = isContextJump(prevUsage.get(ev.id), ev.usage)
      return (
        <Box flexShrink={0} flexDirection="row" gap={1}>
          {hit !== undefined &&
            (hit < CACHE_LOW ? (
              <Text size="footnote" color="warning">{`缓存 ${percent(hit)}`}</Text>
            ) : (
              <Text size="footnote" dimColor>{`缓存 ${percent(hit)}`}</Text>
            ))}
          {isJump && (
            <Text size="footnote" color="error">
              ⚠ 突增
            </Text>
          )}
        </Box>
      )
    }

    const showsBars = isRich && e.props.bodyColumns >= BAR_MIN_COLUMNS

    const barView = (n: TreeNode, root: { start?: number; end?: number }, chip: Chip) => {
      const span = spanOf(n, now)
      if (!showsBars || root.start === undefined || root.end === undefined || span.start === undefined) return null
      const whole = Math.max(1, root.end - root.start)
      const offset = Math.min(BAR_CELLS - 1, Math.floor(((span.start - root.start) / whole) * BAR_CELLS))
      const length = Math.max(
        1,
        Math.min(BAR_CELLS - offset, Math.round((((span.end ?? now) - span.start) / whole) * BAR_CELLS)),
      )
      return (
        <Box width={BAR_CELLS} flexShrink={0}>
          <Text mono size="caption">
            {' '.repeat(offset)}
            <Text backgroundColor={chip.solid}>{' '.repeat(length)}</Text>
            {' '.repeat(BAR_CELLS - offset - length)}
          </Text>
        </Box>
      )
    }

    const nodeChip = (n: TreeNode): Chip => (n.kind === 'agent' ? CHIPS.sub : n.ev ? chipOf(n.ev) : CHIPS.user)

    const nodeMain = (n: TreeNode): string =>
      n.kind === 'agent' ? `子代理 ${String(n.agentId).slice(0, 12)}` : n.ev ? rowMain(n.ev) : ''

    const nodeRest = (n: TreeNode): string => {
      if (n.kind === 'turn' || n.kind === 'agent') {
        const { steps, tools } = countOf(n)
        return `${steps} 步 · ${tools} 工具`
      }
      return n.ev ? rowRest(n.ev) : ''
    }

    const rowView = (row: FlatRow, root: { start?: number; end?: number }) => {
      const n = row.node
      const ev = n.ev
      const isPicked = ev !== undefined && ev.id === pick
      const span = spanOf(n, now)
      const total = span.start !== undefined && span.end !== undefined ? span.end - span.start : undefined
      const tone = total !== undefined ? durationTone(total) : undefined
      const rest = nodeRest(n)
      const chip = nodeChip(n)
      const hasKids = n.children.length > 0
      const look = isRich
        ? { hover: { backgroundColor: HOVER_BG }, ...(isPicked ? { backgroundColor: SELECTED_BG } : {}) }
        : {}
      const onMain = () => (ev && n.kind !== 'agent' ? toggleRow(ev.id) : toggleFold(n.id))
      const mark = STATUS_MARKS[nodeStatus(n, lastTurn)]
      return (
        <Box key={`rowbox-${n.id}`} flexDirection="column" minWidth={0} {...look}>
          <Box flexDirection="row" alignItems="center" minWidth={0} overflow="hidden">
            {row.depth > 0 && <Box width={Math.min(row.depth, INDENT_LEVELS_MAX) * INDENT} flexShrink={0} />}
            <Box width={2} flexShrink={0}>
              {hasKids ? (
                <Button key={`fold-${n.id}`} plain label={row.isOpen ? '▾' : '▸'} onPress={() => toggleFold(n.id)} />
              ) : (
                <Text> </Text>
              )}
            </Box>
            <Box flexDirection="row" gap={1} alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
              {/* The kind is the press target: a Button's own text never truncates, so long text stays a Text. */}
              {/* The dot carries the kind's colour, or the status mark when something is off. */}
              {mark.color ? <Text color={mark.color}>{mark.mark}</Text> : isRich && <Text color={chip.solid}>●</Text>}
              <Box flexShrink={0}>
                <Button key={`row-${n.id}`} plain label={chip.label} onPress={onMain} />
              </Box>
              {/* Sibling Texts, each truncating: Desktop wraps a Text that nests others instead of cutting it. */}
              {n.kind === 'turn' && ev && !ev.agentId && (
                <Box flexShrink={0}>
                  <Text dimColor tabular>{`#${ev.turn}`}</Text>
                </Box>
              )}
              <Box flexShrink={1} minWidth={0} overflow="hidden">
                <Text weight={isPicked ? 'bold' : 'medium'} mono={n.kind === 'tool'} wrap="truncate-end">
                  {q ? marked(nodeMain(n)) : nodeMain(n)}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={3} minWidth={0} overflow="hidden">
                {rest !== '' && (
                  <Text dimColor mono={n.kind === 'tool'} wrap="truncate-end">
                    {q ? marked(rest) : rest}
                  </Text>
                )}
              </Box>
              {ev && badges(ev)}
              {barView(n, root, chip)}
              {span.start !== undefined && (
                <Box flexShrink={0}>
                  <Text size="footnote" tabular dimColor>
                    {timeOfDay(span.start)}
                  </Text>
                </Box>
              )}
              {total !== undefined && (
                <Box width={7} flexShrink={0} justifyContent="flex-end">
                  {tone ? (
                    <Text size="footnote" tabular color={tone}>
                      {formatMs(total)}
                    </Text>
                  ) : (
                    <Text size="footnote" tabular dimColor>
                      {formatMs(total)}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          </Box>
          {isPicked && ev && detailView(ev)}
          {row.hiddenChildren > 0 && (
            <Box paddingLeft={(Math.min(row.depth, INDENT_LEVELS_MAX) + 2) * INDENT}>
              <Button
                key={`all-${n.id}`}
                plain
                label={`… 前面还有 ${row.hiddenChildren} 项，显示全部`}
                onPress={() => toggleFold(`all:${n.id}`)}
              />
            </Box>
          )}
        </Box>
      )
    }

    // Each row's bar is scaled to the span of the turn it belongs to.
    const roots = allRows.reduce<{ start?: number; end?: number }[]>((acc, row, i) => {
      const prev = acc[i - 1] ?? {}
      return [...acc, row.depth === 0 ? spanOf(row.node, now) : prev]
    }, [])

    const lastModel = list.filter(ev => ev.kind === 'model').at(-1)
    const toolbar = (
      <Box key="header" flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        {MODES.map(m => (
          <Button
            key={`mode-${m.value}`}
            label={m.label}
            variant={m.value === current ? 'primary' : 'secondary'}
            onPress={() => update($, mode, () => m.value)}
          />
        ))}
        <Button
          key="stats"
          label="工具统计"
          variant={isStatsOpen ? 'primary' : 'secondary'}
          onPress={() => update($, showStats, v => !v)}
        />
        <Button
          key="system"
          label="系统提示"
          onPress={async () => {
            if (!lastModel) return
            await update($, tab, () => 'system' as const)
            await update($, selected, () => lastModel.id)
            await scrollToRow(lastModel.id, 'start')
          }}
        />
        <Button
          key="top"
          plain
          label="↑ 顶部"
          onPress={() => $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)}
        />
        <Button
          key="end"
          plain
          label="↓ 最新"
          onPress={() => $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)}
        />
        <Button
          key="clear"
          plain
          label="清空"
          onPress={async () => {
            await update($, events, () => [])
            await update($, payloads, () => ({}))
            await update($, selected, () => '')
            await update($, openParts, () => [])
            await update($, toggled, () => [])
            await update($, toolFilter, () => '')
            await update($, rowLimit, () => ROW_PAGE)
          }}
        />
        <Text dimColor size="footnote">
          {isFiltering ? `匹配 ${matchCount} / ${list.length}` : `${list.length} 条 · ${whole.length} 轮`}
          {startRow > 0 ? ` · 显示最近 ${flat.length} / ${allRows.length} 行` : ''}
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

    const statsView = isStatsOpen && (
      <Box flexDirection="column">
        {stats.length === 0 && <Text dimColor>还没有工具调用。</Text>}
        {stats.slice(0, STATS_MAX).map(t => (
          <Box key={`stat-${t.name}`} flexDirection="row" gap={1} alignItems="center">
            <Box flexShrink={0}>
              <Button
                key={`stat-pick-${t.name}`}
                plain
                label={t.name === onlyTool ? `▶ ${t.name}` : t.name}
                onPress={() => update($, toolFilter, v => (v === t.name ? '' : t.name))}
              />
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor size="footnote" wrap="truncate-end">
                {`${t.count} 次 · 总 ${formatMs(t.totalMs)} · 均 ${formatMs(t.avgMs)}`}
                {t.errors > 0 ? <Text color="error">{` · 失败 ${t.errors}`}</Text> : ''}
              </Text>
            </Box>
          </Box>
        ))}
        {stats.length > STATS_MAX && <Text dimColor size="footnote">还有 {stats.length - STATS_MAX} 种工具未列出</Text>}
      </Box>
    )

    const filterChip = onlyTool !== '' && (
      <Button key="tool-filter" plain label={`只看工具：${onlyTool}  ✕`} onPress={() => update($, toolFilter, () => '')} />
    )

    const svgWidth = Math.max(TIMELINE_MIN_WIDTH, Math.round(e.props.bodyColumns * PX_PER_COLUMN))
    const timeline = Client ? (
      <Client
        key="timeline"
        module="./timeline.tsx"
        props={model}
        width="100%"
        flexGrow={1}
      />
    ) : Svg ? (
      <Svg
        source={timelineSvg(list, current, now, svgWidth, pick)}
        alt="轨迹时间轴：输入 / 模型 / 工具"
        height={TIMELINE_HEIGHT}
        isInteractive
      />
    ) : (
      <Text dimColor>（时间轴在 Desktop 中显示）</Text>
    )

    const empty = q ? `没有匹配「${q}」的记录。` : '暂无轨迹。发一条消息后这里会出现输入 / 模型 / 工具调用。'

    return (
      <Box flexDirection="column" gap={1} width="100%" minWidth={0} overflow="hidden">
        {toolbar}
        {statsView}
        {search}
        {filterChip}
        {timeline}
        <Box flexDirection="column" minWidth={0}>
          {flat.length === 0 && <Text dimColor>{empty}</Text>}
          {startRow > 0 &&
            (flat.length < Math.min(ROW_MAX, rowRoom) ? (
              <Button
                key="older"
                plain
                label={`▴ 加载更早的 ${Math.min(ROW_PAGE, startRow, Math.min(ROW_MAX, rowRoom) - flat.length)} 行（上方还有 ${startRow} 行）`}
                onPress={() => update($, rowLimit, v => Math.min(ROW_MAX, (v ?? ROW_PAGE) + ROW_PAGE))}
              />
            ) : (
              <Text dimColor>上方还有 {startRow} 行：折叠几轮或用搜索查看更早的记录。</Text>
            ))}
          {flat.map((row, i) => rowView(row, roots[startRow + i] ?? {}))}
        </Box>
      </Box>
    )
  })
}
