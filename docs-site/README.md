# Developer docs site (source content)

Version-controlled content for **[docs.metagraph.sh](https://docs.metagraph.sh)** — the first-party developer docs site tracked in [#1652](https://github.com/JSONbored/metagraphed/issues/1652).

Rendering and the interactive API playground UI live in [metagraphed-ui](https://github.com/JSONbored/metagraphed-ui); **this directory is the content + auto-generation source** in the backend repo.

## Layout

```text
docs-site/
  meta.json                 # site manifest (nav, contract version, stats)
  guides/                   # hand-written markdown (edit in PRs)
  generated/                # auto-generated — do not hand-edit
    api-reference.md        # from openapi.json + api-index.json
    api-playground.json     # structured try-it metadata for the UI
    catalog.md              # from registry/subnets/
    resources.md            # MCP tools + agent/MCP/skill URLs
```

## Regenerate

```bash
npm run docs-site:generate      # write generated/
npm run validate:docs-site        # CI freshness gate (--check)
```

Run `docs-site:generate` after changing `schemas/` (→ openapi), `public/metagraph/api-index.json`, or `registry/subnets/`, then commit the updated `docs-site/generated/` files and `meta.json`.

`npm run validate:docs-site` runs in CI **before** `npm run build` so it checks the committed docs against the committed contract sources — `npm run build` does not regenerate `docs-site/` (same discipline as the README catalog).

Hand-written guides under `guides/` are edited directly — they are not overwritten by the generator.

## For reviewers (slop / review load)

Most PR diff lines under `generated/` are **deterministic output**, not hand-edited prose. The meaningful surface is the generator (`scripts/generate-docs-site.mjs`), guides, and `tests/docs-site.test.mjs`. No public API contract change unless `schemas/` or `public/metagraph/*` also changed.

```bash
npm test -- tests/docs-site.test.mjs
npm run validate:docs-site
```
