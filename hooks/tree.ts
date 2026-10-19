import type { TraceEvent } from '../types'

// A row of the trace tree: a turn (its input), a model step, a tool call, or a subagent's run.
export type TreeNode = {
  id: string
  kind: 'turn' | 'model' | 'tool' | 'agent'
  ev?: TraceEvent
  agentId?: string
  children: TreeNode[]
}

export type FlatRow = { node: TreeNode; depth: number; isOpen: boolean; hiddenChildren: number }

const SPAWNING_TOOLS = ['Agent', 'Task']
export const CHILDREN_MAX = 40

const node = (ev: TraceEvent): TreeNode => ({
  id: ev.id,
  kind: ev.kind === 'input' ? 'turn' : ev.kind,
  ev,
  children: [],
})

// One loop's events, in order: an input opens a turn, a step joins the turn, a tool joins the step that asked for it.
const buildLoop = (evs: readonly TraceEvent[]): TreeNode[] => {
  const top: TreeNode[] = []
  let turn: TreeNode | undefined
  let step: TreeNode | undefined
  for (const ev of evs) {
    const n = node(ev)
    if (ev.kind === 'input') {
      top.push(n)
      turn = n
      step = undefined
    } else if (ev.kind === 'model') {
      ;(turn ? turn.children : top).push(n)
      step = n
    } else {
      const parent = step ?? turn
      if (parent) parent.children.push(n)
      else top.push(n)
    }
  }
  return top
}

const walk = (nodes: readonly TreeNode[]): TreeNode[] => nodes.flatMap(n => [n, ...walk(n.children)])

export const spanOf = (n: TreeNode, now: number): { start?: number; end?: number; isRunning: boolean } => {
  const evs = [n, ...walk(n.children)].map(x => x.ev).filter((ev): ev is TraceEvent => ev !== undefined)
  const starts = evs.map(ev => ev.start).filter((t): t is number => t !== undefined)
  const isRunning = evs.some(ev => ev.start !== undefined && ev.end === undefined)
  const ends = evs.map(ev => ev.end ?? (ev.start !== undefined ? now : undefined)).filter((t): t is number => t !== undefined)
  return {
    ...(starts.length ? { start: Math.min(...starts) } : {}),
    ...(ends.length ? { end: Math.max(...ends) } : {}),
    isRunning,
  }
}

// Main-loop turns, with each subagent's run nested under the call that spawned it.
export const buildTree = (events: readonly TraceEvent[]): TreeNode[] => {
  const main = buildLoop(events.filter(ev => !ev.agentId))
  const agentIds = [...new Set(events.map(ev => ev.agentId).filter((id): id is string => !!id))]
  const mainNodes = walk(main)
  for (const agentId of agentIds) {
    const evs = events.filter(ev => ev.agentId === agentId)
    const group: TreeNode = { id: `agent:${agentId}`, kind: 'agent', agentId, children: buildLoop(evs) }
    const at = evs.find(ev => ev.start !== undefined)?.start
    const spawner = [...mainNodes]
      .reverse()
      .find(
        n =>
          n.kind === 'tool' &&
          at !== undefined &&
          n.ev?.start !== undefined &&
          n.ev.start <= at &&
          (n.ev.end === undefined || n.ev.end >= at) &&
          SPAWNING_TOOLS.includes(n.ev.name ?? n.ev.title.split(' ')[0] ?? ''),
      )
    const fallback = [...mainNodes].reverse().find(n => n.kind === 'model' && (at === undefined || (n.ev?.start ?? 0) <= at))
    const parent = spawner ?? fallback
    if (parent) parent.children.push(group)
    else main.push(group)
  }
  return main
}

export const countOf = (n: TreeNode): { steps: number; tools: number } =>
  walk(n.children).reduce(
    (c, x) => ({ steps: c.steps + (x.kind === 'model' ? 1 : 0), tools: c.tools + (x.kind === 'tool' ? 1 : 0) }),
    { steps: 0, tools: 0 },
  )

// Keeps the nodes that match, with their ancestors; null when nothing under `n` matches.
export const filterTree = (nodes: readonly TreeNode[], isMatch: (ev: TraceEvent) => boolean): TreeNode[] =>
  nodes.flatMap(n => {
    const children = filterTree(n.children, isMatch)
    return (n.ev && isMatch(n.ev)) || children.length ? [{ ...n, children }] : []
  })

// Open by default: all but the main loop's older turns and subagent runs. `toggled` flips the default.
export const isOpenBy =
  (top: readonly TreeNode[], toggled: readonly string[], openTurns: number) =>
  (n: TreeNode): boolean => {
    const isOldTurn = top.some(t => t.id === n.id) && !top.slice(-openTurns).some(t => t.id === n.id)
    const byDefault = n.kind !== 'agent' && !isOldTurn
    return toggled.includes(n.id) ? !byDefault : byDefault
  }

// Depth-first rows of the open part of the tree; long child lists show their last CHILDREN_MAX.
export const flatten = (
  nodes: readonly TreeNode[],
  isOpen: (n: TreeNode) => boolean,
  showsAll: (n: TreeNode) => boolean,
  depth = 0,
): FlatRow[] =>
  nodes.flatMap(n => {
    const open = n.children.length > 0 && isOpen(n)
    const kids = open && !showsAll(n) ? n.children.slice(-CHILDREN_MAX) : n.children
    const row = { node: n, depth, isOpen: open, hiddenChildren: open ? n.children.length - kids.length : 0 }
    return open ? [row, ...flatten(kids, isOpen, showsAll, depth + 1)] : [row]
  })
