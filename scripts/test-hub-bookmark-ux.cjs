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

assert.match(events, /agentlas:hub-bookmarks-changed/, "bookmark changes need one renderer event contract");
assert.match(events, /listing\.callable === true/, "Hub call candidates must fail closed unless explicitly callable");
assert.match(events, /hubBookmarksWithoutLocalDuplicates/, "local same-slug agents must win over Hub references");
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
assert.match(chat, /bookmarks && hubBookmarkGenerationRef\.current === bookmarkGeneration/, "late chat snapshots must not erase a bookmark event");
assert.match(chat, /void refreshHubBookmarks\(\);/, "chat bookmark events must reconcile only the durable bookmark slice");
assert.match(chat, /catch\(\(\) => null as HubAgentBookmark\[\] \| null\)/, "chat bookmark read failures must preserve the last known state");
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

console.log("test-hub-bookmark-ux: PASS");
