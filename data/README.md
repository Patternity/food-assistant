# Example data

`example-baskets/` contains **synthetic, non-personal** grocery baskets used by
the day-1 evaluation harness (`npm run eval`) and for manual testing.

Each file:

```json
{
  "id": "short-id",
  "source_type": "text | receipt_text",
  "text": "the raw basket / receipt as a user might paste it",
  "expect": { "basket_kind": "...", "notes": "what a good answer should and should not do" }
}
```

`expect` is a human-judged reference, not an automated assertion — the harness
prints predictions next to it so a person can compare (see
[`../EVALUATION.md`](../EVALUATION.md)).

Do not add real personal purchases here. Keep all fixtures synthetic (see
[`../PRIVACY.md`](../PRIVACY.md)).

`uploads/` (git-ignored) is where the local app may write runtime uploads; it is
never committed.
