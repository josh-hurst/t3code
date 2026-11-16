# Topic regroup

Checks the regroup prompt, which rebuilds a long thread's topic entries from an outline of its runs (the user's message, shortened, and the card line of each run). It runs through the server's Codex text generation path on `gpt-6-luna` at low effort by default, with a configured Codex login. The eval imports the outline builder, the prompt, the parser, the repair step and the vote that combines samples from source, and grades itself with B-cubed F against each case's expected grouping.

```sh
pnpm topic-regroup --out runs/regroup --dry-run
pnpm topic-regroup --out runs/regroup
pnpm topic-regroup --out runs/regroup-new --baseline runs/regroup/summary.json
```

`--dry-run` makes no model call: it builds every prompt and checks that each case's own expected grouping passes its checks. Use `--case <id> --samples 1` for a smoke run (`--case` takes a comma-separated list), and `--model` or `--effort` to compare settings. By default the nine cases run three times each (27 calls of about 11,000 input tokens through `codex exec`, far fewer through codex-lite). A case fails when half or more of its samples fail. `summary.json` also grades the three samples combined by vote, which is what an idle regroup stores.

Two cases are over-split controls (`one-feature-twelve-runs`, `one-watch-many-reports`): a thread about one thing must come back as one topic. `injection-in-outline` checks that an instruction inside a user message does not change the grouping. The open or done field the prompt asks for is not graded; open state comes from the cards' items, never from this model.

Add a case to `cases.ts` when a real regroup splits one piece of work, lumps two subjects, or loses a returning topic. Write the threads from scratch: no titles, messages or outcomes from real threads, and no subjects from the prompt's own examples.
