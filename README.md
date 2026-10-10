# opencode2-usage

OpenCode 2 (beta) TUI plugin that shows your **Codex**, **Claude**, **GLM Coding Plan**
and **OpenCode Go** usage right where you need it:

- a card in the session **sidebar**
- a compact one-liner in the **prompt footer** and on the **home screen**
- an on-demand **`/usage`** command (palette + slash) that refreshes and toasts a summary

```
Usage

Codex  5h ──────────── 0% 2h
       7d ━━────────── 82% 3d 18h

Claude 5h ──────────── 0% 2h 37m ⟳ 5m
       7d ━━━━━━━━━━━━ 92% 6d 20h
       ig***@enhancer.at
       5h login required
       xo***@igor.ovh

GLM    5h ━━━━──────── 55% 3h 6m

Go     5h ──────────── 0% 2h
       7d ━━────────── 82% 3d 18h
       1m ━━━━━━━━━━━━ 92% 6d 20h
```

- Percentages are **remaining** quota (not used), colors: green > 30%, yellow ≤ 30%, red ≤ 10%.
- Claude shows **every account connected in OpenCode** (`/connect`, OAuth kept fresh by the
  anthropic auth plugin), each with its own windows and a masked email underneath.
- Claude is fetched via the same OAuth endpoint the interactive `/usage` command uses,
  identified with a `claude-code/<version>` user agent (Anthropic throttles unknown agents).
- Transient errors never blank the card: the last good snapshot is kept (10 min for errors,
  indefinitely while rate-limited, shown as `(limited 3m)` / `⟳ 5m`).
- State is persisted via the plugin's durable storage and synced across TUI instances.

## Install

```sh
git clone https://github.com/igorovh/opencode2-usage
cd opencode2-usage && bun install
```

Register it in `~/.config/opencode/cli.json` (or `opencode.jsonc`) and restart the TUI:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode2-usage",
      "options": {
        "refreshMs": 60000,
        "sidebar": true,
        "footer": true,
        "home": true
      }
    }
  ]
}
```

> Note: the host resolves local plugins from `<dir>/index.ts` + `<dir>/tui.ts` -
> both re-export the real implementation from `src/`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `refreshMs` | `60000` | Refresh interval (min `15000`) |
| `sidebar` | `true` | Show the sidebar card |
| `footer` | `true` | Show the prompt footer line (5h windows only) |
| `home` | `true` | Show the home screen line |
| `providers` | all | e.g. `{ "claude": false }` to disable a provider |
| `goApiKey` | auto | OpenCode Go API key override (`apiKey` also accepted) |
| `goBaseUrl` | `https://opencode.ai/zen/go` | OpenCode Go API base (`/v1/usage` is appended) |

## Data sources

| Provider | Source | Auth |
| --- | --- | --- |
| Codex | `chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` (ChatGPT login, not API key) or OpenCode auth.json `openai` |
| Claude | `api.anthropic.com/api/oauth/usage` | OAuth tokens of every Claude account in OpenCode's credential store (`opencode.db`, `integration_id = "anthropic"`) - requires Pro/Max subscription |
| GLM | `api.z.ai` / `bigmodel.cn` `/api/monitor/usage/quota/limit` | OpenCode auth.json `zai-coding-plan` / `zhipu-coding-plan` or `ZAI_API_KEY` / `ZHIPU_API_KEY` |
| Go | `opencode.ai/zen/go/v1/usage` | `OPENCODE_API_KEY` env or OpenCode auth.json `opencode-go` (then `opencode`), `type: "api"` |

Platform (Z.ai vs Zhipu) is auto-detected from where the key was found.
The GLM endpoint expects the raw key in `Authorization` - **without** the `Bearer` prefix.

## Diagnostics

Every TUI instance appends JSONL call logs (per provider: duration, outcome, cooldowns)
to `~/.local/share/opencode/log/usage-plugin.log` - handy for auditing API usage
across multiple running instances.

## Credits & notes

- Techniques borrowed from [slkiser/opencode-quota](https://github.com/slkiser/opencode-quota)
  (CLI-first Claude probing, wham/usage parsing) and
  [steipete/codexbar](https://github.com/steipete/codexbar) (the `claude-code/*` user agent trick).
- All three provider endpoints are undocumented and can change without notice.

## License

MIT
