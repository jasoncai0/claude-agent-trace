# agent-trace

A Claude Code mod that adds a **轨迹 (trace)** pane: see what the agent did in this session, step by step.

- **What the model saw**: click any model row for its request: the **system prompt** (every section, its cache scope and size, plus the tool list), the **messages this step added** since the previous request (user prompt, CLAUDE.md / context reminders, tool results, ...), and its **output**. Token usage with cache reads/writes and time to first token on each step.
- **Timeline**: three lanes (输入 input / 模型 model / 工具 tool). A model bar is light until the first token, dark while streaming; a green sliver on the input lane marks what that step added. Errors show red, running steps faded. Hover a block for details (Desktop).
- **List**: one readable line per entry: `工具 #3  Bash ls -la → total 32 (+12 行)`, `模型 #3  <reply>  +2 输入 · in 1.2k · 缓存 45k · out 210 · 首 1.1s`, user and subagent prompts; long durations turn yellow (≥10s) or red (≥1m), errors red, search matches highlighted. Click a row to expand its full args/result/prompt right below it; long blocks show their first lines until expanded. ↑ 顶部 / ↓ 最新 jump the pane.
- **Views**: 时长 (real time, with round time ticks), 轮次 (each turn gets equal width, labelled with its own span), 调用 (each call gets equal width). The axis under the lanes states the total span.
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
