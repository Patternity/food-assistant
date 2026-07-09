# Contributing

Thank you for your interest in the Food Assistant research prototype. This is a
**source-available, non-commercial** project (see [`LICENSE`](./LICENSE)) with a
**separate commercial track** owned by Patternity. Because of that dual
structure, contributions are accepted under the inbound terms below.

> Not legal advice. This is a lightweight, early-stage contribution policy. For a
> serious commercial launch, have a professional review it or replace it with a
> full Contributor License Agreement (CLA).

## Inbound contribution terms (please read before opening a PR)

By submitting a contribution (a pull request, patch, or any material) to this
repository, you agree to the following:

1. **You have the right to contribute it.** The work is your own original work,
   or you have the necessary rights, and it does not knowingly infringe anyone
   else's rights. (This mirrors the intent of the
   [Developer Certificate of Origin](https://developercertificate.org/).)

2. **License grant to Patternity.** You grant Patternity a perpetual, worldwide,
   irrevocable, royalty-free, non-exclusive license to use, reproduce, modify,
   distribute, sublicense, and relicense your contribution, **including in both**:
   - the public non-commercial research version (under PolyForm Noncommercial
     1.0.0 or a successor non-commercial license), and
   - **future commercial versions** of Food Assistant offered by Patternity
     under different terms.

3. **You retain copyright** to your contribution. This is a license grant, not an
   assignment; you keep the right to use your own work elsewhere.

4. **No obligation.** Patternity is not obligated to merge, ship, or maintain any
   contribution.

If you do not agree to these terms, please do not submit a contribution.

## How to sign off

Add a `Signed-off-by` line to each commit to certify the above:

```
git commit -s -m "your message"
```

This records agreement with the inbound terms and the DCO-style certification.
For a larger or organization-backed contribution, contact
**patternity.core@proton.me** — a signed CLA may be requested.

## Practical guidelines

- Keep prompts in `prompts/` as versioned text; explain the intent of a prompt
  change in the PR description.
- Do not add real personal data. Example baskets must stay **synthetic** (see
  [`PRIVACY.md`](./PRIVACY.md)).
- Match the existing style: English comments and docs, neutral non-promotional
  tone, small focused changes.
- If a change affects behavior evaluated in [`EVALUATION.md`](./EVALUATION.md),
  note the effect on the day-1 harness output.
