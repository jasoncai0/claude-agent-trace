# agent-trace

A Claude Code mod that adds a **轨迹 (trace)** pane: see what the agent did in this session, step by step.

- **Langfuse-style tree**: turns → model steps → the tool calls each step asked for → subagent runs nested under the Agent call that spawned them. ▸/▾ folds a node; the latest 2 turns start open, subagent runs folded. Each row carries a small latency bar scaled to its turn.
- **Status at a glance**: ◌ running, ⊘ interrupted (cut off in an earlier turn), ⊖ denied, ✕ failed; a folded parent shows the worst status under it.
- **What the model saw**: open a model step for its request: overview (source, status, tokens, cache hit, thinking + reply preview, request timing: start, total, time to first token, generation, tok/s), the **messages this step added** since the previous request, the **system prompt** (every section + tool list), and the raw record.
- **Flags**: cache hit per step (yellow under 50%), ⚠ when uncached input jumps 3× against the loop's previous step, long durations yellow (≥10s) / red (≥1m).
- **Tool stats**: count, total, average and failures per tool; click one to show only that tool's calls.
- **Fixed header**: toolbar, search and the 3-lane timeline (input / model / tool, time ticks and span) stay put; the wheel moves a window over the rows, following the newest while at the bottom.
- **Search** with highlighted matches, **清空 (clear)**, and history from before the mod loaded rebuilt from the transcript (without durations).

Open it with `/agent-trace`.

## Install

At the prompt of a terminal session:

```
/plugin install agent-trace --marketplace jasoncai0/claude-agent-trace
```

Answer `y` to add the marketplace, then pick a scope (user is first).

From a shell:

```bash
claude plugin install agent-trace --marketplace jasoncai0/claude-agent-trace
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `jasoncai0/claude-agent-trace` → **Add plugin**.

Needs a Claude Code build with mods (function hooks), 2.1.29x or newer.

## How it records

| Lane | Event |
| --- | --- |
| 输入 | `turn.start` (main loop and subagents) |
| 系统提示 | `prompt.compose` (sections + tools, stored once per distinct prompt, latest 5) |
| 模型 | `turn.step`: the request's messages (`$.session.messages({ as: 'api' })`) diffed against the loop's previous step, time to first token, usage |
| 工具 | `tool.call`, with args, output and errors |

Limits: the timeline draws the latest 120 entries (SVG size cap); only the rows in view are drawn (Claude Desktop drops a pane tree of a few hundred kB); the state keeps 2000 rows and the full payloads (prompt, args, results, each block clipped at 8k chars) of the latest 150. The system prompt is rendered once per session, so it is captured only when the mod is loaded before the session starts.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
