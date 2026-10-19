export type TraceKind = 'input' | 'model' | 'tool'

export type TraceMode = 'time' | 'turn' | 'call'

export type DetailTab = 'overview' | 'input' | 'system' | 'raw'

export type StepUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type TraceEvent = {
  id: string
  kind: TraceKind
  turn: number
  title: string
  detail: string
  start?: number
  end?: number
  agentId?: string
  isError?: boolean
  // a hook or the permission check refused the call
  isDenied?: boolean
  // tools: short name and the most telling argument, for the row
  name?: string
  summary?: string
  // model steps: when the first content chunk arrived, the request's size and what it cost
  firstAt?: number
  messageCount?: number
  newCount?: number
  newChars?: number
  systemId?: string
  usage?: StepUsage
}

// One content block of a request (or a tool's args/result), flattened to text.
export type InputPart = { role: string; kind: string; text: string }

// The full payload behind a row, kept for the latest rows only.
export type Payload = { parts: InputPart[]; omitted: number; output?: string; thinking?: string }

export type SystemSection = { id: string; scope: string; text: string }

export type SystemSnapshot = { id: string; at: number; model: string; tools: string[]; sections: SystemSection[] }

declare module 'claude-code' {
  interface PluginState {
    'agent-trace': {
      events: TraceEvent[]
      mode: TraceMode
      query: string
      selected: string
      tab: DetailTab
      payloads: Record<string, Payload>
      systems: SystemSnapshot[]
      openParts: string[]
      toggled: string[]
      fromEnd: number
      slack: number
      toolFilter: string
      showStats: boolean
    }
  }
}
