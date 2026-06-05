# Agentlas Cloud Agent Framework

Agentlas Cloud agent publishing is a submitter-paid local flow.

## Cost Boundary

- Packaging runs on the submitter machine from the terminal or Desktop app.
- Static security review always runs locally and has no model cost.
- Optional LLM review uses only the submitter's active local runtime: CLI subscription, BYOK API key, Ollama, or another configured local runtime.
- Agentlas Cloud must not call a platform-owned LLM to package, review, or approve marketplace agents.

## Terminal Flow

```bash
agentlas cloud package ./my-agent
agentlas cloud publish ./my-agent --dry-run
agentlas cloud publish ./my-agent --llm-review
agentlas cloud install seo-writer
```

`--llm-review` is opt-in. Without it, `publish` still performs local static security review before registration.

## Desktop Flow

Open `Cloud publish` in the sidebar, choose a local agent/team folder, pick `Static review` or `Local LLM review`, then run a dry-run or publish.

## Registration Contract

The client sends `POST /api/cloud-agents/v1/register` with:

- `manifest`: slug, package hash, runtime labels, visibility, file counts, security verdict.
- `bundle`: included text files with SHA-256 hashes and base64 content.
- `review`: static findings plus optional submitter-local runtime findings.
- `billing`: `modelCallsPaidBy` is `none` for static review or `submitter` for local-runtime review.

The server stores and distributes the package. It should verify the package hash and reject manifests whose review evidence claims `modelCallsPaidBy: platform`.

Current server behavior:

- Requires an authenticated workspace write session.
- Recomputes every file SHA-256 and the full package hash.
- Runs a server-side static secret/path scan before storing.
- Rejects `fail` reviews, blocker findings, and any platform-paid review claim.
- Stores approved packages as existing marketplace `ScanManifest` + `PublicProfile` records with a `cloudPackage` file payload.

## Download / Install Contract

`marketplace.get_manifest` includes `cloudPackage` for approved cloud agents. Desktop and CLI verify each file hash, restore the package into a local agent folder, and then install the agent manifest.

- Desktop restores to its local `agents/<slug>` folder and routes the installed agent to that folder.
- CLI restores to `cloud-agent-installs/<slug>` under Agentlas user data.
- User secrets are never downloaded; users configure their own keys through Agentlas env/BYOK storage.

## Security Gates

Static review blocks:

- `.env`, key, pem, p12, credential, service-account, and similar secret file names.
- Private key material, common API token patterns, and hard-coded `api_key` / `secret` / `token` / `password` values.
- Symlinks.
- Missing root agent definition files.
- Oversized packages.

High-risk findings such as `curl | sh` are allowed only as `needs-review` evidence unless a blocker also exists.
