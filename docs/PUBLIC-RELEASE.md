# Agentlas Desktop Public macOS Release

Public downloads stay closed until both DMGs are signed by the exact official
identity `Developer ID Application: Jeongmin Kim (F469CGM7T5)`, Apple
notarized, and Gatekeeper accepted.

## 1. Create The Apple Certificate

Required certificate identity: **Developer ID Application: Jeongmin Kim
(F469CGM7T5)**. Team ID: **F469CGM7T5**.

Current local certificates like `Apple Development`, `Apple Distribution`, or `iPhone Developer` are not enough for public `.dmg` distribution outside the Mac App Store.

1. Create the CSR:

```bash
npm run release:csr -- --email=you@example.com
```

2. Open Apple Developer > Certificates, Identifiers & Profiles > Certificates.
3. Create a new certificate.
4. Choose `Developer ID Application`.
5. Upload `signing/agentlas-developer-id.csr`.
6. Download the `.cer` file.
7. Convert it to a `.p12` for electron-builder:

```bash
npm run release:p12 -- --cer=/path/to/developerID_application.cer
```

The `.p12`, private key, app-specific password, and local signing notes stay in
ignored `signing/`. Only `signing/README.md` is committed so future agents know
where release signing material lives.

The broader release credential contract is tracked in
`.agentlas/release-credentials.map.json`. It is intentionally non-secret: it
lists credential names, storage homes, and validation commands only.

That `.agentlas` map is the Agentlas Desktop release credential source of
truth. AppBridge architecture sync may reference it, but AppBridge must not hold
raw Apple, GitHub, or Railway release secrets.

If you prefer Keychain Access:

1. Keychain Access > Certificate Assistant > Request a Certificate From a Certificate Authority.
2. Save the CSR to disk.
5. Download the `.cer` file and double-click it to import into the login keychain.
6. Confirm the identity exists:

```bash
security find-identity -v -p codesigning | grep -F "Developer ID Application: Jeongmin Kim (F469CGM7T5)"
```

## 2. Create Notarization Credentials

Create an app-specific password for the Apple ID used by the developer team.
For local releases, either store a `notarytool` keychain profile named
`agentlas-notary`, or set these environment variables in your shell:

```bash
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
GH_TOKEN
```

The release scripts automatically read local certificate defaults from
`signing/`. Override the folder with `AGENTLAS_SIGNING_DIR=/path/to/signing`.

## 3. Local End-To-End Release

For the current source candidate, verify the local hybrid-memory, executable
Storm, updater-trust, and packaged-install contracts before creating a tag. The
three focused tests exercise the bundled Model2Vec asset, Desktop/Core vector
parity, per-turn adaptive retrieval, per-agent nest projection, and the real
Core query path:

```bash
npm run typecheck
npm run test:model2vec-hybrid-parity
npm run test:memory-hybrid-retrieval
npm run test:curator-nest-core-query
npm run test:experience-relations
npm run test:updater-production
npm run test:updater-ui
npm run test:stormbreaker-swarm
node scripts/test-packaged-updater-install-e2e.cjs --selftest
```

The two builder configs also run `build-resources/after-pack-clean.cjs`. A
package fails before signing/publication unless its embedded
`potion-base-8M-int8` manifest, tokenizer, license, int8 table, scales, file
sizes, and content hashes exactly match the pinned Agentlas OS checkout.

```bash
npm run release:readiness
npm run release:railway:check -- --environment=production --service=agentlas-web
AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac
npm run release:mac:verify
npm run release:mac:publish -- --draft
```

The local publisher is deliberately private-draft only. Stable/latest promotion
and the production Railway update are owned by the exact-source GitHub Actions
writer, which refuses stable publication unless exact production Railway access
has already passed. After that writer applies the verified metadata:

- `GET /api/desktop/latest` returns `ready:true`.
- `GET /api/desktop/download?arch=arm64|x64` redirects to GitHub Release DMGs.

## 4. GitHub Actions Release

The release is deliberately split across two workflow files. A stable tag push
starts the signed macOS orchestrator, which invokes the reusable Windows/Linux
build barrier while its macOS preflight runs in parallel; a branch push does not
publish anything. Manual dispatch is a rerun path, not a way to release an
untagged branch: the requested tag must already exist, the checkout must equal
that tag's commit, and all three version fields (`package.json`, lockfile root,
and lockfile package) must match it.

The reusable build, signed workflow, and final Mac publisher accept stable
`vMAJOR.MINOR.PATCH` tags only. Prerelease suffixes are rejected so a beta/RC
can never be promoted to the public `latest` channel by this pipeline.

The embedded Agentlas OS ref and full commit must also agree across
`package.json`, both release workflows, the three-OS harness, and the updater
contract. `ensure:engine` fetches the ref immediately before packaging and
rejects it if the resolved commit differs from the immutable pin. Treat that as
a release blocker: synchronize and reverify every pin from an approved Core
commit; never bypass the moved-tag check or package an ambient checkout.

1. **.github/workflows/release.yml (Windows/Linux build barrier).** It runs
   the security, migration, updater, Memory/Experience, executable Desktop
   Storm, and packaging gates,
   then emits unsigned Windows and Linux installers plus their feeds as
   short-lived Actions artifacts only. The native updater lifecycle job starts
   from the digest-pinned public v0.8.32 NSIS/AppImage binaries, points only a
   disposable installed/extracted copy at the private loopback feed, installs
   the exact candidate artifact, and verifies that the resulting app rejoins
   the official feed. It has no public-release write token and cannot create,
   edit, or promote a release. macOS is intentionally excluded so an unsigned
   DMG cannot replace the signed/notarized Mac channel.

   ```bash
   # after version, runtime pins, focused tests, and release notes agree:
   git push origin main
   git tag -a v0.8.61 -m "Agentlas Desktop v0.8.61"
   git push origin v0.8.61
   ```

   The workflows enforce tag/checkout identity but do not prove that the tagged
   commit is reachable from origin/main; pushing the reviewed main commit first
   is the operator-side source-publication contract.

2. **.github/workflows/release-signed-mac.yml (single writer and
   promotion).** It waits for the all-OS artifact barrier, builds, Developer ID
   signs, notarizes, staples, and verifies macOS arm64/x64 DMG/ZIP artifacts,
   then downloads every barrier artifact into one release directory. Before its
   first public write it validates the exact full installer/feed/evidence
   manifest. Windows/Linux feeds must bind every declared auto-update artifact
   to its computed SHA-512 and byte size, while the macOS lineage gate verifies
   both ZIP architectures. The production-rendered updater recovery UI also
   runs in the PR/main harness and the signed macOS preflight. The sole
   publisher uploads that entire set to the separate releases repository,
   downloads every staged public asset again, compares bytes and the
   source-bound macOS verification record, and only then may clear draft and
   prerelease state and assert stable/latest. Missing, renamed, partial, or
   byte-different artifacts fail closed. With `draft=true`, authenticated
   remote byte verification still runs but the complete release remains private
   and cannot become `latest`. Manual runs require explicit version and tag;
   `draft` defaults to false and `apply_web_env` defaults to true. Tag pushes do
   not publish; the release workflow is manual-only.

   docs/release.workflow.yml is only a pointer to this active file and must not
   be copied over it. Local signing can prepare and remotely verify a private
   draft with AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac followed by
   npm run release:mac:publish -- --draft, but cannot create stable/latest or
   mutate the production web feed.

Required for the **signed macOS workflow and its single public writer** on
`agentlas-ai/agentlas-desktop`:

- `AGENTLAS_DESKTOP_RELEASE_TOKEN` — preferably a fine-grained token limited to
  Contents write on `agentlas-ai/agentlas-desktop-releases`

Additional secrets required for the **signed macOS** workflow:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `MAC_DEVELOPER_ID_CERTIFICATE`
- `MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD`

Required whenever `apply_web_env=true`:

- `RAILWAY_TOKEN`
- `RAILWAY_PROJECT_ID`

`MAC_DEVELOPER_ID_CERTIFICATE` must be a base64-encoded `.p12` containing the
exact `Developer ID Application: Jeongmin Kim (F469CGM7T5)` certificate and its
private key. A different Developer ID certificate, including one from the same
Apple team, is rejected.

`RAILWAY_TOKEN` must be valid for the Railway project that contains
`agentlas-web` in the `production` environment. A secret with the right name is
not enough. When `apply_web_env=true`, the release workflow checks access before
signing starts and fails before any public release write if Railway access is
missing or invalid. `apply_web_env=false` is allowed only for a private
`draft=true` run; stable/latest publication always requires the production web
write and full served-DMG verification.

Do not copy the local Railway CLI `user.token` from `~/.railway/config.json`
into GitHub Actions. That token can support an interactive local CLI login while
still failing as `RAILWAY_TOKEN` in CI. Use a Railway token that works when
passed through the `RAILWAY_TOKEN` environment variable and verify it with:

```bash
RAILWAY_TOKEN=... RAILWAY_PROJECT_ID=... \
  npm run release:railway:check -- --project="$RAILWAY_PROJECT_ID" --environment=production --service=agentlas-web
```

If you used `release:csr` and `release:p12`, set certificate secrets directly:

```bash
npm run release:p12 -- --cer=/path/to/developerID_application.cer --set-github-secrets
```

If you used Keychain Access, create it from a Mac that has the identity:

```bash
P12_PASSWORD="$(openssl rand -base64 24)"
security export \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  -t identities \
  -f pkcs12 \
  -o /tmp/agentlas-developer-id.p12 \
  -P "$P12_PASSWORD" \
  -c "Developer ID Application: Jeongmin Kim (F469CGM7T5)"
base64 -i /tmp/agentlas-developer-id.p12 | gh secret set MAC_DEVELOPER_ID_CERTIFICATE -R agentlas-ai/agentlas-desktop -b-
printf "%s" "$P12_PASSWORD" | gh secret set MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD -R agentlas-ai/agentlas-desktop -b-
rm -f /tmp/agentlas-developer-id.p12
```

Then set the remaining secrets and run:

```bash
gh workflow run release-signed-mac.yml \
  -R agentlas-ai/agentlas-desktop \
  -f version=0.8.61 \
  -f tag=v0.8.61 \
  -f draft=false \
  -f apply_web_env=true
```

Tag-triggered GitHub Actions runs use the workflow file from the tagged commit.
If the release workflow is fixed after a tag was pushed, rerun the workflow from
`main` with `workflow_dispatch` or create the next tag after the workflow fix.

## 5. Verification

After release:

```bash
curl https://agentlas.cloud/api/desktop/latest
curl -I "https://agentlas.cloud/api/desktop/download?arch=arm64"
npm run qa:committee -- --all --web-base=https://agentlas.cloud
```

The 25-persona gate must report `releaseUnanimous: true`.
