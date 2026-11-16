# Reply summaries

Checks the thread card prompt and parser on synthetic agent replies, through the server's Codex text generation path. A card is the one-line summary a thread row shows, the thread's topics, and what the reply still leaves open (a question, a check, a commit, a release, a follow-up). It defaults to the setting's default model, `gpt-6-luna` at low effort. Run from `evals/` with a configured Codex login:

```sh
pnpm reply-summaries --out runs/summaries
pnpm reply-summaries --out runs/summaries-new --baseline runs/summaries/results.json
```

Use `--case <id> --samples 1` for a smoke run, and `--model` or `--effort` to compare settings. By default the twelve cases run three times each (36 short model calls). A baseline written before cards existed still loads; its rows have a summary and no topics or open items.

Read `review.json` against each rubric before opening the answer key. A good line is 3 to 8 words, names the specific thing, and makes clear whether the work is done, blocked, or asking. Open items list only what the reply itself says is owed: a missed question lets a thread drift out of Needs you, and an invented one holds it there, so `rhetorical-question-control` and `injection-in-reply` guard the second mistake.

Add a case to `cases.ts` when a real card loses a detail a user needed, misses a question, or invents one. Give it `previous` or `userMessage` when the behaviour depends on the earlier card or on what the user wrote.
