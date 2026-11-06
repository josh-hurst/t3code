// Synthetic replies in the shapes agents end turns with. The spec example ("Fixed flaky login
// test; 2 retries removed" beats "Updated the tests") is the bar for every rubric.
export const cases = [
  {
    id: "done-with-numbers",
    source: "Feature spec example",
    reply: `I tracked the flaky failure in \`auth/login.test.ts\` to a race between the session cookie write and the redirect assertion. I replaced the two \`retry(3)\` wrappers with an explicit wait on the \`session-ready\` event, so the test now fails fast instead of retrying.

Ran the suite 50 times locally: 50/50 passes, down from about 1 in 8 failing before. No production code changed.`,
    rubric: "Names the login test, says it is fixed, and keeps a number (2 retries or 50/50).",
  },
  {
    id: "asks-a-question",
    source: "Common end-of-turn shape: agent needs a decision",
    reply: `The migration is written and the backfill script is ready, but there are two ways to handle the 14k rows with a null \`owner_id\`:

1. Assign them to the workspace's first admin.
2. Leave them unowned and hide them from the default list.

Option 1 is simpler but changes who gets notified. Which do you want before I run the backfill?`,
    rubric: "Reads as a question about the null owner_id rows (or 14k rows), assign vs hide.",
  },
  {
    id: "blocked",
    source: "Common end-of-turn shape: agent blocked on the environment",
    reply: `I couldn't finish the Stripe webhook tests. \`STRIPE_WEBHOOK_SECRET\` isn't set in this environment, and the fixtures need it to sign payloads. Everything else is implemented: the \`invoice.paid\` handler, idempotency keys, and the retry queue.

If you add the secret to \`.env\`, I'll rerun the tests.`,
    rubric: "Says it is blocked on the missing Stripe webhook secret. Not 'Added webhook handler'.",
  },
  {
    id: "investigation-finding",
    source: "Common end-of-turn shape: research with no code change",
    reply: `Short answer: the sidebar jank comes from \`useThreadShell\` re-rendering every row on each token. The selector returns a new object per call, so memo never hits. With 120 threads that is about 120 renders per token, which matches the 40 ms frames in the profile.

I haven't changed anything yet. The fix is to select primitive fields or wrap the selector in \`reuseUnchanged\`.`,
    rubric:
      "Names the cause (useThreadShell re-renders rows per token) and that nothing changed yet.",
  },
  {
    id: "long-reply-outcome-at-end",
    source: "Long implementation summary whose outcome is in the last lines",
    reply: `${"Here is what I looked at while working through the settings refactor. ".repeat(60)}

Final result: moved 9 settings from client to server storage, added a one-time migration, and all 212 settings tests pass. PR #418 is open and CI is green.`,
    rubric: "Uses the ending: settings moved to server (9), tests pass, or PR #418 open.",
  },
  {
    id: "control-short-answer",
    source: "Control: a plain short answer with nothing to compress",
    reply: "Yes, `vp run dev --share` prints a pairing URL. Open it in an unpaired browser.",
    rubric:
      "Short, accurate restatement such as 'vp run dev --share prints pairing URL'. No invented work.",
  },
] as const;
