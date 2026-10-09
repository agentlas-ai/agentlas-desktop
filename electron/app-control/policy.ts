import type { AppControlCatalogEntry } from "./catalog.generated";

// What One may do through the app-control route. Every catalog operation lands in exactly one class:
//   read / write          any One turn
//   destructive / consent only a turn the owner wrote. A review or check-in turn reads workers' output, which is data,
//                         not the owner's word; deleting, installing, publishing, sending or answering waits for the owner.
//   denied                never: the owner's own consent boundary (approvals, grants, credentials, payment), views and
//                         streams that belong to a screen, and One's own run plumbing (it has dedicated tools).
export type AppControlEffect = "read" | "write" | "destructive" | "consent";
export type AppControlPolicy =
  | { allowed: true; effect: AppControlEffect }
  | { allowed: false; reason: string };

const DENIED: Array<[RegExp, string]> = [
  // The owner's consent boundary. One granting itself (or a worker) permission would be self-escalation.
  [/^(resolveToolApproval|grantChatAlwaysApproval|revokeChatAlwaysApproval|revokeCapabilityGrant)$/, "approvals and grants are the owner's decision"],
  [/^confirm\./, "the owner answers questions agents ask"],
  [/^(surfaces\.(approve|revokeApproval)|automations\.decideNodeApproval|browser\.resolveApproval|experience\.hubResolveAttach)$/, "approvals are the owner's decision"],
  [/^(computerHistory\.setConsent|browser\.(credentialConsent|revokeCredentialConsent))$/, "consent is the owner's own act"],
  [/^science\.(toolApprovals\.(resolve|setAlwaysApproved)|approvalPolicy\.set|questions\.answer|journals\.(confirmHumanAttestation|confirmIdentity))$/, "Science approvals, attestations and answers are the owner's own act"],
  // Credentials, sign-in and money.
  [/^(secrets|env|auth|billing|browserAutofill|browserProfileImport|credentialRecovery)\./, "credentials, keys and sign-in stay with the owner"],
  [/^(browser\.(importCredentials|refreshCredentials|scanCredentials|openLogin)|workLiveView\.importBrowserCookies)$/, "credentials and sign-in stay with the owner"],
  [/^(mcpTools\.(supplyRunKeys|oauth\w+)|site\.(savePublishProviderToken|removePublishProviderToken|connectPublishProvider|openPublishProviderPage))$/, "credentials and sign-in stay with the owner"],
  [/^(hephaestus\.coreAuthLogin|runtime\.(openCliLogin|connectStart|connectCancel|connectGet)|mobileBridge\.issuePairing)$/, "sign-in and device pairing stay with the owner"],
  [/^(agentLeases\.purchase|cloudAgents\.setPrices|appFactory\.(approveProviderPayment|resolveProviderCredentials|captureProviderBrowserSessions|launchProviderBrowserSession|openProviderBrowser))$/, "payments, prices and provider accounts stay with the owner"],
  // One's own run plumbing: it has dedicated tools for these.
  [/^(invoke|oneSupervisor|oneHarness|oneWindow|oneContext|workStart|oneTeamPreflight|attention)\./, "One's own conversation plumbing; use the one_supervisor_* / one_team_* tools"],
  [/^chats\.appendOneUserMessage$/, "never write a message as the owner"],
  [/^science\.composer\./, "use one_supervisor_start_science / one_supervisor_control to work in Science"],
  // Views, live frames, watchers and leases belong to a screen that opened them.
  [/^(workLiveView|browserUi|browserAnnotation)\./, "operates a browser view on the owner's screen"],
  [/^(browser\.(startLiveView|stopLiveView|captureLiveFrame|captureTaskFrame|dispatchLiveInput|focusLiveTarget)|fs\.(watchFile|unwatchFile))$/, "belongs to a screen's live view"],
  [/^(marketplace\.(openProfileView|closeProfileView|setProfileViewBounds)|productExtensions\.(openScienceView|closeScienceView|setScienceViewBounds)|appFactory\.(startLivePreview|stopLivePreview|releaseLivePreview))$/, "belongs to a screen's live view"],
  [/^science\.(renderers\.|researcherQuestions\.register$|shell\.backToWork$|artifacts\.capture$)/, "belongs to the Science view on screen"],
  // App lifecycle: it would end this very turn.
  [/^updater\.install$/, "installing an update restarts the app and ends this turn; ask the owner to press Install"],
  [/^menu\.setLocale$/, "use app.setLanguage"],
];

const CONSENT_SEGMENT = /^(approve|answer|decide|accept|reject|attest|confirm|publish|send|submit|install|upload|unseal|transfer|reauthorize|setTokenLimit|setPrices|bugReportSend|purchase|resume)/;
const DESTRUCTIVE_SEGMENT = /^(delete|remove|uninstall|forget|revoke|clear|reset|archive|prune|cancel|stop|pause|discard|withdraw|rollback|unload|bookmarkRemove|cloudWithdraw|restartDomain|terminalClose|mutateArchive|disable)/;
const READ_SEGMENT = /^(get|list|status|search|snapshot|inspect|preview|describe|read|has|history|events|timeline|summary|overview|view|state|journal|readiness|available|catalog|library|bookmarks|latest|for[A-Z]|recap|find|check|probe|quote|usage|entries|failures|unread|thread|domains|operations|tastes?$|tasteStatus|unlockStatus|defaultTz|nextRun|validateCron|concurrencyInfo|pdfCapability|contentAvailable|exportTargets|siteIcon|imageProviders|videoKeyStatus|brandMap|recommend|pending|aoGraph|network|routePreview|previewAllocation|doctor|activeBuild|buildReady|chatActivity|runDigest|runPage|runCaptures|connectionReport|inputRequirement|exactBindings|borrowed|ontology|intakeDiagnostics|hubCatalog|dataSnapshot|bounded|path$|closure|context|diff$|observation|statisticsMethods|methods|blocks|citation|evidenceMany|bootstrap|editorModel|selectionContexts?$|editProposals?$|claimLedgers|decisionProjections|messages$|conversations)/;

export function appControlPolicy(entry: Pick<AppControlCatalogEntry, "path">): AppControlPolicy {
  // These are the native observation/control routes for existing work, not a second way to start One's own turn.
  if (/^invoke\.(activeChats|goalActiveChats|attach|history|receipt|latestReceipt|admission|workerReport|steeringRecovery|latestOneSurface|replay|preflightSteers|preflightSteerReceipt)$/.test(entry.path)) return { allowed: true, effect: "read" };
  if (/^invoke\.(cancel|unsteer|clearHistory)$/.test(entry.path)) return { allowed: true, effect: "destructive" };
  if (/^science\.composer\.(attach|receipt|steering)$/.test(entry.path)) return { allowed: true, effect: "read" };
  // Connection state and key presence contain no credential material. They are necessary to operate Settings.
  if (/^(secrets\.hasApiKey|auth\.getSession|runtime\.connectGet|mcpTools\.oauthStatus)$/.test(entry.path)) return { allowed: true, effect: "read" };
  // The screen's own ownership checks still bind these operations to a real task and view. One can observe or
  // control an existing view without manufacturing the screen's leases or approving itself.
  if (/^workLiveView\.(listTabs|capture)$/.test(entry.path)) return { allowed: true, effect: "read" };
  if (/^workLiveView\.(navigate|goBack|goForward|reload|dispatchInput)$/.test(entry.path)) return { allowed: true, effect: "consent" };
  if (/^browserUi\.(history|historyAll|downloads|readiness)$/.test(entry.path)) return { allowed: true, effect: "read" };
  if (/^browserUi\./.test(entry.path)) return { allowed: true, effect: "consent" };
  for (const [pattern, reason] of DENIED) if (pattern.test(entry.path)) return { allowed: false, reason };
  const segment = entry.path.slice(entry.path.lastIndexOf(".") + 1);
  // "uninstallPreview", "removePreview": what would happen, not the act.
  if (/Preview$/.test(segment)) return { allowed: true, effect: "read" };
  // Anything public, commercial or that spends: the owner's say-so.
  if (CONSENT_SEGMENT.test(segment) || /Public|RentAllowed|Commerce/.test(segment) || /^(unlock|claim|joinWaitlist|expose)$/.test(segment)) return { allowed: true, effect: "consent" };
  if (DESTRUCTIVE_SEGMENT.test(segment)) return { allowed: true, effect: "destructive" };
  if (READ_SEGMENT.test(segment)) return { allowed: true, effect: "read" };
  return { allowed: true, effect: "write" };
}

export function appControlEffectNeedsOwnerTurn(effect: AppControlEffect): boolean {
  return effect === "destructive" || effect === "consent";
}
