# Contributing to Agentlas Desktop

Thanks for considering a contribution! This project is small and pragmatic — we keep the surface area tight on purpose.

## Quick start

```bash
git clone https://github.com/jeongmk522-netizen/agentlas-desktop.git
cd agentlas-desktop
npm install
npm run dev
```

`npm run dev` runs the Next.js dev server on `:3100` and launches Electron pointing at it. Renderer hot-reloads; main-process changes require restarting `npm run dev`.

## Before opening a PR

1. **Typecheck**: `npm run typecheck` must be clean (electron + renderer both).
2. **Test the change in `npm run dev`**: at minimum, exercise the screen you modified.
3. **Update `i18n.tsx`** if you added user-facing strings — `ko` and `en` both. Never hard-code Korean or English in `aria-label` / `title` / button text.
4. **Don't touch local signing secrets under `signing/`, `build-resources/notarize-creds.json`, or anything under `.env*`.** These are local-only and `.gitignore`'d for a reason.

## Code style

We don't enforce a formatter via CI right now — the prevailing style is just *whatever the file you're editing already does*. A few load-bearing rules:

- **Main vs renderer separation.** Anything that touches the filesystem, OS APIs, or secrets lives under `electron/`. The renderer only talks to it via the IPC bridge in `electron/preload.ts` (typed by `shared/types.ts`).
- **No new top-level dependencies for the renderer** unless they're tiny and tree-shakeable. Bundle size and Electron startup time both matter.
- **Comments explain *why*, not *what*.** If the code obviously does X, don't write "// does X".
- **Inline styles over CSS modules.** The app uses inline `style={{ ... }}` and shared CSS variables (see `renderer/app/globals.css`). Avoid pulling in a CSS-in-JS runtime.

## Areas where help is welcome

- **Windows / Linux ports.** electron-builder configs, NSIS / AppImage / deb, code-signing if you have certificates.
- **Translations.** New locales in `renderer/lib/i18n.tsx` — copy the `ko` block, translate, add to the `Locale` union.
- **MCP integrations.** New runtime adapters under `electron/runtime/`, new agent templates.
- **Accessibility.** Keyboard nav, screen reader labels, focus management.

## Areas where we're picky

- **Surface area.** New top-level pages or major UI patterns — open an issue first to discuss before implementing.
- **Telemetry / analytics.** This app sends nothing to Agentlas servers by default. Any addition of network traffic needs a strong reason and an obvious user opt-out.
- **Credential storage.** macOS Keychain is the only acceptable place. Don't write secrets to disk in any other form.

## License

By submitting a contribution, you agree that it will be licensed under the [Apache License 2.0](LICENSE), the same license as the rest of the project.
