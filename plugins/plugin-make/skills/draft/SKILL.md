---
name: draft
description: Write a normal agentlas.plugin/v2 procedure package into staging.
---

# Steps

1. Create `plugin.json`, a human README, a router skill, one skill per workflow, and a letter-mark icon.
2. Write every file as UTF-8 without a byte-order mark.
3. Add transport integrity hashes for every non-manifest package file.

# Outputs

- A staged plugin package ready for the canonical gate.

# Verification

- The generated manifest parses on its first read.
- The package contains no `.state/` data or credential values.
