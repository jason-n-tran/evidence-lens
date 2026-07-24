# @evidencelens/contracts

Frozen inter-service contracts for EvidenceLens. This directory is **generated**
by `buf generate` from [`proto/evidencelens/v1/`](../../evidencelens/v1/).

The package is consumed by all TypeScript workspaces (`gateway`, `mcp-server`,
`frontend`, `workers/*`) via the npm workspace import:

```ts
import type { Document, ScoredResult } from "@evidencelens/contracts";
import type { ClickEvent } from "@evidencelens/contracts/events";
```

## Contents (after `buf generate`)

- `evidencelens/v1/document.ts` — `Document`, `Author`, `AuthorPayment`, `Journal`, `StudyType`, `Trial`, `Regulatory`, `FundingSource`
- `evidencelens/v1/events.ts` — `RawDocEvent`, `IndexableDocEvent`, `RecallEvent`, `ClickEvent`
- `evidencelens/v1/scorer.ts` — `SearchRequest`, `PartialResults`, `ScoredResult`, `ScoreBreakdown`, gRPC client/server stubs
- `evidencelens/v1/embedder.ts` — `EmbedRequest`, `EmbedResponse`, gRPC client/server stubs
- `index.ts` — re-exports the common surface
- `schema.graphql` — copy of [gateway/src/schema.graphql](../../../gateway/src/schema.graphql) for client codegen

## Versioning

Pinned at `1.0.0` for the contracts freeze. Breaking changes bump major (and
require an `rfc-interface` PR per [docs/rfcs/README.md](../../../docs/rfcs/README.md)).
Additive changes bump minor.

## Regeneration

Do not edit generated files by hand. To regenerate:

```bash
cd proto && buf lint && buf generate
```
