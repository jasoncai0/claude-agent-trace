import { expect, test } from 'claude-code/testing'

import type { TraceEvent } from '../types'
import { nodeStatus, statusOf, worst } from './status'
import type { TreeNode } from './tree'

const ev = (extra: Partial<TraceEvent>): TraceEvent => ({ id: 'x', kind: 'tool', turn: 1, title: '', detail: '', start: 0, end: 1, ...extra })

test('an unfinished call runs in the latest turn and was interrupted in an earlier one', async () => {
  expect(statusOf(ev({ end: undefined }), 1)).toBe('running')
  expect(statusOf(ev({ end: undefined }), 2)).toBe('interrupted')
  expect(statusOf(ev({ isDenied: true }), 1)).toBe('denied')
  expect(statusOf(ev({ isError: true }), 1)).toBe('error')
  expect(statusOf(ev({}), 1)).toBe('ok')
})

test('a parent shows the worst status under it', async () => {
  expect(worst(['ok', 'running', 'denied'])).toBe('denied')
  const leaf = (e: Partial<TraceEvent>): TreeNode => ({ id: 'l', kind: 'tool', ev: ev(e), children: [] })
  const turn: TreeNode = {
    id: 't',
    kind: 'turn',
    ev: ev({ kind: 'input' }),
    children: [{ id: 's', kind: 'model', ev: ev({ kind: 'model' }), children: [leaf({}), leaf({ isError: true })] }],
  }
  expect(nodeStatus(turn, 1)).toBe('error')
})
