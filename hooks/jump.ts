import { flatten, isOpenBy } from './tree'
import type { TreeNode } from './tree'

const pathTo = (nodes: readonly TreeNode[], id: string): TreeNode[] | undefined => {
  for (const n of nodes) {
    if (n.id === id) return [n]
    const below = pathTo(n.children, id)
    if (below) return [n, ...below]
  }
  return undefined
}

// Opens every folded ancestor of `id` and places its row at the window's top; undefined when the tree lacks it.
export const planJump = (
  whole: readonly TreeNode[],
  toggled: readonly string[],
  openTurns: number,
  id: string,
  capacity: number,
): { toggled: string[]; fromEnd: number } | undefined => {
  const path = pathTo(whole, id)
  if (!path) return undefined
  const isOpen = isOpenBy(whole, toggled, openTurns)
  const toOpen = path.slice(0, -1).filter(n => !isOpen(n)).map(n => n.id)
  const opened = [...toggled.filter(k => !toOpen.includes(k)), ...toOpen.filter(k => !toggled.includes(k))]
  const rowsOf = (keys: readonly string[]) =>
    flatten(whole, isOpenBy(whole, keys, openTurns), n => keys.includes(`all:${n.id}`))
  // A row past its parent's shown children needs the parent to show all of them.
  const parent = path.at(-2)
  const next =
    parent && rowsOf(opened).every(r => r.node.id !== id) ? [...opened, `all:${parent.id}`] : opened
  const rows = rowsOf(next)
  const at = Math.max(0, rows.findIndex(r => r.node.id === id))
  const max = Math.max(0, rows.length - capacity)
  return { toggled: next, fromEnd: Math.min(max, Math.max(0, rows.length - capacity - at)) }
}
