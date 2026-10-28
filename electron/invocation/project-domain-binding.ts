import { financeWorkProjectDomain } from "../finance/work-project";

/**
 * A Work project can belong to a product domain (Agentlas Finance's Work project today). The shared turn path asks this module, not
 * the domain: it fences the owner (a domain project runs only for the account that owns it) and returns the domain's per-conversation
 * metadata, so the runner attaches the domain's tools from data instead of naming the domain. An ordinary project returns null.
 */
export interface ProjectDomainBinding {
  readonly domain: string;
  readonly ownerScope: string;
  readonly projectId: string;
  /** Plugins this conversation carries on every turn, with the routing reason shown in the turn's routed-plugin pointer. */
  readonly baselinePlugins: readonly { readonly slug: string; readonly reason: string }[];
}
type Actor = { workspaceId: string; userId: string } | null;
type DomainResolver = (chatId: string, actor: Actor, expected?: ProjectDomainBinding | null) => ProjectDomainBinding | null;

/** Each domain that owns Work projects, in its own module. */
const PROJECT_DOMAINS: readonly DomainResolver[] = [financeWorkProjectDomain];

/**
 * The chat's domain binding, or null for an ordinary project. With `expected` (the binding read at the turn's start) a changed or
 * vanished binding throws, so a later stage never runs under a different owner or domain than the turn began with.
 */
export function assertProjectDomainOwner(chatId: string, actor: Actor, expected?: ProjectDomainBinding | null): ProjectDomainBinding | null {
  for (const resolve of PROJECT_DOMAINS) {
    const binding = resolve(chatId, actor, expected);
    if (binding) {
      if (expected && expected.domain !== binding.domain) throw new Error("project_domain_binding_changed");
      return binding;
    }
  }
  if (expected) throw new Error("project_domain_binding_changed");
  return null;
}
