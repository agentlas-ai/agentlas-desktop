# Where this guidance comes from, and how to refresh it

## Sources

- **Apple Human Interface Guidelines** — https://developer.apple.com/design/human-interface-guidelines
  171 guideline pages. © Apple Inc. Referenced here for design review; the text is Apple's.
- **Apple Design resources and awards** — https://developer.apple.com/design/
- **`dickwu/apple-design-skill`** — https://github.com/dickwu/apple-design-skill
  Prior art for the review-protocol shape and the cross-platform translation idea.
  Its bundled guideline copies predate Apple's Liquid Glass revisions, so the guidance
  in this plugin was rebuilt from Apple's current pages rather than copied from it.

## What is committed here, and what is not

Committed (ours): `hig-checklist.md`, `hig-review-protocol.md`, `hig-platform-translation.md`,
`liquid-glass.md`, and the generated `hig-lookup.md` routing table.

Not committed: Apple's page text. It lives in `references/apple-hig/.cache/pages/`, which is
git-ignored and skipped by the plugin packager (a leading dot excludes it from `walkFiles`,
from `copy-builtin-plugins`, and from the integrity manifest). This repository is public and
the guideline text is Apple's copyright — so the plugin ships our derived guidance and reads
Apple's words from a local cache or from Apple directly.

## Refreshing

```bash
node scripts/fetch-apple-hig.mjs     # re-crawl Apple, rewrite the cache and hig-lookup.md
```

Roughly 172 requests at 250 ms apart — about a minute. Re-run it when Apple ships a design
revision (WWDC, and the point releases after it). The routing table's
"Most recently revised by Apple" section is the quickest way to see what moved.

Without the cache the plugin still works: each page is fetchable on demand at
`https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json`.
The human-facing URL returns an empty JavaScript shell, so that JSON is the real source.
