# Reply summaries

Checks the sidebar reply summary prompt and sanitizer on synthetic agent replies, through the server's Codex text generation path. It defaults to the setting's default model, `gpt-6-luna` at low effort. Run from `evals/` with a configured Codex login:

```sh
pnpm reply-summaries --out runs/summaries
pnpm reply-summaries --out runs/summaries-new --baseline runs/summaries/results.json
```

Use `--case <id> --samples 1` for a smoke run, and `--model` or `--effort` to compare settings. By default the six cases run three times each (18 short model calls). Read `review.json` against each rubric before opening the answer key. A good summary is 3 to 8 words, names the specific thing, and makes clear whether the work is done, blocked, or asking. Add a case to `cases.ts` when a real summary loses the detail a user needed.
