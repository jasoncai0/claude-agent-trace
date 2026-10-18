# agent-trace

A Claude Code mod that adds a **轨迹 (trace)** pane: see what the agent did in this session, step by step.

- **What the model saw**: click any model row for its request: the **system prompt** (every section, its cache scope and size, plus the tool list), the **messages this step added** since the previous request (user prompt, CLAUDE.md / context reminders, tool results, ...), and its **output**. Token usage with cache reads/writes and time to first token on each step.
- **Timeline**: three lanes (输入 input / 模型 model / 工具 tool). A model bar is light until the first token, dark while streaming; a green sliver on the input lane marks what that step added. Errors show red, running steps faded. Hover a block for details (Desktop).
- **List**: every tool call as `Bash {"command":...} → output`, every model step with its new-input count and tokens, and user/subagent inputs, tagged with the turn number. Click a row for the full args/result/prompt.
- **Views**: 时长 (real time), 轮次 (each turn gets equal width), 调用 (each call gets equal width).
- **Search** and **清空 (clear)**.
- History from before the mod loaded is rebuilt from the transcript, without durations.

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

Limits: the timeline draws the latest 120 entries (SVG size cap), the list shows the latest 300, the state keeps 2000 rows and the full payloads (prompt, args, results, each block clipped at 8k chars) of the latest 150. The system prompt is captured the next time the engine renders it.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
