export type TraceKind = 'input' | 'model' | 'tool'

export type TraceMode = 'time' | 'turn' | 'call'

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
}

declare module 'claude-code' {
  interface PluginState {
    'agent-trace': { events: TraceEvent[]; mode: TraceMode; query: string }
  }
}
