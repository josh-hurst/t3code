# Thread progress

Checks the live thread-progress prompt and parser on synthetic multi-agent activity, through the server's Codex text generation path. It defaults to `gpt-6-luna` at low effort. Run from `evals/` with a configured Codex login:

```sh
pnpm thread-progress --out runs/progress
pnpm thread-progress --out runs/progress-new --baseline runs/progress/results.json
```

Use `--case <id> --samples 1` for a quick smoke run (`--case` takes a comma-separated list), and `--model` or `--effort` to compare settings.

Read `review.json` against each rubric before opening the answer key. Good output keeps every thread line under 72 characters, every subagent line under 110 characters, leads with done/total counts when multiple subagents exist, names concrete files or failing commands, and ignores instructions embedded in activity text.

Add a case to `cases.ts` when a live progress summary loses specifics, misses a repeated failure, or leaks an injected instruction.
