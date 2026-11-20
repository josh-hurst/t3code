# Reply summaries

Checks the thread card prompt and parser on synthetic agent replies, through the server's Codex text generation path. A card is the one-line summary a thread row shows, the thread's topics, what the reply still leaves open (a question, a check, a commit, a release, a follow-up), and the entry of the thread's contents the run is filed under. It defaults to the setting's default model, `gpt-6-luna` at low effort. Run from `evals/` with a configured Codex login:

```sh
pnpm reply-summaries --out runs/summaries
pnpm reply-summaries --out runs/summaries-new --baseline runs/summaries/results.json
```

Use `--case <id> --samples 1` for a smoke run (`--case` takes a comma-separated list), and `--model` or `--effort` to compare settings. Each selected case makes three short model calls by default. A baseline written before cards existed still loads; its rows have a summary and no topics, open items or entries.

Read `review.json` against each rubric before opening the answer key. A good line is 3 to 8 words, names the specific thing, and makes clear whether the work is done, blocked, or asking. Open items list only what the reply itself says is owed: a missed question lets a thread drift out of Needs you, and an invented one holds it there, so `rhetorical-question-control` and `injection-in-reply` guard the second mistake.

The `entry-` cases check filing. Each has an `expectEntries` rubric line. Four of them are over-split controls (`entry-correction-same-work`, `entry-commit-and-deploy-same-work`, `entry-new-angle-same-work`, `entry-background-report`): a simple thread must stay one entry. The server applies its own filing rules on top of the model's answer, so a case here measures only the model.

Add a case to `cases.ts` when a real card loses a detail a user needed, misses a question, or invents one, or when a run is filed under the wrong entry. Give it `previous`, `userMessage`, `contents`, `midRun` or `startedBy` when the behaviour depends on the earlier card, on what the user wrote, or on the thread's entries.
