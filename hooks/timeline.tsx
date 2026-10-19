import type { ClientModule } from 'claude-code'

// Self-contained: a surface module runs on the drawing side, apart from the hooks module.
type Bar = { id: string; lane: number; x0: number; x1: number; color: string; tip: string }
type Props = { bars: Bar[]; ticks: { x: number; label: string }[]; caption: string; picked: string }
type State = { hover: string }

const LANE_NAMES = ['输入', '模型', '工具']
const LABEL_CELLS = 5
const PICKED_COLOR = '#3d6fd6'
// A click this many cells away from a thin bar still picks it.
const REACH_CELLS = 1.5

const hitAt = (bars: readonly Bar[], lane: number, f: number, reach: number): Bar | undefined => {
  const inLane = bars.filter(b => b.lane === lane)
  const inside = inLane.filter(b => b.x0 <= f && f <= b.x1).at(-1)
  if (inside) return inside
  const near = inLane
    .map(b => ({ b, d: Math.min(Math.abs(b.x0 - f), Math.abs(b.x1 - f)) }))
    .filter(n => n.d <= reach)
    .sort((a, c) => a.d - c.d)[0]
  return near?.b
}

// One lane as runs of coloured cells; later bars paint over earlier ones.
const laneCells = (bars: readonly Bar[], lane: number, width: number, picked: string): (string | undefined)[] => {
  const cells: (string | undefined)[] = Array.from({ length: width }, () => undefined)
  for (const b of bars) {
    if (b.lane !== lane) continue
    const c0 = Math.min(width - 1, Math.floor(b.x0 * width))
    const c1 = Math.max(c0 + 1, Math.min(width, Math.ceil(b.x1 * width)))
    for (let c = c0; c < c1; c++) cells[c] = b.id === picked ? PICKED_COLOR : b.color
  }
  return cells
}

const runsOf = (cells: readonly (string | undefined)[]): { color?: string; n: number }[] =>
  cells.reduce<{ color?: string; n: number }[]>((runs, color) => {
    const last = runs.at(-1)
    if (last && last.color === color) return [...runs.slice(0, -1), { ...last, n: last.n + 1 }]
    return [...runs, color ? { color, n: 1 } : { n: 1 }]
  }, [])

const tickLine = (ticks: Props['ticks'], width: number): string => {
  const chars = Array.from({ length: width }, () => ' ')
  let free = 0
  for (const t of ticks) {
    const at = Math.min(width - 1, Math.round(t.x * width))
    if (at < free || at + t.label.length > width) continue
    for (let i = 0; i < t.label.length; i++) chars[at + i] = t.label[i] ?? ' '
    free = at + t.label.length + 2
  }
  return chars.join('')
}

const Timeline: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const width = Math.max(10, surface.columns - LABEL_CELLS)
  const hover = surface.state?.hover ?? ''

  surface.onPointer(ev => {
    const f = (ev.x - LABEL_CELLS + 0.5) / width
    const hit = ev.y >= 0 && ev.y < LANE_NAMES.length && f >= 0 ? hitAt(props.bars, ev.y, f, REACH_CELLS / width) : undefined
    if (ev.type === 'down' && ev.button === 'left' && hit) surface.post({ jump: hit.id })
    if ((ev.type === 'move' || ev.type === 'leave') && (hit?.id ?? '') !== hover) surface.setState({ hover: hit?.id ?? '' })
  })

  const tip = props.bars.find(b => b.id === hover)?.tip
  return (
    <Box flexDirection="column">
      {LANE_NAMES.map((name, lane) => (
        <Box key={`lane-${lane}`} flexDirection="row">
          <Text dimColor>{name.padEnd(LABEL_CELLS - 1, ' ')} </Text>
          <Text>
            {runsOf(laneCells(props.bars, lane, width, props.picked)).map(r =>
              r.color ? <Text backgroundColor={r.color}>{' '.repeat(r.n)}</Text> : ' '.repeat(r.n),
            )}
          </Text>
        </Box>
      ))}
      <Box flexDirection="row">
        <Text dimColor>{'时间'.padEnd(LABEL_CELLS - 1, ' ')} </Text>
        <Text dimColor>{tickLine(props.ticks, width)}</Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {tip ? `▸ ${tip}（点击跳到这一行）` : `${props.caption} · 点击色块跳到对应行`}
      </Text>
    </Box>
  )
}

export default Timeline
