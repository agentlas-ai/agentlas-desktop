# Agentlas Desktop Public macOS Release

Public downloads stay closed until both DMGs are Developer ID signed, Apple notarized, and Gatekeeper accepted.

## 1. Create The Apple Certificate

Required certificate type: **Developer ID Application**.

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

If you prefer Keychain Access:

1. Keychain Access > Certificate Assistant > Request a Certificate From a Certificate Authority.
2. Save the CSR to disk.
5. Download the `.cer` file and double-click it to import into the login keychain.
6. Confirm the identity exists:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
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

```bash
npm run release:readiness
AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac
npm run release:mac:verify
npm run release:mac:publish
npm run release:web-env -- --apply
```

The last command writes the verified release metadata to Railway production so:

- `GET /api/desktop/latest` returns `ready:true`.
- `GET /api/desktop/download?arch=arm64|x64` redirects to GitHub Release DMGs.

## 4. GitHub Actions Release

There are two release workflows, by design:

1. **`.github/workflows/release.yml` (active, default).** Windows/Linux preview
   release, **unsigned**, uses only the built-in `GITHUB_TOKEN`. macOS is
   intentionally excluded from this workflow so an unsigned DMG cannot replace
   the signed/notarized public Mac channel. Trigger it by pushing a tag:

   ```bash
   # bump package.json "version" to match, then:
   git tag v0.0.3 && git push origin v0.0.3
   ```

   Artifacts uploaded to the release: Windows installers/portable executable,
   Linux AppImage/deb, plus the Windows/Linux auto-update feeds.

2. **Signed + notarized macOS.** Use the local `signing/` folder with
   `AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac`, then
   `npm run release:mac:publish`. For CI, install `docs/release.workflow.yml` as
   `.github/workflows/release-signed-mac.yml` only from an account or token with
   GitHub `workflow` permission, once the Apple certificate secrets below are
   configured.

Required GitHub secrets for the **signed macOS** workflow on `agentlas-ai/agentlas-desktop`:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `MAC_DEVELOPER_ID_CERTIFICATE`
- `MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD`
- `AGENTLAS_DESKTOP_RELEASE_TOKEN`
- `RAILWAY_TOKEN`
- `RAILWAY_PROJECT_ID`

`MAC_DEVELOPER_ID_CERTIFICATE` must be a base64-encoded `.p12` containing the `Developer ID Application` certificate and its private key.

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
  -c "Developer ID Application"
base64 -i /tmp/agentlas-developer-id.p12 | gh secret set MAC_DEVELOPER_ID_CERTIFICATE -R agentlas-ai/agentlas-desktop -b-
printf "%s" "$P12_PASSWORD" | gh secret set MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD -R agentlas-ai/agentlas-desktop -b-
rm -f /tmp/agentlas-developer-id.p12
```

Then set the remaining secrets and run:

```bash
gh workflow run release-signed-mac.yml \
  -R agentlas-ai/agentlas-desktop \
  -f version=0.0.3 \
  -f tag=v0.0.3 \
  -f draft=false \
  -f apply_web_env=true
```

## 5. Verification

After release:

```bash
curl https://agentlas.cloud/api/desktop/latest
curl -I "https://agentlas.cloud/api/desktop/download?arch=arm64"
npm run qa:committee -- --all --web-base=https://agentlas.cloud
```

The 25-persona gate must report `releaseUnanimous: true`.
