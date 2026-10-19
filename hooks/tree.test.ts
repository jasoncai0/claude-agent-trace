import { expect, test } from 'claude-code/testing'

import type { TraceEvent } from '../types'
import { buildTree, countOf, filterTree, flatten, isOpenBy } from './tree'

const ev = (id: string, kind: TraceEvent['kind'], start: number, end: number, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  id,
  kind,
  turn: 1,
  title: id,
  detail: id,
  start,
  end,
  ...extra,
})

const session = [
  ev('u1', 'input', 0, 0),
  ev('s1', 'model', 1, 5),
  ev('t1', 'tool', 6, 9),
  ev('t2', 'tool', 6, 30, { name: 'Agent' }),
  ev('a-in', 'input', 7, 7, { agentId: 'sub1' }),
  ev('a-s', 'model', 8, 12, { agentId: 'sub1' }),
  ev('a-t', 'tool', 13, 14, { agentId: 'sub1' }),
  ev('s2', 'model', 31, 35),
  ev('u2', 'input', 40, 40),
  ev('s3', 'model', 41, 45),
]

test('tools nest under the step that asked for them, steps under their turn', async () => {
  const tree = buildTree(session)
  expect(tree.map(n => n.id)).toEqual(['u1', 'u2'])
  expect(tree[0]?.children.map(n => n.id)).toEqual(['s1', 's2'])
  expect(tree[0]?.children[0]?.children.map(n => n.id)).toEqual(['t1', 't2'])
  expect(countOf(tree[0]!)).toEqual({ steps: 3, tools: 3 })
})

test('a subagent run nests under the Agent call that was running when it started', async () => {
  const agent = buildTree(session)[0]?.children[0]?.children[1]?.children[0]
  expect(agent?.id).toBe('agent:sub1')
  expect(agent?.children[0]?.children[0]?.children.map(n => n.id)).toEqual(['a-t'])
})

test('older turns and subagent runs start folded; toggling flips that', async () => {
  const tree = buildTree(session)
  const rows = flatten(tree, isOpenBy(tree, [], 1), () => false)
  expect(rows.map(r => r.node.id)).toEqual(['u1', 'u2', 's3'])
  const opened = flatten(tree, isOpenBy(tree, ['u1', 'agent:sub1'], 1), () => false)
  expect(opened.map(r => `${r.guides}${r.node.id}`)).toEqual([
    'u1',
    '├─s1',
    '│ ├─t1',
    '│ └─t2',
    '│   └─agent:sub1',
    '│     └─a-in',
    '│       └─a-s',
    '│         └─a-t',
    '└─s2',
    'u2',
    '└─s3',
  ])
})

test('search keeps matches with their ancestors', async () => {
  const kept = filterTree(buildTree(session), e => e.id === 'a-t')
  expect(flatten(kept, () => true, () => true).map(r => r.node.id)).toEqual([
    'u1',
    's1',
    't2',
    'agent:sub1',
    'a-in',
    'a-s',
    'a-t',
  ])
})
