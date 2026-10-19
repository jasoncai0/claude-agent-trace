import type { TraceEvent } from '../types'
import type { TreeNode } from './tree'

export type Status = 'ok' | 'running' | 'interrupted' | 'denied' | 'error'

// Worst first: a folded parent shows the worst status among everything under it.
const PRIORITY: readonly Status[] = ['error', 'denied', 'interrupted', 'running', 'ok']

// A call or step with no end is still running in the latest turn, and was cut off in any earlier one.
export const statusOf = (ev: TraceEvent, lastTurn: number): Status => {
  if (ev.isDenied) return 'denied'
  if (ev.isError) return 'error'
  if (ev.start !== undefined && ev.end === undefined) return ev.turn < lastTurn ? 'interrupted' : 'running'
  return 'ok'
}

export const worst = (statuses: readonly Status[]): Status =>
  PRIORITY.find(s => statuses.includes(s)) ?? 'ok'

export const nodeStatus = (n: TreeNode, lastTurn: number): Status =>
  worst([...(n.ev ? [statusOf(n.ev, lastTurn)] : []), ...n.children.map(c => nodeStatus(c, lastTurn))])
