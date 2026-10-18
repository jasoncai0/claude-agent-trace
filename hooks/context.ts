import type { InputPart, Payload, SystemSnapshot, TraceEvent } from '../types'

const PART_MAX = 8000
const STEP_PARTS = 40
export const PAYLOADS_MAX = 150
const SYSTEMS_MAX = 5

type Block = { type: string; [field: string]: unknown }
type Message = { role: string; content: readonly Block[] }

export const clipText = (text: string, max = PART_MAX): string =>
  text.length > max ? `${text.slice(0, max)}\n…（截断，共 ${text.length} 字符）` : text

const json = (value: unknown, indent?: number): string => {
  try {
    return JSON.stringify(value, null, indent) ?? ''
  } catch {
    return String(value)
  }
}

export const pretty = (value: unknown): string => json(value, 2)

const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return json(content)
  return content
    .map((c: Block) => (c.type === 'text' ? String(c.text ?? '') : `[${c.type}]`))
    .join('\n')
}

export const blockPart = (role: string, b: Block): InputPart => {
  switch (b.type) {
    case 'text':
      return { role, kind: 'text', text: String(b.text ?? '') }
    case 'tool_use':
      return { role, kind: `tool_use · ${String(b.name)}`, text: pretty(b.input) }
    case 'tool_result':
      return { role, kind: b.is_error ? 'tool_result · error' : 'tool_result', text: resultText(b.content) }
    case 'thinking':
      return { role, kind: 'thinking', text: String(b.thinking ?? '') }
    case 'image':
    case 'document':
    case 'redacted_thinking':
      return { role, kind: b.type, text: `[${b.type}]` }
    default:
      return { role, kind: b.type, text: json(b) }
  }
}

// What a request added since the loop's previous request: everything when it shrank (compaction).
export const stepPayload = (
  messages: readonly Message[],
  prevCount: number,
): { payload: Payload; newCount: number; newChars: number } => {
  const fresh = prevCount <= messages.length ? messages.slice(prevCount) : messages
  const parts = fresh.flatMap(m => m.content.map(b => blockPart(m.role, b)))
  const kept = parts.slice(-STEP_PARTS).map(p => ({ ...p, text: clipText(p.text) }))
  return {
    payload: { parts: kept, omitted: parts.length - kept.length },
    newCount: fresh.length,
    newChars: parts.reduce((n, p) => n + p.text.length, 0),
  }
}

export const prevMessageCount = (list: readonly TraceEvent[], agentId: string | undefined): number => {
  const prev = [...list]
    .reverse()
    .find(ev => ev.kind === 'model' && ev.agentId === agentId && ev.messageCount !== undefined)
  return prev?.messageCount ?? 0
}

export const putPayload = (
  map: Readonly<Record<string, Payload>>,
  id: string,
  payload: Payload,
): Record<string, Payload> => {
  const { [id]: _old, ...rest } = map
  return Object.fromEntries(Object.entries({ ...rest, [id]: payload }).slice(-PAYLOADS_MAX))
}

const hash = (text: string): string => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export const systemId = (s: Omit<SystemSnapshot, 'id' | 'at'>): string =>
  hash(`${s.model}\n${s.tools.join(',')}\n${s.sections.map(x => `${x.id}:${x.text}`).join('\n')}`)

// Newest last; an identical prompt only moves to the end.
export const putSystem = (list: readonly SystemSnapshot[], snap: SystemSnapshot): SystemSnapshot[] =>
  [...list.filter(s => s.id !== snap.id), snap].slice(-SYSTEMS_MAX)

export const latestSystem = (list: readonly SystemSnapshot[], model: string): SystemSnapshot | undefined =>
  [...list].reverse().find(s => s.model === model) ?? list.at(-1)
