// Runtime registration of declarative sites — the deploy-free path (RFC 0012). The owner
// POSTs a manifest to /api/sites; it's validated, wired into the live plugin + scope
// ledgers (same as a bundled site), and persisted under ${dataDir}/sites/ so it survives
// restart. Bundled example sites under server/plugins/sites/ still load at startup via
// registry.ts/scopes.ts; this module owns everything registered at runtime.

import { loadSiteManifests, manifestScopes, SiteManifest, siteToPlugin, validateManifest } from "./plugins/declarative.ts";
import { getPlugin, registerSitePlugin, unregisterSitePlugin } from "./plugins/registry.ts";
import { unregisterReads } from "./reads.ts";
import { registerSiteScopes, unregisterSiteScopes } from "./scopes.ts";

const runtime = new Map<string, SiteManifest>();
const bundledDir = new URL("./plugins/sites/", import.meta.url);

// Wire a manifest into the live registries. Rejects an id that collides with a code plugin
// or a bundled site (those are owned elsewhere); re-registering a runtime id updates it.
export function registerSite(m: SiteManifest): void {
  validateManifest(m);
  if (getPlugin(m.id) && !runtime.has(m.id)) throw new Error(`site id "${m.id}" collides with an existing plugin`);
  registerSitePlugin(siteToPlugin(m));
  const { ingredients, capabilities } = manifestScopes(m);
  registerSiteScopes(ingredients, capabilities);
  runtime.set(m.id, m);
}

export function unregisterSite(id: string): boolean {
  if (!runtime.has(id)) return false;
  // A removed site's named reads must go with it, or /api/<site>/<kind> keeps answering from a
  // plugin that no longer exists.
  unregisterReads(id);
  unregisterSitePlugin(id);
  unregisterSiteScopes(id);
  runtime.delete(id);
  return true;
}

export function getSiteManifest(id: string): SiteManifest | undefined {
  return runtime.get(id);
}

// The site catalog: bundled examples + runtime-registered, tagged by source (runtime ones
// are deletable). Endpoints/extraction specs stay out — just what the site is and grants.
export function listSites(): { id: string; label: string; cookieDomains: string[]; scopes: string[]; source: "bundled" | "runtime" }[] {
  const view = (m: SiteManifest, source: "bundled" | "runtime") => ({
    id: m.id, label: m.label, cookieDomains: m.cookieDomains, scopes: (m.scopes ?? []).map((s) => s.id), source,
  });
  const bundled = loadSiteManifests(bundledDir).map((m) => view(m, "bundled"));
  const dyn = [...runtime.values()].map((m) => view(m, "runtime"));
  return [...bundled, ...dyn];
}

// Startup: register every persisted runtime manifest. Called from handler init().
export function hydratePersistedSites(dataDir: string): number {
  let n = 0;
  for (const m of loadSiteManifests(`${dataDir}/sites`)) {
    registerSite(m);
    n++;
  }
  return n;
}

export async function persistSite(dataDir: string, m: SiteManifest): Promise<void> {
  const dir = `${dataDir}/sites`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/${m.id}.json`, JSON.stringify(m, null, 2));
}

export async function deletePersistedSite(dataDir: string, id: string): Promise<void> {
  await Deno.remove(`${dataDir}/sites/${id}.json`);
}
