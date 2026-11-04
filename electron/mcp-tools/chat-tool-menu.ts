/**
 * The tool menu of a conversation (mcp-tools/domain-tool-menu.ts), read from Main-derived facts only: the chat's surface pack and the menu
 * its stored project binding declares. The harness lookups the model can call read it by chat id (they run behind a control endpoint, not
 * in the run's async context); a run's own prompt lines read it from the run (enterRunToolMenu, set once where the run's tool selection is
 * prepared). One rule, three readers: the judge (auto-select.ts), the lookups (harness/capability-ports.ts), the name lists in the prompt.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ORDINARY_MENU, toolMenuFor, type ToolMenu } from "./domain-tool-menu";

/** Gate-only: a stand-in for the stored facts of a chat. */
let resolverOverride: ((chatId: string) => { surfacePack?: string | null; projectToolMenu?: readonly string[] | null }) | null = null;
export function setChatToolMenuFactsForTests(resolver: typeof resolverOverride): void { resolverOverride = resolver; }

export function toolMenuOfChat(chatId: string | undefined): ToolMenu {
  if (!chatId) return ORDINARY_MENU;
  try {
    if (resolverOverride) return toolMenuFor(resolverOverride(chatId));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chats = require("../store/chats") as typeof import("../store/chats");
    const surfacePack = chats.getChat(chatId)?.surfacePack ?? null;
    let projectToolMenu: readonly string[] | null = null;
    try {
      const { assertProjectDomainOwner } = require("../invocation/project-domain-binding") as typeof import("../invocation/project-domain-binding");
      const { getAuthenticatedActorIds } = require("../auth") as typeof import("../auth");
      projectToolMenu = assertProjectDomainOwner(chatId, getAuthenticatedActorIds())?.toolMenu ?? null;
    } catch { /* no signed-in owner or a changed binding: no project menu */ }
    return toolMenuFor({ surfacePack, projectToolMenu });
  } catch { return ORDINARY_MENU; }
}

const runMenu = new AsyncLocalStorage<ToolMenu>();
/** The run's menu for everything it composes in-process (the prompt's name lists). Set where the run's tool selection is prepared. */
export function enterRunToolMenu(menu: ToolMenu): void { runMenu.enterWith(menu); }
export function currentRunToolMenu(): ToolMenu | null { return runMenu.getStore() ?? null; }
