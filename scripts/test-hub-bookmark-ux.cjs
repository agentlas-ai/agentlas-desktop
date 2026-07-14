#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const events = read("renderer/lib/hub-bookmark-events.ts");
const room = read("renderer/components/dashboard/HubBorrowRoom.tsx");
const org = read("renderer/components/dashboard/OrgTree.tsx");
const market = read("renderer/app/(shell)/marketplace/page.tsx");
const sideNav = read("renderer/components/SideNav.tsx");
const chat = read("renderer/app/(shell)/chat/page.tsx");
const chatInput = read("renderer/components/ChatInput.tsx");
const chatStream = read("renderer/components/ChatStream.tsx");
const hubVerification = read("renderer/lib/hub-verification.ts");
const ipcMain = read("electron/ipc.ts");
const bookmarkSync = read("electron/hub-bookmark-sync.ts");
const appShell = read("renderer/components/AppShell.tsx");
const authMain = read("electron/auth.ts");
const electronMain = read("electron/main.ts");
const preload = read("electron/preload.ts");
const accountChip = read("renderer/components/AccountChip.tsx");
const agentGroupsPage = read("renderer/app/(shell)/library/agent-groups/page.tsx");
const agentGroupsStore = read("electron/store/agent-groups.ts");
const marketplaceSource = read("electron/marketplace/mcp-source.ts");

assert.match(events, /agentlas:hub-bookmarks-changed/, "bookmark changes need one renderer event contract");
assert.match(events, /listing\.callable === true/, "Hub call candidates must fail closed unless explicitly callable");
assert.match(events, /hubBookmarksWithoutLocalDuplicates/, "local same-slug agents must win over Hub references");
assert.match(events, /Runtime invocation identity is globally slug-only/, "agent/team slug collisions must document the runtime invariant");
assert.match(events, /ambiguousSlugs/, "agent/team slug collisions must fail closed on call surfaces");
assert.match(events, /hubBookmarkIdentityKey/, "display state must preserve same-slug agent/team composite identities");
assert.match(room, /hubListingIdentityKey\(r\)/, "dashboard Hub cards must use a composite listing identity");
assert.doesNotMatch(room, /bookmarked\.has\(r\.slug\)/, "dashboard bookmark state must not collapse to slug-only");
assert.match(market, /bookmarkedIdentities\.has\(hubListingIdentityKey\(listing\)\)/, "Marketplace cards must use a composite bookmark identity");
assert.doesNotMatch(market, /bookmarkedSlugs/, "Marketplace must not retain a slug-only bookmark state set");
assert.match(
  ipcMain,
  /if \(session\.signedIn\) \{[\s\S]{0,260}broadcastHubBookmarkSnapshot\(\);[\s\S]{0,180}syncHubBookmarks\(\{ rerunIfBusy: true \}\)/,
  "account switch must clear/replace the mounted old-account snapshot before slow network sync",
);
assert.match(bookmarkSync, /const latestContext = currentContext\(\)/, "every trailing pass must reacquire the latest auth context");
assert.match(bookmarkSync, /active\.cookie === candidate\.cookie/, "cookie rotation must invalidate a delayed prior generation");
assert.match(
  read("electron/store/hub-bookmarks.ts"),
  /ambiguousLiveSlugs/,
  "a live agent/team slug collision must fail closed even when only one identity is bookmarked",
);
assert.match(read("electron/store/hub-bookmarks.ts"), /hub_slug_identity_ambiguous/);
assert.match(ipcMain, /bookmarksSync[\s\S]{0,100}rerunIfBusy: true/, "focus/auth lifecycle IPC must request one trailing pass when busy");
assert.match(appShell, /syncQueued[\s\S]{0,220}setTimeout/, "focus and visibility events must coalesce within one UI tick");
assert.match(authMain, /onAuthSessionInvalidated/, "silent auth loss needs a main-owned invalidation event");
assert.match(authMain, /invalidateCachedSession\("server-invalid"\)/, "server rejection must emit the auth boundary");
assert.match(authMain, /invalidateCachedSession\("expired"\)/, "TTL expiry must emit the auth boundary");
assert.match(
  electronMain,
  /onAuthSessionInvalidated\([\s\S]{0,260}failCloseActiveHubBookmarks\(\);[\s\S]{0,180}broadcastHubBookmarkSnapshot\(\);[\s\S]{0,180}broadcastSignedOutSession\(\)/,
  "silent auth loss must fail-close and replace the mounted account slice immediately",
);
assert.match(preload, /onSessionChanged:[\s\S]{0,220}auth:sessionChanged/, "renderer needs a typed silent-auth notification");
assert.match(accountChip, /api\.auth\.onSessionChanged/, "account UI must not stay signed in after silent expiry");
assert.match(room, /announceHubBookmarkChange\(\{ action: "added", bookmark \}\)/, "dashboard bookmark must publish immediately");
assert.match(market, /announceHubBookmarkChange\(\{ action: "added", bookmark \}\)/, "Hub page bookmark must publish immediately");
assert.match(org, /onHubBookmarkChange/, "OrgTree must subscribe to bookmark changes");
assert.match(org, /setHubBookmarks\(\(previous\) => \[/, "OrgTree needs optimistic same-frame state");
assert.match(org, /setMode\(classifyHubEntity\(change\.bookmark\.listing\) === "multi" \? "multi" : "single"\)/, "OrgTree must reveal the matching entity mode");
assert.match(org, /setOpenCats\(\(previous\) => \(\{ \.\.\.previous, hub: true \}\)\)/, "OrgTree must open the Hub source");
assert.match(org, /hubBookmarkGenerationRef/, "OrgTree bookmark reads need a stale-response generation guard");
assert.match(org, /void refreshHubBookmarks\(\);/, "OrgTree must reconcile only the durable bookmark slice");
assert.doesNotMatch(org, /Reconcile the optimistic[\s\S]{0,240}void load\(\);/, "bookmark events must not trigger a stale full-roster reload");

assert.match(chat, /api\.marketplace\.bookmarks\(\)/, "chat metadata must load saved Hub bookmarks");
assert.match(chat, /hubBookmarkGenerationRef/, "chat bookmark reads need a stale-response generation guard");
assert.match(
  chat,
  /!cancelled && hubBookmarkGenerationRef\.current === bookmarkGeneration/,
  "late or unmounted chat snapshots must not erase a bookmark event",
);
assert.match(chat, /void refreshHubBookmarks\(\);/, "chat bookmark events must reconcile only the durable bookmark slice");
assert.match(
  chat,
  /api\.marketplace\.bookmarks\(\)\.then\([\s\S]{0,220}setHubBookmarks\(bookmarks\)[\s\S]{0,80}\.catch\(\(\) => undefined\)/,
  "chat bookmark read failures must preserve the last known state",
);
assert.match(chat, /hubBookmarks,/, "chat must pass Hub bookmarks to its context surfaces");
assert.match(chat, /onCallHubAgents=\{hireAgents\}/, "chat selection must bind Hub slugs to the borrowed roster");
assert.match(chat, /hiredAgentsRef\.current\.map\(\(card\) => card\.slug\)/, "send must use the latest optimistic borrowed roster");
assert.match(chat, /hiredPersistChainRef\.current/, "consecutive borrowed-roster writes must be serialized");
assert.match(chat, /api\.chats\.get\(targetChatId\)/, "a failed roster write must reconcile from durable chat state");
assert.match(chatInput, /group: locale === "en" \? "Hub bookmarks" : "Hub 북마크"/, "@ autocomplete must expose Hub bookmarks separately");
assert.match(chatInput, /callableHubBookmarks\(context\.hubBookmarks \?\? \[\], context\.agents\)/, "@ autocomplete must exclude install-only and local-duplicate Hub bookmarks");
assert.match(chatInput, /borrowAgentSlug: bookmark\.slug/, "Hub autocomplete must carry a callable slug");
assert.match(chatInput, /onCallHubAgents\(\[opt\.borrowAgentSlug\]\)/, "@Hub selection must bind the borrowed agent");
assert.match(chatInput, /const hubSlugs = \[\.\.\.selectedAgentIds\]/, "agent picker must split Hub references from local IDs");
assert.match(chatInput, /badge="Hub"/, "Hub references must not look installed or owned");

assert.doesNotMatch(chatStream, /id: "apps", title: t\("chatstream\.empty_section\.apps"\)/, "fixed bundled Apps should not occupy the personalized empty state");
assert.match(chatStream, /hubBookmarksWithoutLocalDuplicates\(directory\.hubBookmarks, directory\.agents\)\.slice\(0, 2\)/, "empty chat context must include saved non-duplicate Hub references");
assert.match(chatStream, /sections\.length > 0/, "empty context panel should disappear when it has no personalized content");

assert.match(sideNav, /setTimeout\(\(\) => \{[\s\S]*?api\.marketplace[\s\S]*?\.search\(q\)/, "global Hub search must autocomplete without submit");
assert.match(sideNav, /role="combobox"/, "global Hub search needs combobox semantics");
assert.match(sideNav, /role="listbox"/, "global Hub search needs suggestion list semantics");
assert.match(sideNav, /nativeEvent\.isComposing/, "global Hub search must not hijack Korean IME composition");
assert.match(sideNav, /searchGenerationRef\.current !== generation/, "late autocomplete responses must not overwrite the latest query");
assert.match(sideNav, /searchSuggestionQuery === currentSearchQuery/, "rendered suggestions must be tagged to the current query");
assert.match(market, /id="desktop-hub-search-suggestions"/, "Hub page needs visible autocomplete suggestions");
assert.match(market, /hubSuggestions\.length/, "Hub page autocomplete must derive from live filtered results");
assert.match(hubVerification, /static security scan result, not a creator reputation or user rating/, "security grade must not masquerade as creator reputation");
assert.match(hubVerification, /listing\.callable === true[\s\S]*listing\.kind === "cloud-callable"/, "Hub command chips must fail closed on explicit callability");
assert.match(market, /hubVerificationFacts\(listing, locale\)/, "Hub cards must render measured invocation facts");
assert.match(market, /24시간 사용 · \$\{perCallCredits\} 크레딧/, "Hub cards must explain the paid 24-hour usage term, not show an unexplained credit number");
assert.match(market, /같은 이름의 로컬 에이전트 있음/, "a same-name local agent must not masquerade as owned Hub access");
assert.doesNotMatch(market, /\{ko \? "보유" : "Owned"\}/, "Hub cards must not label a same-slug local agent as owned Hub access");
assert.match(market, /채팅에 붙여넣기/, "callable Hub cards need a human action instead of exposing only an internal call command");
assert.doesNotMatch(market, />Trust \{/, "Hub cards must not present the package scan grade as generic Trust reputation");
assert.match(room, /hubSecurityGradeLabel\(r, locale\)/, "Dashboard Hub cards must name the security scan honestly");
assert.match(room, /data-callable=\{callable \? "true" : "false"\}/, "Dashboard Hub cards must expose callable versus install-only state");
assert.match(agentGroupsPage, /hubEntityKind,/, "Agent Group drafts must persist the selected Hub entity namespace");
assert.match(agentGroupsPage, /callableHubBookmarks\(hubBookmarks, agents\)/, "Agent Group sources must hide non-callable and same-slug ambiguous Hub bookmarks");
assert.match(agentGroupsStore, /listing\.callable !== true \|\| listing\.kind === "install-only" \|\| listing\.routingReady === false/, "Agent Group runtime must fail closed on non-callable Hub listings");
assert.match(agentGroupsStore, /hubEntityKindForMember/, "Agent Group storage and resolution must retain Hub entity identity");
assert.match(agentGroupsStore, /if \(candidates\.length > 1\) return null/, "slug-only Hub invocation must reject same-slug agent/team ambiguity");
assert.match(marketplaceSource, /const byIdentity = new Map<string, MarketplaceListing>\(\)/, "Marketplace source dedupe must preserve same-slug agent/team listings");

console.log("test-hub-bookmark-ux: PASS");
