# Agentlas Reach

Reach turns the apps installed on this computer into something an agent can use.

1. **Map.** In the background, Agentlas lists the installed apps and reads what each one publishes about itself first: AppleScript dictionaries on macOS, package manifests on Windows, desktop entries and D-Bus names on Linux. Each app is drawn as green (scriptable), amber (partly known) or gray (not yet mapped).
2. **Use.** `reach.map`, `reach.app`, `reach.describe` and `reach.invoke` (harness operations, the same in One, Work, the personal agent, Finance and Science) find an app's capability and carry it out with typed values. A script command runs through the app's own scripting interface; an explored capability drives the app's menu and dialog on screen through the Cua Driver.
3. **Explore (opt-in).** With *Settings → Explore this desktop's apps* on, Agentlas opens the partly known apps' dialogs while the owner is away, reads and closes them, and turns what works into capabilities. Everything stays on this computer unless verified, anonymous capability descriptions are shared.

Reach opens nothing it was not asked to, never types into a dialog during exploration, and keeps apps with credentials, money, messages or system settings off limits.

State lives under `.state/` in the installed plugin directory and survives updates.
