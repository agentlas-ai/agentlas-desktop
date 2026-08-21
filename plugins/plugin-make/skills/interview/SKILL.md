---
name: interview
description: Resolve only the plugin decisions that the request leaves open.
---

# Steps

1. Read the request as the seed and preserve its procedure intent without copying private transcripts, files, credentials, or local paths.
2. Resolve an immutable lowercase slug, a one-sentence router description, and one or more workflow names.
3. Confirm the host capabilities, file/network/shell permissions, and whether the plugin keeps state between runs.
4. Respect the user's interview mode: in off mode, draft from the request and show the result for editing.

# Outputs

- A content-free set of builder answers bound to the current conversation.

# Verification

- The slug is safe and immutable for this draft.
- Every workflow has ordered steps, outputs, and a verification check.
- The user-visible limitations say that v1 creates local procedure plugins only.
