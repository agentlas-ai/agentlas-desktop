---
name: install
description: Install or update a verified local plugin while preserving user state.
---

# Steps

1. Refuse installation if the latest gate report is not clean.
2. Copy the verified package to the shared Agentlas plugin home.
3. Write the host-owned install receipt and leave `.state/` untouched during updates.

# Outputs

- An install receipt with the target slug, verification result, and manifest hash.

# Verification

- The target contains the verified package files and `.install.json`.
- Existing `.state/` files are byte-for-byte preserved.
