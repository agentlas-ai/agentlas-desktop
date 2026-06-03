# Agentlas Desktop Signing

This folder is the local, AI-visible map for macOS release signing material.

Only this README should be committed. The actual signing files are ignored by
Git and stay local:

- `agentlas-developer-id.p12`
- `agentlas-developer-id.p12.password`
- `agentlas-developer-id.key`
- `agentlas-developer-id.csr`
- `agentlas-developer-id.pem`
- `apple-app-specific-password`

Release scripts use this folder by default. Override it with
`AGENTLAS_SIGNING_DIR=/path/to/signing` when needed.

Useful commands:

```bash
npm run release:readiness
AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac
npm run release:mac:publish -- --tag=v0.2.8 --version=0.2.8
npm run release:web-env -- --apply
```
