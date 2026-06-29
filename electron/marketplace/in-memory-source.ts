// Legacy in-memory source kept only to satisfy old imports. It intentionally
// returns no catalog items: Desktop Hub must display live Hub data only.
import type { MarketplaceSource } from "./source";

export class InMemorySource implements MarketplaceSource {
  listFirms() {
    return Promise.resolve([]);
  }
  listBundles() {
    return Promise.resolve([]);
  }
  searchAgents(_q: string) {
    return Promise.resolve([]);
  }
  getListingBySlug(_slug: string) {
    return Promise.resolve(null);
  }
  getFirmBySlug(_slug: string) {
    return Promise.resolve(null);
  }
}
