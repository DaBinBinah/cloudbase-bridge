# Deploy aiProxy (detailed guide)

The canonical, self-contained deployment guide lives with the function:
**[`cloudfunctions/aiProxy/README.md`](../cloudfunctions/aiProxy/README.md)**
(console upload + CLI + verification + security notes). This page is the
short version plus the checklist of things people commonly get wrong.

## TL;DR

```bash
# from the repository root
cp cloudbaserc.example.json cloudbaserc.json     # then set "envId"
tcb login
tcb fn deploy aiProxy --force                    # Event Function — no --httpFn
tcb fn invoke aiProxy --params '{"action":"ping"}'
# expect: {"ok":true,"service":"aiProxy","version":"1.0.0","env":"<your-env>","models":[...]}
```

## Checklist

| Item | Value | Why |
| --- | --- | --- |
| Function type | **Event Function** (`exports.main`) | The plugin invokes it through the function-invocation endpoint, not HTTP triggers |
| Runtime | `Nodejs18.15`+ (locked after creation) | `@cloudbase/node-sdk` AI features need ≥ 3.16 |
| Timeout | **120 s** | One-shot generation runs inside one invocation; the 20 s default truncates |
| Memory | 256 MB | Ample for validation + one SDK call |
| Dependencies | `installDependency: true` (or zip `node_modules`) | Platform installs `@cloudbase/node-sdk@^3.16.0`; don't do both |
| Entry | `index.main` | Matches `exports.main(event, context)` |
| Env vars | none required (`TCB_ENV` is runtime-injected); optional `AI_PROXY_ALLOWED_MODELS` | No personal environment id is baked into the code |
| Same environment | The API Key used by the plugin must belong to **this environment** | Gateway URL is derived from the login envId |

## After deploying

1. In Magpie: `magpie plugin add …` + `magpie plugin login cloudbase`
   (env ID = this environment).
2. `magpie provider test cloudbase` — one tiny round-trip.
3. The provider model list now reflects the function's allowlist (via
   `{"action":"ping"}`).

If anything fails, match the error code against
[`docs/troubleshooting.md`](troubleshooting.md).
