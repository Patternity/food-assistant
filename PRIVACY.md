# Privacy

This document describes data handling for the **local single-user alpha** in
this repository. It is not the privacy policy of any hosted or commercial
service.

## Scope

This prototype is designed to run **locally, for a single user**. There is no
account system, no authentication, and no multi-user separation.

## What data exists

- **Uploaded images** (basket screenshots, receipts) — processed to extract a
  product list.
- **Text notes, questions, and recipes** you type.
- **Derived text** (extracted product lists, evaluations, suggestions).

The bundled example data in `data/example-baskets/` is **synthetic and
non-personal** — it does not describe any real person's purchases.

## Where data goes

- The prototype sends your inputs (text and, for image analysis, image content)
  to the **configured LLM provider** (`LLM_BASE_URL`) to produce a response.
  That third-party provider processes the content under **its own terms and
  privacy policy**. Review them before uploading anything sensitive.
- Receipts and baskets can contain personal or sensitive details (names, loyalty
  IDs, addresses, payment fragments). Prefer to crop or redact such fields before
  upload. Treat anything you upload as disclosed to the model provider.

## Local persistence

The day-1 sandbox is intentionally **stateless**: it does not persist your
uploads or build a memory profile. Any future memory features MUST:

- store data locally by default;
- keep raw images out of version control (`.gitignore` already excludes
  `data/uploads/` and local databases);
- provide a clear way to delete stored data.

## Not included in this alpha

- No analytics, telemetry, or tracking.
- No sharing of data between users (there is only one user).
- No cloud storage.

## Commercial track

The commercial service handles multi-user data, subscriptions, and hosted
storage under a separate, private codebase and a separate privacy policy. This
document does not govern it.

> Not legal advice. Before any hosted or commercial launch, have a qualified
> professional prepare a privacy policy appropriate to your jurisdiction and to
> the LLM provider agreements in use.
