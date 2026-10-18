# agent-trace

A Claude Code mod that adds a **轨迹 (trace)** pane: see what the agent did in this session, step by step.

- **Timeline**: three lanes (输入 input / 模型 model / 工具 tool). Errors show red, steps still running show faded. Hover a block for its args, output and duration (Desktop).
- **List**: every tool call as `Bash {"command":...} → output`, assistant replies, and user/subagent inputs, tagged with the turn number.
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
| 模型 | `turn.step`, with token usage |
| 工具 | `tool.call`, with args, output and errors |

Limits: the timeline draws the latest 200 entries (SVG size cap), the list shows the latest 300, and the state keeps 2000.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
