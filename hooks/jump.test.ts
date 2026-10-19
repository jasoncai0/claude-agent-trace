import { expect, test } from 'claude-code/testing'

import type { TraceEvent } from '../types'
import { planJump } from './jump'
import { buildTree } from './tree'

const ev = (id: string, kind: TraceEvent['kind'], start: number): TraceEvent => ({
  id,
  kind,
  turn: 1,
  title: id,
  detail: '',
  start,
  end: start + 1,
})

test('a jump opens the folded turn above the row and finds its place', async () => {
  const tree = buildTree([
    ev('u1', 'input', 0),
    ev('s1', 'model', 1),
    ev('t1', 'tool', 2),
    ev('u2', 'input', 3),
    ev('s2', 'model', 4),
    ev('u3', 'input', 5),
    ev('s3', 'model', 6),
  ])
  // u1 is an older turn, folded by default (the latest 2 open)
  const plan = planJump(tree, [], 2, 't1')
  expect(plan?.toggled).toEqual(['u1'])
  // rows after the jump: u1 s1 t1 u2 s2 u3 s3
  expect(plan?.index).toBe(2)
  expect(plan?.total).toBe(7)
  expect(planJump(tree, [], 2, 'missing')).toBeUndefined()
})
