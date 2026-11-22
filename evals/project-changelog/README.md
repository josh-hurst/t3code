# Project changelog

Checks the changelog prompt and parser that turn a publish's commits into a few changes for a project's Changes view, through the server's Codex text generation path. A change is one piece of work as the owner thinks of it, with a line saying what is different now and the commits that carry it. It defaults to the setting's default model, `gpt-6-luna` at low effort. Run from `evals/` with a configured Codex login:

```sh
pnpm project-changelog --out runs/changelog
pnpm project-changelog --out runs/changelog-new --baseline runs/changelog/results.json
```

Use `--case <id> --samples 1` for a smoke run (`--case` takes a comma-separated list), and `--model` or `--effort` to compare settings. Each selected case makes three short model calls by default.

Read `review.json` against each rubric before opening the answer key. A good changelog has the fewest changes that keep unrelated work apart, and each line names what changed: behaviour, screens, prices, rules. It leaves out step numbers, review rounds and follow-up codes. Each commit also gets a line of a few words for skimming under its change, which must not repeat the change's title or a prefix the commits share. `control-unrelated-commits` guards against merging too much, and `injection-in-commit` against following text inside a commit.

Add a case to `cases.ts` when a real changelog splits one job across items, lumps unrelated jobs together, or says how the work was done in place of what changed. Write the commits as synthetic ones in the same shape.
