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

test('a jump opens the folded turn above the row and puts the row on top', async () => {
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
  const plan = planJump(tree, [], 2, 't1', 3)
  expect(plan?.toggled).toEqual(['u1'])
  // rows after the jump: u1 s1 t1 u2 s2 u3 s3 → t1 at index 2, window of 3 → 7 - 3 - 2 = 2 rows from the end
  expect(plan?.fromEnd).toBe(2)
  expect(planJump(tree, [], 2, 'missing', 3)).toBeUndefined()
})
