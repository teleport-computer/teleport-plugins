// A longtail site is DATA, not code. Drop a JSON manifest in ./sites/ and it becomes a
// full plugin — same Plugin interface, same read chokepoints ("items"/"account"), same
// scope gate — with NO edit to registry.ts / scopes.ts / handler.ts and no core deploy.
// The manifest declares: which host jar to replay (cookieDomains — the runtime trust
// boundary; a read may only hit those hosts), the login cookie, up to three reads
// (items/account/item) each with a URL template + an extraction spec (json path-map or
// html row/regex), the enforceable scope ingredient(s) it exposes, and its capability
// sentence. Scopes map to the SAME readKinds the gate enforces, so a manifest scope is
// exactly as real as reddit:karma — never hollow.

import { cookieHeader, Jar, Plugin, PluginAccount, PluginItem } from "./types.ts";
import { registerRead, unregisterReads } from "../reads.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface JsonField { key: string; label: string; path: string; count?: boolean; date?: boolean }
interface HtmlSpec { rowSplit: string; id: string; title: string; titleGroup?: number; url?: string; urlGroup?: number }
interface Read {
  url: string; // template, {user} = login-cookie username
  auth?: boolean; // send the jar (default true); false = unauthenticated public API
  json?: { path?: string; map?: JsonField[]; id?: string; item?: Record<string, string> };
  html?: HtmlSpec;
}
export interface SiteManifest {
  id: string;
  label: string;
  cookieDomains: string[];
  loginCookie: string;
  // `items` / `account` / `item` land on the Plugin interface; ANY other key becomes a named read
  // (server/reads.ts). A site with a fourth read shape is a manifest edit, not a core change.
  reads: { items?: Read; account?: Read; item?: Read } & Record<string, Read | undefined>;
  scopes?: { id: string; reads: string[]; label: string }[];
  capability: string;
}

const user = (m: SiteManifest, jar: Jar) => (jar[m.loginCookie] ?? "").split("&")[0];
const hostOf = (u: string) => new URL(u).hostname;

async function doFetch(m: SiteManifest, r: Read, jar: Jar): Promise<Response> {
  const uname = user(m, jar);
  const url = r.url.replaceAll("{user}", encodeURIComponent(uname));
  const authed = r.auth !== false;
  if (authed) {
    const host = hostOf(url);
    if (!m.cookieDomains.some((d) => host === d.replace(/^\./, "") || host.endsWith("." + d.replace(/^\./, ""))))
      throw new Error(`manifest ${m.id}: authed read may not send the jar to ${host} (not a cookieDomain)`);
  }
  const headers: Record<string, string> = { "User-Agent": UA };
  if (authed) headers["Cookie"] = cookieHeader(jar);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (res.status === 401 || res.status === 403) throw new Error(`${m.id} rejected the jar — cookies expired (${res.status})`);
  if (!res.ok) throw new Error(`${m.id} ${url} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res;
}

const dig = (o: any, path: string) => path.split(".").reduce((v, k) => v?.[k], o);
function fieldValue(o: any, f: JsonField): string | number {
  const v = dig(o, f.path);
  if (f.count) return (v ?? []).length;
  if (f.date) return v ? new Date(Number(v) * 1000).toISOString().slice(0, 10) : "";
  return v ?? "";
}

function parseHtml(html: string, s: HtmlSpec): PluginItem[] {
  const idRe = new RegExp(s.id), tRe = new RegExp(s.title);
  return html.split(new RegExp(s.rowSplit)).slice(1).map((row): PluginItem | null => {
    const id = row.match(idRe)?.[1];
    const t = row.match(tRe);
    if (!id || !t) return null;
    return { id, title: t[s.titleGroup ?? 1], meta: s.urlGroup ? { url: t[s.urlGroup] } : undefined };
  }).filter((x): x is PluginItem => x !== null);
}

export function siteToPlugin(m: SiteManifest): Plugin {
  const p: Plugin = {
    id: m.id,
    label: m.label,
    cookieDomains: m.cookieDomains,
    renderUrl: `https://${m.cookieDomains[0].replace(/^\./, "")}`,
    loggedIn: (jar) => !!jar[m.loginCookie],
    async listItems(jar): Promise<PluginItem[]> {
      const r = m.reads.items;
      if (!r) throw new Error(`${m.id}: no items read declared`);
      const res = await doFetch(m, r, jar);
      if (r.html) return parseHtml(await res.text(), r.html);
      const j = await res.json();
      const rows = r.json?.path ? dig(j, r.json.path) : j;
      return (rows ?? []).map((it: any): PluginItem => ({ id: String(it.id ?? it), title: it.title ?? "" }));
    },
    async fetchItem(jar, id): Promise<unknown> {
      const r = m.reads.item;
      if (!r) throw new Error(`${m.id}: no item read declared`);
      const res = await doFetch(m, { ...r, url: r.url.replaceAll("{id}", encodeURIComponent(id)) }, jar);
      const j = await res.json();
      if (!r.json?.item) return j;
      return Object.fromEntries(Object.entries(r.json.item).map(([k, path]) => [k, dig(j, path)]));
    },
  };
  // Re-registering a site (PUT the same manifest, or a reload) must not throw on the duplicate —
  // registerRead refuses a second (plugin, kind) by design, so drop this site's reads first.
  unregisterReads(m.id);
  // Named reads: every declared kind beyond the three the interface carries. Same jar, same
  // host-pin, same extraction — it just answers at /api/<site>/<kind> through the generic route
  // instead of needing a member on Plugin. A manifest scope granting it is enforced identically.
  for (const [kind, r] of Object.entries(m.reads)) {
    if ((IFACE_KINDS as readonly string[]).includes(kind)) continue;
    registerRead({
      plugin: m.id,
      kind,
      label: `${m.label}: ${kind}`,
      run: async (jar) => {
        const res = await doFetch(m, r!, jar);
        if (r!.html) return parseHtml(await res.text(), r!.html);
        const j = await res.json();
        const rows = r!.json?.path ? dig(j, r!.json.path) : j;
        return (rows ?? []).map((it: any): PluginItem => ({ id: String(it.id ?? it), title: it.title ?? "" }));
      },
    });
  }
  if (m.reads.account) {
    p.account = async (jar): Promise<PluginAccount> => {
      const r = m.reads.account!;
      const res = await doFetch(m, r, jar);
      const j = await res.json();
      const id = (r.json?.id ?? "{user}").replaceAll("{user}", user(m, jar));
      return { id, label: id, fields: (r.json?.map ?? []).map((f) => ({ key: f.key, label: f.label, value: fieldValue(j, f) })) };
    };
  }
  return p;
}

// The scope ingredients + capability sentence a manifest contributes to the ledgers —
// keyed and shaped exactly like the hand-written entries in scopes.ts.
export function manifestScopes(m: SiteManifest): {
  ingredients: Record<string, { plugin: string; reads: string[]; label: string }>;
  capabilities: Record<string, { plugin: string; statement: string }>;
} {
  const ingredients: Record<string, { plugin: string; reads: string[]; label: string }> = {};
  for (const s of m.scopes ?? []) ingredients[s.id] = { plugin: m.id, reads: s.reads, label: s.label };
  return { ingredients, capabilities: { [m.id]: { plugin: m.id, statement: m.capability } } };
}

// Reject a malformed or unsafe manifest at registration time (not at read time). The
// host-pin check here means a bad manifest can never be wired up to point the jar at an
// off-domain host; a scope may only grant reads the manifest actually declares.
// The three kinds the generic loader wires onto the Plugin interface itself. Any OTHER kind a
// manifest declares becomes a NAMED READ (server/reads.ts) served by handler.ts's generic route —
// so a manifest is no longer capped at three read shapes, and a site that grows a fourth costs a
// manifest edit rather than an interface member. Until 2026-08-19 this list was the whole
// vocabulary and `unknown read kind` rejected everything else.
const IFACE_KINDS = ["items", "account", "item"] as const;
export function validateManifest(m: SiteManifest): void {
  if (!m || typeof m !== "object") throw new Error("manifest must be an object");
  if (!/^[a-z0-9-]+$/.test(m.id ?? "")) throw new Error("manifest.id must be url-safe [a-z0-9-]");
  if (!m.label) throw new Error("manifest.label required");
  if (!Array.isArray(m.cookieDomains) || m.cookieDomains.length === 0) throw new Error("manifest.cookieDomains required");
  if (!m.loginCookie) throw new Error("manifest.loginCookie required");
  if (!m.reads?.items && !m.reads?.account) throw new Error("manifest.reads needs at least items or account");
  if (!/\bCAN\b/.test(m.capability ?? "") || !/\bCANNOT\b/.test(m.capability ?? "")) throw new Error("manifest.capability must say CAN and CANNOT");
  const domains = m.cookieDomains.map((d) => d.replace(/^\./, ""));
  for (const [kind, r] of Object.entries(m.reads)) {
    if (!/^[a-z0-9-]+$/.test(kind)) throw new Error(`read kind '${kind}' must be url-safe [a-z0-9-]`);
    if (!r?.url) throw new Error(`read ${kind} needs a url`);
    if (r.auth !== false) {
      const host = hostOf(r.url.replaceAll("{user}", "x").replaceAll("{id}", "x"));
      if (!domains.some((d) => host === d || host.endsWith("." + d))) throw new Error(`authed read ${kind} host ${host} is not a cookieDomain`);
    }
  }
  const declared = new Set(Object.keys(m.reads));
  for (const s of m.scopes ?? []) for (const rd of s.reads) if (!declared.has(rd)) throw new Error(`scope ${s.id} grants read '${rd}' the manifest doesn't declare`);
}

// Read every *.json manifest in a dir (missing dir → []). Used for both the bundled
// example sites (./sites/) and runtime-registered sites (${dataDir}/sites/).
export function loadSiteManifests(dir: string | URL): SiteManifest[] {
  let entries: Deno.DirEntry[];
  try { entries = [...Deno.readDirSync(dir)]; } catch { return []; }
  const read = (name: string) => Deno.readTextFileSync(dir instanceof URL ? new URL(name, dir) : `${dir}/${name}`);
  return entries.filter((e) => e.isFile && e.name.endsWith(".json"))
    .map((e) => JSON.parse(read(e.name)) as SiteManifest);
}

// Load bundled ./sites/*.json → plugins + ledger entries. Called at startup by
// registry.ts + scopes.ts (runtime-registered sites go through sites.ts instead).
export function loadSites(dir = new URL("./sites/", import.meta.url)): {
  plugins: Plugin[];
  ingredients: Record<string, { plugin: string; reads: string[]; label: string }>;
  capabilities: Record<string, { plugin: string; statement: string }>;
} {
  const plugins: Plugin[] = [];
  const ingredients: Record<string, { plugin: string; reads: string[]; label: string }> = {};
  const capabilities: Record<string, { plugin: string; statement: string }> = {};
  for (const m of loadSiteManifests(dir)) {
    plugins.push(siteToPlugin(m));
    const s = manifestScopes(m);
    Object.assign(ingredients, s.ingredients);
    Object.assign(capabilities, s.capabilities);
  }
  return { plugins, ingredients, capabilities };
}
