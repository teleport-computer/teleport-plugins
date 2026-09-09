// Routes:
//   GET    /api/health
//   GET    /api/plugins                       list plugins + jar status
//   GET    /api/sites                         owner — list registered declarative sites (RFC 0012)
//   POST   /api/sites     {manifest}          owner — register a longtail site as data, no deploy
//   DELETE /api/sites/:id                      owner — unregister a runtime site
//   POST   /api/cookies   {plugin,cookies}    owner — extension/CLI syncs a jar
//   POST   /api/tokens    {plugin,subject}    owner — mint a scoped read token
//   GET    /api/tokens                        owner — list tokens
//   DELETE /api/tokens/:token                 owner — revoke a token
//   POST   /api/introspect                    bearer token — verify a scoped token
//   GET    /api/audit                         owner — audit log
//   GET    /api/jars                          owner — vault directory of current (subject, plugin) jars (#170)
//   POST   /api/export {destinationPublicKey,subject?} owner/did:key — encrypted migration bundle
//   POST   /api/audit/prune                    owner — apply retention policy, report before/after sizes (#120)
//   GET    /api/promote                       signed-in user — proposed scope ingredients from observed reads
//   POST   /api/tokens/:token/tighten          signed-in user — revoke and re-mint with a named ingredient
//   GET    /api/scopes                        public — enforced scope-ingredient ledger + app consumes/offers (#88)
//   GET    /api/scopes/:id                    public — one enforced ingredient (404 if unknown)
//   GET    /api/locator/:did                   public — RFC 0013 home pointer (200) or MOVED tombstone (410)
//   PUT    /api/locator/:did {home|movedTo}    owner — set/refresh home (import) or write tombstone (export-confirm)
//   GET    /scopes                            public — the composable-utilities panel (rendered view of /api/scopes, #88)
//   POST   /api/connect   {plugin,subject?,app?}   app — start the grant handshake
//   GET    /api/connect/:requestId            app — poll status (token once approved)
//   POST   /api/connect/:requestId/approve|deny  owner_secret — the user's decision
//   GET    /approve/:requestId                HTML approval screen
//   GET    /api/:plugin/account              scoped token OR owner — account-level data (identity + karma)
//   GET    /api/reddit/sub/:name?sort=&limit=&t=  scoped token OR owner — subreddit listing (readKind "sub", reddit:read)
//   GET    /api/reddit/search?q=&sub=&sort=&limit= scoped token OR owner — reddit search (readKind "search", reddit:read)
//   GET    /api/:plugin/quota                scoped token OR owner — provider usage/quota numbers (e.g. z.ai Coding Plan, ChatGPT Codex)
//   GET    /api/:plugin/items[/:id]           scoped token OR owner — read
//        list (/items)    → {plugin, items:[{id,title,date?,meta?}], data:items}  (prefer `items`; `data` is a back-compat alias)
//        one   (/items/:id) → {plugin, data:<item>}
//   GET    /api/:plugin/:kind                    scoped token OR owner — any REGISTERED named read (server/reads.ts),
//                                                 e.g. /api/youtube/liked (readKind "liked", #144). Same gate as every read above.
//   GET    /api/:plugin/live[?after=N]        scoped token OR owner — live item segments + frame urls
//   GET    /api/:plugin/frame?u=<b64url>      scoped token OR owner — proxy one shared-screen image (binary)
//   GET    /api/:plugin/screenshot            scoped token OR owner — logged-in render via Browser SPI

import { allPlugins, getPlugin } from "./plugins/registry.ts";
import { getRead } from "./reads.ts";
import { configureEgress, egressFetch, egressProxy } from "./egress.ts";
import { allJarStatuses, AmbiguousAccountError, deleteJar, deleteMigrating, entriesForExport, getJar, initVault, installEntries, jarsFor, markMigrating, setJar, strandedJars } from "./vault.ts";
import { importTokens, initTokens, listTokens, mint, revoke, revokeSubject, tokensForSubject, type Token, verify, verifyCap, verifiedCaps } from "./tokens.ts";
import { approveConnect, createConnect, denyConnect, getConnect, initConnect, statusOf } from "./connect.ts";
import { audit, auditLog, initAudit, pruneAudit } from "./audit.ts";
import { formatAuditDecision, gate, Scope, STATIC_LISTING } from "./listing.ts";
import { getListings, initListings } from "./listings.ts";
import { initEval, logEval, updateEvalOutcome } from "./eval.ts";
import { startScheduler } from "./scheduler.ts";
import { approvePage } from "./approve-page.ts";
import { appPage } from "./app-page.ts";
import { loginPage } from "./login-page.ts";
import { dashboardPage } from "./dashboard-page.ts";
import { scopesPage } from "./scopes-page.ts";
import { evidencePage, homePage, privacyPage, termsPage } from "./home-page.ts";
import { createSession, destroySession, initSessions, verifySession } from "./sessions.ts";
import { newChallenge, verifyDidSignIn } from "./identity.ts";
import { allCredentialIds, credentialsFor, initPasskeys, passkeyChallenge, verifyAuthentication, verifyRegistration } from "./passkey.ts";
import { consumeState, enabledProviders, githubAuthUrl, githubEnv, githubExchange, googleAuthUrl, googleCalendarAuthUrl, googleCalendarExchange, googleEnv, googleExchange, newState } from "./oidc.ts";
import { configureOtter } from "./plugins/otter.ts";
import { configureReddit } from "./plugins/reddit.ts";
import { configureCodex } from "./plugins/codex.ts";
import { amazonPlugin, configureAmazon } from "./plugins/amazon.ts";
import { configureGoogleCalendar } from "./plugins/google-calendar.ts";
import { configureZai } from "./plugins/zai.ts";
import type { Jar, SubstituteOp } from "./plugins/types.ts";
import { initLinks, linkBind, linkResolve, linksFor, linkUnbind } from "./links.ts";
import { verifySiwe } from "./siwe.ts";
import { browserScreenshot, browserFeed } from "./browser.ts";
import { apiLike, apiMe, apiTimeline, apiTweet, apiUnlike, browserTrace } from "./twitter-actions.ts";
import { appDeclarations, pluginCapabilities, scopeIngredient, scopeIngredients, scopeLabel, scopeReads } from "./scopes.ts";
import { deletePersistedSite, hydratePersistedSites, listSites, persistSite, registerSite, unregisterSite } from "./sites.ts";
import { proposeIngredients } from "./promoter.ts";
import { approveChallenge, createChallenge, denyChallenge, getChallenge, initStepup, recordTokenUse, score, wasFirstUse } from "./stepup.ts";
import { createLocatorStore, locatorGetResponse, type LocatorStore } from "./locator.ts";
import { encryptExport } from "./export.ts";
import { decryptMigration, signReceipt, verifyReceipt, type ConfirmReceipt, type EncryptedExport } from "./migration.ts";

let ready = false;
let ownerSecret = "";
let publicUrl = "";
let browserSpiUrl = "";
let browserSpiSecret = "";
let locator: LocatorStore | null = null;

export interface HandlerCtx { env: Record<string, string>; dataDir?: string; }

async function init(env: Record<string, string>, dataDir: string) {
  if (ready) return;
  await initVault(dataDir, env.SEAL_KEY || env.OAUTH3_SEAL_KEY || "", (pid, jar) => {
    // #111: derive the account label the SAME way sync does. A plugin with an accountId hook
    // (twitter) keys per account; every other plugin keys under "default". This callback runs
    // only for MIGRATION of legacy 2-part keys — a best-effort recovery, so a legacy jar that
    // can't yield an id (e.g. a pre-twid twitter session) falls back to "default" with a
    // warning rather than bricking startup. The LIVE sync path (POST /api/cookies) stays
    // strict — it calls plugin.accountId directly and propagates the error.
    const p = getPlugin(pid);
    if (!p?.accountId) return "default";
    try {
      return p.accountId(jar);
    } catch (e) {
      console.warn(`[vault] migration: ${pid} jar underivable account (${(e as Error).message}) → "default"`);
      return "default";
    }
  });
  await initTokens(dataDir, env.SEAL_KEY ?? env.OAUTH3_SEAL_KEY);
  await initConnect(dataDir);
  await initStepup(dataDir);
  await initAudit(dataDir);
  await initSessions(dataDir);
  await initPasskeys(dataDir);
  await initLinks(dataDir);
  configureOtter(env);
  configureReddit(env);
  configureAmazon(env);
  configureGoogleCalendar(env);
  configureZai(env);
  configureCodex(env);
  await initListings(dataDir);
  locator = await createLocatorStore(dataDir);
  await initEval(dataDir);
  const nSites = hydratePersistedSites(dataDir);
  if (nSites) console.log(`[init] hydrated ${nSites} runtime site(s) from ${dataDir}/sites`);
  ownerSecret = env.OWNER_SECRET || env.OAUTH3_OWNER_SECRET || env.EXT_SHARED_SECRET || "";
  publicUrl = (env.PUBLIC_URL || "").replace(/\/$/, "");
  browserSpiUrl = (env.BROWSER_SPI_URL || "").replace(/\/$/, "");
  browserSpiSecret = env.BROWSER_SPI_SECRET || "";
  configureEgress(env.EGRESS_PROXY_URL || "");
  if (!ownerSecret) console.warn("[init] OWNER_SECRET missing — cookie sync and minting will reject");
  startScheduler(env, dataDir);
  ready = true;
  console.log(`[init] ready — plugins: ${allPlugins().map((p) => p.id).join(", ")}`);
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function jsonWithHeaders(obj: unknown, extra: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}
// #131: a scoped token MUST carry a subject. The old `t.subject ?? "owner"` silently read the
// OWNER's (usually stale) jar and then blamed the user's cookies — the single biggest cause of
// bogus "app is broken" reports. No fallback: reject a subjectless token. `t` is null only on the
// owner-authenticated path (every caller 401s when `!isOwner(req) && !t`), so owner stays correct.
function jarSubject(t: Token | null): string | Response {
  if (!t) return "owner";
  if (!t.subject) return json({ error: "token has no subject — remint the token with a subject (#131)" }, 400);
  return t.subject;
}
function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
// After an OAuth redirect callback, hand the SPA its session via localStorage (the app
// uses localStorage, not cookies) and bounce to the return url. `note` is a static string.
function landingHtml(session: string | null, returnUrl: string, note: string): string {
  const set = session ? `localStorage.setItem('oauth3_session', ${JSON.stringify(session)});` : "";
  return `<!doctype html><meta charset=utf-8><body style="font:15px system-ui;max-width:30rem;margin:3rem auto;color:#111"><p>${note} Redirecting…</p><script>${set}location.href=${JSON.stringify(returnUrl)};</script>`;
}
const isOwner = (req: Request) => !!ownerSecret && req.headers.get("Authorization") === `Bearer ${ownerSecret}`;

// #111: resolve a read jar, turning AmbiguousAccountError (a subject holding several
// accounts for this plugin, none named) into a 409 carrying the available accounts so the
// client can re-ask with ?account= or a token bound to one. Every token/owner read
// chokepoint routes through here so ambiguity is surfaced, never silently resolved.
type JarResolve = { ok: true; jar: Jar } | { ok: false; resp: Response };
function readJar(subj: string, pluginId: string, account?: string): JarResolve {
  try {
    const jar = getJar(subj, pluginId, account);
    if (!jar) return { ok: false, resp: json({ error: `no jar synced for ${pluginId}` }, 409) };
    return { ok: true, jar };
  } catch (e) {
    if (e instanceof AmbiguousAccountError) {
      return {
        ok: false,
        resp: json({ error: `multiple accounts synced for ${pluginId}; pass ?account=<id> or bind the token to one`, accounts: e.accounts }, 409),
      };
    }
    throw e;
  }
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export default async function handler(req: Request, ctx: HandlerCtx): Promise<Response> {
  await init(ctx.env || {}, ctx.dataDir || "");

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  const url = new URL(req.url);
  const path = url.pathname;
  // Version pin (CONSTITUTION Tier 1): lets an HTTP transcript pin the running core to a
  // PR commit. GIT_SHA is injected at deploy (env); "dev" when unset (local/in-process).
  if (req.method === "GET" && path === "/_api/version") {
    return json({ service: "oauth3-server", commit: ctx.env?.GIT_SHA || "dev" });
  }
  const origin = publicUrl || url.origin;
  // Session = a token in the Authorization header (the daemon proxy forwards it;
  // it strips cookies). The login/approve pages keep it in localStorage.
  const authBearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const session = verifySession(authBearer);
  // The acting identity: a web session's subject, or "owner" when the owner secret is
  // presented directly (CLI/extension). null = unauthenticated. Jars + tokens scope to it.
  const subjectOf = (): string | null => session?.subject ?? (isOwner(req) ? "owner" : null);

  // Public face: index + privacy + terms (needed to be a real public service; federated
  // login providers require a reachable home page + privacy policy + ToS). See issue #32.
  if (req.method === "GET" && (path === "/" || path === "")) return html(homePage(ctx.env));
  if (req.method === "GET" && path === "/privacy") return html(privacyPage(ctx.env));
  if (req.method === "GET" && path === "/terms") return html(termsPage(ctx.env));
  if (req.method === "GET" && path === "/evidence") return html(evidencePage(ctx.env));

  // Smoke-check report — static HTML served from disk when an operator/cron has uploaded it.
  // Renamed from /journeys in #81 (the suite is flow verification, not a user journey).
  if (req.method === "GET" && (path === "/smoke" || path === "/smoke/")) {
    const reportPath = (ctx.dataDir || ".") + "/smoke/index.html";
    try {
      const reportHtml = await Deno.readTextFile(reportPath);
      return html(reportHtml);
    } catch {
      return html("<html><body><h1>Smoke-check report</h1><p>Report not found at " + reportPath + "</p></body></html>");
    }
  }
  // Admin endpoint to update the smoke-check report (owner secret required).
  if (req.method === "POST" && path === "/api/smoke") {
    if (!isOwner(req)) return json({ error: "unauthorized" }, 401);
    const body = await req.text();
    const reportDir = (ctx.dataDir || ".") + "/smoke";
    const reportPath = reportDir + "/index.html";
    await Deno.mkdir(reportDir, { recursive: true });
    await Deno.writeTextFile(reportPath, body);
    await audit("smoke.update", {});
    return json({ ok: true, path: reportPath });
  }

  // The instance's own demo app — open it with the extension, no sign-in.
  // ?plugin=<id> picks which adapter to demo (default otter).
  if (req.method === "GET" && (path === "/app" || path === "/app/")) {
    return html(appPage(url.searchParams.get("plugin") || "otter"));
  }

  // Your account dashboard — visit plugin-free; signs in via /login, then shows
  // connected apps, synced sites, and activity scoped to your subject.
  if (req.method === "GET" && (path === "/dashboard" || path === "/dashboard/")) {
    return html(dashboardPage());
  }
  // #88: the composition panel — renders the pod as composable capability-utilities from the
  // SAME ledger functions GET /api/scopes serves (single source, can't drift). Public: the
  // consumed labels are the enforced gate sentences and the ingredient list is already public.
  if (req.method === "GET" && (path === "/scopes" || path === "/scopes/")) {
    return html(scopesPage());
  }

  // --- web sign-in (so you approve apps without re-pasting the owner secret) ---
  if (req.method === "GET" && path === "/login") {
    return html(loginPage(url.searchParams.get("return") || ""));
  }
  // A nonce to sign for did:key sign-in (TinyCloud-style signed identity).
  if (req.method === "GET" && path === "/api/login/challenge") {
    return json({ challenge: newChallenge() });
  }
  if (req.method === "POST" && path === "/api/login") {
    const body = await req.json().catch(() => null) as any;
    // Three identity paths, all → a session subject:
    //   did:key   — sign a challenge with your key; server sees only DID + signature (best)
    //   userKey   — a localStorage secret hashed into a subject (no passkey, no account)
    //   owner     — the admin/bootstrap secret
    let subject = "";
    if (body?.did && body?.challenge && body?.signature) {
      if (!await verifyDidSignIn(body.did, body.challenge, body.signature)) return json({ error: "bad signature or expired challenge" }, 401);
      subject = body.did;
    } else if (typeof body?.userKey === "string" && body.userKey.length >= 16) {
      subject = "u-" + await sha256hex(body.userKey);
    } else if (ownerSecret && body?.owner_secret === ownerSecret) {
      subject = "owner";
    } else {
      return json({ error: "provide a signed did:key, a userKey (≥16 chars), or the owner secret" }, 401);
    }
    const token = await createSession(subject);
    return json({ ok: true, subject, session: token });
  }
  if (req.method === "POST" && path === "/api/logout") {
    await destroySession(authBearer);
    return json({ ok: true });
  }

  // --- passkey (WebAuthn): enroll a passkey while signed in, then sign in with it on
  // any device. rpId/origin are derived from PUBLIC_URL so it works behind the proxy. ---
  if (path.startsWith("/api/passkey")) {
    const pubOrigin = publicUrl ? new URL(publicUrl).origin : url.origin;
    const origins = [pubOrigin], rpId = new URL(pubOrigin).hostname;
    if (req.method === "POST" && path === "/api/passkey/register/options") {
      const subj = subjectOf();
      if (!subj) return json({ error: "sign in first to add a passkey" }, 401);
      return json({ challenge: passkeyChallenge(), rpId, userId: subj });
    }
    if (req.method === "POST" && path === "/api/passkey/register") {
      const subj = subjectOf();
      if (!subj) return json({ error: "sign in first" }, 401);
      const body = await req.json().catch(() => null) as any;
      try { await audit("passkey.register", { subject: subj }); return json(await verifyRegistration(body, origins, subj)); }
      catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (req.method === "POST" && path === "/api/passkey/login/options") {
      return json({ challenge: passkeyChallenge(), rpId, allowCredentials: allCredentialIds() });
    }
    if (req.method === "POST" && path === "/api/passkey/login") {
      const body = await req.json().catch(() => null) as any;
      try {
        const { subject } = await verifyAuthentication(body, origins);
        const token = await createSession(subject);
        await audit("passkey.login", { subject });
        return json({ ok: true, subject, session: token });
      } catch (e) { return json({ error: (e as Error).message }, 401); }
    }
    if (req.method === "GET" && path === "/api/passkeys") {
      const subj = subjectOf();
      if (!subj) return json({ error: "unauthorized" }, 401);
      return json({ passkeys: credentialsFor(subj) });
    }
  }
  if (req.method === "GET" && path === "/api/me") {
    return json({ signedIn: !!session, subject: session?.subject, providers: enabledProviders(ctx.env), links: session ? linksFor(session.subject) : [] });
  }
  // Unlink a linked sign-in. Lockout-safe: root subjects (userKey/did:key/owner) keep their
  // localStorage/secret door so unlinking an alias is fine; a federated-rooted subject must
  // keep at least one factor (links + passkeys).
  if (req.method === "POST" && path === "/api/links/unlink") {
    const subj = subjectOf();
    if (!subj) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => null) as { providerId?: string } | null;
    const pid = body?.providerId || "";
    if (linkResolve(pid) !== subj) return json({ error: "not your link" }, 404);
    const hasRoot = subj.startsWith("u-") || subj.startsWith("did:key:") || subj === "owner";
    const remaining = linksFor(subj).filter((p) => p !== pid).length + credentialsFor(subj).length;
    if (!hasRoot && remaining === 0) return json({ error: "can't unlink your only sign-in method" }, 409);
    await linkUnbind(pid);
    await audit("links.unlink", { subject: subj, providerId: pid });
    return json({ ok: true });
  }

  // --- federated login: GitHub OAuth (RFC 0002) + account linking. A provider's routes
  // exist iff its creds are present (else 404 + the login page omits the button). ---
  if (path === "/api/login/providers" && req.method === "GET") {
    return json(enabledProviders(ctx.env));
  }
  if (path.startsWith("/api/login/github")) {
    const gh = githubEnv(ctx.env);
    if (!gh) return json({ error: "github login not configured" }, 404);
    const base = publicUrl || origin;
    const redirectUri = `${base}/api/login/github/callback`;
    const dash = `${base}/dashboard`;
    if (req.method === "GET" && path === "/api/login/github") {
      const rp = url.searchParams.get("return");
      const ret = rp && rp.startsWith(base) ? rp : dash;               // open-redirect guard
      // Return the URL for the client to navigate — the daemon ingress FOLLOWS server-side
      // 3xx (would proxy GitHub's page back as 200) instead of handing it to the browser.
      return json({ url: githubAuthUrl(gh, newState(ret), redirectUri) });
    }
    if (req.method === "POST" && path === "/api/login/github/link") {
      const subj = subjectOf();
      if (!subj) return json({ error: "sign in first to link" }, 401);
      return json({ url: githubAuthUrl(gh, newState(dash, subj), redirectUri) });
    }
    if (req.method === "GET" && path === "/api/login/github/callback") {
      const st = consumeState(url.searchParams.get("state") || "");
      const code = url.searchParams.get("code") || "";
      if (!st || !code) return html(landingHtml(null, dash, "GitHub sign-in failed (bad state or code)."));
      try {
        const { id } = await githubExchange(gh, code, redirectUri);
        const providerId = `gh:${id}`;
        if (st.linkSubject) {                                          // linking, not login
          await linkBind(providerId, st.linkSubject);
          await audit("login.github.link", { subject: st.linkSubject, providerId });
          return html(landingHtml(null, st.ret, "Linked GitHub to your account."));
        }
        const subject = linkResolve(providerId) || providerId;        // take-over if linked
        const session = await createSession(subject);
        await audit("login.github", { subject });
        return html(landingHtml(session, st.ret, "Signed in with GitHub."));
      } catch (e) {
        return html(landingHtml(null, dash, `GitHub sign-in error: ${(e as Error).message}.`));
      }
    }
  }

  // --- Google Calendar data grant. It is separate from login and stores a refresh token in
  // the vault. A signed-in user links it to their existing subject. ---
  if (path.startsWith("/api/login/google-calendar")) {
    const g = googleEnv(ctx.env);
    if (!g) return json({ error: "google login not configured" }, 404);
    const base = publicUrl || origin;
    const redirectUri = `${base}/api/login/google-calendar/callback`;
    const dash = `${base}/dashboard`;
    if (req.method === "GET" && path === "/api/login/google-calendar") {
      const subj = subjectOf();
      if (!subj) return json({ error: "sign in first to connect Google Calendar" }, 401);
      const rp = url.searchParams.get("return");
      const ret = rp && rp.startsWith(base) ? rp : dash;
      return json({ url: googleCalendarAuthUrl(g, newState(ret, subj, "google-calendar"), redirectUri) });
    }
    if (req.method === "GET" && path === "/api/login/google-calendar/callback") {
      const st = consumeState(url.searchParams.get("state") || "");
      const code = url.searchParams.get("code") || "";
      if (!st || st.purpose !== "google-calendar" || !code) return html(landingHtml(null, dash, "Google Calendar connection failed (bad state or code)."));
      try {
        const grant = await googleCalendarExchange(g, code, redirectUri);
        const subject = st.linkSubject || `google:${grant.sub}`;
        await setJar(subject, "google-calendar", "default", {
          refresh_token: grant.refresh_token,
          access_token: grant.access_token,
          access_token_expires_at: String(Date.now() + (grant.expires_in || 3600) * 1000),
        });
        await audit("login.google-calendar", { subject });
        const session = st.linkSubject ? null : await createSession(subject);
        return html(landingHtml(session, st.ret, "Google Calendar connected."));
      } catch (e) {
        return html(landingHtml(null, dash, `Google Calendar connection error: ${(e as Error).message}.`));
      }
    }
  }

  // --- Google login (OIDC). Same shape as GitHub; subject = google:<sub>. Client-driven. ---
  if (path.startsWith("/api/login/google")) {
    const g = googleEnv(ctx.env);
    if (!g) return json({ error: "google login not configured" }, 404);
    const base = publicUrl || origin;
    const redirectUri = `${base}/api/login/google/callback`;
    const dash = `${base}/dashboard`;
    if (req.method === "GET" && path === "/api/login/google") {
      const rp = url.searchParams.get("return");
      const ret = rp && rp.startsWith(base) ? rp : dash;
      return json({ url: googleAuthUrl(g, newState(ret), redirectUri) });
    }
    if (req.method === "POST" && path === "/api/login/google/link") {
      const subj = subjectOf();
      if (!subj) return json({ error: "sign in first to link" }, 401);
      return json({ url: googleAuthUrl(g, newState(dash, subj), redirectUri) });
    }
    if (req.method === "GET" && path === "/api/login/google/callback") {
      const st = consumeState(url.searchParams.get("state") || "");
      const code = url.searchParams.get("code") || "";
      if (!st || !code) return html(landingHtml(null, dash, "Google sign-in failed (bad state or code)."));
      try {
        const { sub } = await googleExchange(g, code, redirectUri);
        const providerId = `google:${sub}`;
        if (st.linkSubject) {
          await linkBind(providerId, st.linkSubject);
          await audit("login.google.link", { subject: st.linkSubject, providerId });
          return html(landingHtml(null, st.ret, "Linked Google to your account."));
        }
        const subject = linkResolve(providerId) || providerId;
        const session = await createSession(subject);
        await audit("login.google", { subject });
        return html(landingHtml(session, st.ret, "Signed in with Google."));
      } catch (e) {
        return html(landingHtml(null, dash, `Google sign-in error: ${(e as Error).message}.`));
      }
    }
  }

  // --- OpenKey login: SIWE -> did:pkh. Client-driven (the OpenKey wallet signs a SIWE
  // message), so it POSTs {message, signature} here — no server redirect. ---
  if (path.startsWith("/api/login/openkey")) {
    const host = new URL(publicUrl || origin).host;
    if (req.method === "GET" && path === "/api/login/openkey/nonce") {
      return json({ nonce: newState(""), domain: host, uri: publicUrl || origin });
    }
    if (req.method === "POST" && (path === "/api/login/openkey" || path === "/api/login/openkey/link")) {
      const body = await req.json().catch(() => null) as { message?: string; signature?: string } | null;
      if (!body?.message || !body?.signature) return json({ error: "message + signature required" }, 400);
      let v: { address: string; nonce: string; domain: string };
      try { v = verifySiwe(body.message, body.signature); } catch (e) { return json({ error: (e as Error).message }, 401); }
      if (!consumeState(v.nonce)) return json({ error: "unknown or expired nonce" }, 401);
      if (v.domain && v.domain !== host) return json({ error: `domain mismatch: ${v.domain}` }, 401);
      const providerId = `did:pkh:eip155:1:${v.address}`;
      if (path.endsWith("/link")) {
        const subj = subjectOf();
        if (!subj) return json({ error: "sign in first to link" }, 401);
        await linkBind(providerId, subj);
        await audit("login.openkey.link", { subject: subj, providerId });
        return json({ ok: true, linked: providerId });
      }
      const subject = linkResolve(providerId) || providerId;
      const session = await createSession(subject);
      await audit("login.openkey", { subject });
      return json({ ok: true, subject, session });
    }
  }

  if (req.method === "GET" && path === "/api/health") {
    return json({ ready, plugins: allPlugins().map((p) => p.id) });
  }

  if (req.method === "GET" && path === "/api/plugins") {
    const subj = subjectOf(); // jar status is per-identity; anonymous sees none present
    return json({
      plugins: allPlugins().map((p) => ({
        id: p.id, label: p.label, cookieDomains: p.cookieDomains, account: !!p.account,
        // #12: availability marker, only when the plugin declares it — every other entry
        // keeps its exact current shape.
        ...(p.path ? { path: p.path } : {}),
        ...(p.available === false ? { available: false } : {}),
        // #133: non-cookie credentials declare tokenSource so the extension can sync them.
        ...(p.tokenSource ? { tokenSource: p.tokenSource } : {}),
        // #111: one identity may hold several accounts per plugin — surface them all.
        jars: subj ? jarsFor(subj, p.id) : [],
      })),
    });
  }

  // RFC 0007 §5.2: listing store
  if (req.method === "GET" && path === "/api/listings") {
    return json({ listings: getListings() });
  }

  // --- RFC 0013 (discovery): locator records. A signed HOME pointer per subject DID, or a MOVED
  // tombstone once the subject migrated to another pod. A stale read on the origin returns 410
  // + the tombstone so a holder of the old URL can follow `movedTo` (exactly once). Writes are
  // owner-only: import sets the home record on the destination; export-confirm writes the
  // tombstone on the origin. Records are Ed25519-signed by this pod's own did:key (in `iss`). ---
  if (path.startsWith("/api/locator/")) {
    if (!locator) return json({ error: "locator store not initialized" }, 500);
    const did = decodeURIComponent(path.slice("/api/locator/".length));
    if (req.method === "GET" && did) {
      const { status, body } = locatorGetResponse(locator.get(did));
      return json(body, status);
    }
    if ((req.method === "PUT" || req.method === "POST") && did) {
      if (!isOwner(req)) return json({ error: "owner only" }, 401);
      const body = await req.json().catch(() => null) as { home?: string; movedTo?: string; seq?: number } | null;
      if (body?.home) return json(await locator.setHome(did, body.home, body.seq));
      if (body?.movedTo) return json(await locator.setMoved(did, body.movedTo, body.seq));
      return json({ error: "provide {home:<url>} or {movedTo:<url>}" }, 400);
    }
  }

  // --- declarative sites (RFC 0012): register a longtail site as data, at runtime, no deploy ---
  if (path === "/api/sites") {
    if (!isOwner(req)) return json({ error: "owner only" }, 401);
    if (req.method === "GET") return json({ sites: listSites() });
    if (req.method === "POST") {
      const m = await req.json().catch(() => null) as any;
      try { registerSite(m); } catch (e) { return json({ error: (e as Error).message }, 400); }
      await persistSite(ctx.dataDir || "", m);
      await audit("site.register", { id: m.id, scopes: (m.scopes ?? []).map((s: { id: string }) => s.id) });
      return json({ ok: true, id: m.id, scopes: (m.scopes ?? []).map((s: { id: string }) => s.id) });
    }
  }
  const siteDel = path.match(/^\/api\/sites\/([a-z0-9-]+)$/);
  if (siteDel && req.method === "DELETE") {
    if (!isOwner(req)) return json({ error: "owner only" }, 401);
    if (!unregisterSite(siteDel[1])) return json({ error: "not a runtime site" }, 404);
    await deletePersistedSite(ctx.dataDir || "", siteDel[1]);
    await audit("site.unregister", { id: siteDel[1] });
    return json({ ok: true, id: siteDel[1] });
  }

  if (req.method === "POST" && path === "/api/cookies") {
    const subj = subjectOf();
    if (!subj) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => null) as any;
    const plugin = getPlugin(body?.plugin);
    if (!plugin) return json({ error: "unknown plugin" }, 404);
    if (!body?.cookies || typeof body.cookies !== "object") return json({ error: "missing cookies" }, 400);
    // #111: derive the account from the jar so a second account for the same plugin creates
    // a second jar instead of overwriting. A plugin without accountId keys under "default".
    let account: string;
    try {
      account = plugin.accountId ? plugin.accountId(body.cookies) : "default";
    } catch (e) {
      return json({ error: `cannot derive account: ${(e as Error).message}` }, 400);
    }
    await setJar(subj, plugin.id, account, body.cookies);
    await audit("cookies.sync", { subject: subj, plugin: plugin.id, account, count: Object.keys(body.cookies).length });
    return json({ ok: true, plugin: plugin.id, account, count: Object.keys(body.cookies).length });
  }

  // Self-host migration export. The bundle exists only in memory; the response is an envelope
  // encrypted to the destination key, and only then are the source rows marked for import.
  if (req.method === "POST" && path === "/api/export") {
    const acting = subjectOf();
    // The export ceremony accepts the owner secret or a did:key login challenge. A generic
    // local userKey session is deliberately insufficient for moving the whole vault.
    if (!acting || (!isOwner(req) && !session?.subject.startsWith("did:key:"))) return json({ error: "owner secret or did:key ceremony required" }, 401);
    const body = await req.json().catch(() => null) as { destinationPublicKey?: unknown; destinationX25519PublicKey?: unknown; subject?: unknown } | null;
    const target = acting === "owner" && typeof body?.subject === "string" ? body.subject : acting;
    const vault = entriesForExport(target);
    const grants = tokensForSubject(target);
    const delegationJwts = grants.filter((grant) => grant.token.split(".").length === 3).map((grant) => grant.token);
    if (!vault.length && !grants.length) return json({ error: "unknown subject" }, 404);
    const provenance: Record<string, { capturedVia: string }> = {};
    for (const entry of vault) {
      provenance[`${entry.plugin}:${entry.account}`] = { capturedVia: "unknown" };
    }
    try {
      const encrypted = await encryptExport({ version: 0, subject: target, exportedAt: new Date().toISOString(), vault, grants, delegationJwts, provenance }, body?.destinationPublicKey ?? body?.destinationX25519PublicKey);
      await markMigrating(target);
      await audit("export", { subject: target, entries: vault.length, grants: grants.length });
      return json({ ok: true, subject: target, entries: vault.length, export: encrypted });
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  if (req.method === "POST" && path === "/api/import") {
    if (!session?.subject.startsWith("did:key:")) return json({ error: "did:key ceremony required" }, 401);
    const body = await req.json().catch(() => null) as { export?: EncryptedExport } | null;
    const envelope = body?.export || body as unknown as EncryptedExport;
    const privateKey = ctx.env.MIGRATION_X25519_PRIVATE_KEY;
    if (!privateKey) return json({ error: "destination migration key is not configured" }, 503);
    try {
      const bundle = await decryptMigration(envelope, privateKey);
      if (bundle.subject !== session.subject) return json({ error: "destination session does not prove bundle subject" }, 403);
      const podDid = ctx.env.POD_DID || "";
      const jwkText = ctx.env.POD_SIGNING_PRIVATE_JWK || "";
      if (!podDid || !jwkText) return json({ error: "destination pod signing identity is not configured" }, 503);
      let signingJwk: JsonWebKey;
      try { signingJwk = JSON.parse(jwkText); } catch { return json({ error: "malformed destination pod signing key" }, 503); }
      const entries = bundle.vault.map((entry) => ({ ...entry, jar: entry.jar }));
      const imported = await installEntries(bundle.subject, entries);
      const grants = bundle.grants as unknown as Token[];
      const grantCount = await importTokens(grants);
      const importedAt = new Date().toISOString();
      const receipt = await signReceipt({ subject: bundle.subject, destPod: podDid, importedAt }, signingJwk);
      await audit("import", { subject: bundle.subject, entries: imported, grants: grantCount });
      return json({ ok: true, subject: bundle.subject, entries: imported, grants: grantCount, receipt });
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  if (req.method === "POST" && path === "/api/export/confirm") {
    const acting = subjectOf();
    if (!acting) return json({ error: "unauthorized" }, 401);
    const receipt = await req.json().catch(() => null) as ConfirmReceipt | null;
    if (!receipt || (acting !== "owner" && receipt.subject !== acting)) return json({ error: "receipt subject mismatch" }, 403);
    try {
      if (!await verifyReceipt(receipt)) return json({ error: "invalid destination receipt" }, 400);
      const deleted = await deleteMigrating(receipt.subject);
      const revoked = await revokeSubject(receipt.subject);
      await audit("export.confirm", { subject: receipt.subject, deleted, revoked, destPod: receipt.destPod });
      return json({ ok: true, subject: receipt.subject, deleted, revoked });
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  // Wipe a jar — your own by default; owner may target any subject via ?subject=.
  const delc = path.match(/^\/api\/cookies\/([a-z0-9-]+)$/);
  if (req.method === "DELETE" && delc) {
    const subj = subjectOf();
    if (!subj) return json({ error: "unauthorized" }, 401);
    const target = (isOwner(req) && url.searchParams.get("subject")) || subj;
    // #111: ?account= targets one account; omitted applies the single/ambiguous rule.
    const account = url.searchParams.get("account") || undefined;
    let ok: boolean;
    try {
      ok = await deleteJar(target, delc[1], account);
    } catch (e) {
      if (e instanceof AmbiguousAccountError) {
        return json({ error: `multiple accounts synced for ${delc[1]}; pass ?account=<id>`, accounts: e.accounts }, 409);
      }
      throw e;
    }
    await audit("cookies.delete", { subject: target, plugin: delc[1], account, found: ok });
    return json({ ok, deleted: ok });
  }

  // --- tokens ---
  if (req.method === "POST" && path === "/api/tokens") {
    const acting = subjectOf();
    if (!acting) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => null) as any;
    if (!getPlugin(body?.plugin)) return json({ error: "unknown plugin" }, 404);
    // Default: bound to the minter's own jar. The OWNER (admin over the vault) may mint a token
    // for another subject's jar by passing `subject` — e.g. to issue an app a read token for a
    // signed-in user's synced jar without impersonating them.
    const subj = (acting === "owner" && body?.subject) ? String(body.subject) : acting;
    // #111: optionally bind the token to ONE account's jar. Validate it names an existing
    // jar for this subject+plugin now (reject unknown up front, not on first read).
    const account = body?.account !== undefined && body?.account !== null ? String(body.account) : undefined;
    if (account !== undefined) {
      const known = jarsFor(subj, body.plugin).map((j) => j.account);
      if (!known.includes(account)) {
        return json({ error: `unknown account '${account}' for ${body.plugin}`, accounts: known }, 400);
      }
    }
    const t = await mint(body.plugin, subj, body.app, Array.isArray(body?.caps) ? body.caps : undefined, account);
    await audit("token.mint", { plugin: t.plugin, subject: t.subject, app: t.app, caps: t.caps, account });
    return json({ token: t.token, plugin: t.plugin, subject: t.subject, caps: t.caps ?? null, account: account ?? null });
  }
  // RFC 7662-style verification for third-party resource servers. Unknown and revoked
  // tokens deliberately share the same response so this endpoint cannot be used as a
  // token-probing oracle. The token itself is accepted from the bearer header, not JSON,
  // so callers cannot accidentally introspect a different credential than the one presented.
  if (req.method === "POST" && path === "/api/introspect") {
    const token = authBearer;
    const t = token ? listTokens().find((candidate) => candidate.token === token && !candidate.revokedAt) : undefined;
    if (!t) return json({ active: false });
    return json({ active: true, plugin: t.plugin, subject: t.subject, app: t.app ?? null, caps: t.caps ?? [] });
  }
  if (req.method === "GET" && path === "/api/tokens") {
    const subj = subjectOf();
    if (!subj) return json({ error: "unauthorized" }, 401);
    const all = listTokens();
    return json({ tokens: subj === "owner" ? all : all.filter((t) => t.subject === subj) });
  }
  const tighten = path.match(/^\/api\/tokens\/(.+)\/tighten$/);
  if (req.method === "POST" && tighten) {
    const acting = subjectOf();
    if (!acting) return json({ error: "unauthorized" }, 401);
    const oldToken = decodeURIComponent(tighten[1]);
    const old = listTokens().find((t) => t.token === oldToken);
    if (!old || old.revokedAt) return json({ error: "token not found or already revoked" }, 404);
    if (acting !== "owner" && old.subject !== acting) return json({ error: "token belongs to another subject" }, 403);
    const body = await req.json().catch(() => null) as { ingredient?: unknown } | null;
    const ingredient = typeof body?.ingredient === "string" ? scopeIngredient(body.ingredient) : undefined;
    if (!ingredient) return json({ error: "ingredient must name an enforced scope" }, 400);
    if (ingredient.plugin !== old.plugin) return json({ error: "ingredient does not match token plugin" }, 400);
    await revoke(old.token);
    const tightened = await mint(old.plugin, old.subject ?? "owner", old.app, [ingredient.id]);
    await audit("token.tighten", {
      subject: old.subject,
      app: old.app,
      plugin: old.plugin,
      oldToken: old.token.slice(0, 16),
      token: tightened.token.slice(0, 16),
      ingredient: ingredient.id,
    });
    return json({ token: tightened.token, plugin: tightened.plugin, subject: tightened.subject, app: tightened.app, scope: ingredient.id, label: ingredient.label, revoked: old.token });
  }
  const tok = path.match(/^\/api\/tokens\/(.+)$/);
  if (req.method === "DELETE" && tok) {
    if (!isOwner(req) && !session) return json({ error: "unauthorized" }, 401);
    const ok = await revoke(decodeURIComponent(tok[1]));
    await audit("token.revoke", { token: tok[1].slice(0, 16), found: ok });
    // RFC 0007 §4.1: log revocation outcome (we don't have app/plugin here, so skip)
    return json({ ok, revoked: ok });
  }

  if (req.method === "GET" && path === "/api/audit") {
    const subj = subjectOf();
    if (!subj) return json({ error: "unauthorized" }, 401);
    const all = auditLog();
    return json({ audit: subj === "owner" ? all : all.filter((e) => (e.detail as { subject?: string } | undefined)?.subject === subj) });
  }

  // #120 — apply the audit retention policy now and report the store size before vs. after
  // (plus the boot-time prune), so the operator can see retention work on real data.
  if (req.method === "POST" && path === "/api/audit/prune") {
    if (!isOwner(req)) return json({ error: "owner only" }, 401);
    return json(await pruneAudit());
  }

  // #170 — GET /api/jars is the vault's directory of CURRENT jar ownership. Owner-only exactly
  // like /api/audit: 401 without the owner secret. Returns every (subject, plugin) pair in the
  // vault with jarStatus()'s fields (updatedAt, count) — never a cookie name or value; this is
  // a directory, not a read. Consumers must stop reverse-engineering ownership from /api/audit:
  // that ring buffer is bounded (#120 / PR #147) and evicts old `cookies.sync` entries while the
  // jar is still fine (the self-inflicted "no z.ai jar synced" board regression). Same source of
  // truth as allJars() — the scheduler and this endpoint must never disagree.
  if (req.method === "GET" && path === "/api/jars") {
    if (!isOwner(req)) return json({ error: "owner only" }, 401);
    return json({ jars: allJarStatuses() });
  }

  // #132 — make a stranded jar legible. `?subject=<current wallet subject>` classifies every
  // jar whose subject is NOT the current wallet's as stranded (retired extension wallet /
  // rotated userKey → new subject → old jars stop refreshing but read as "expired"). Owner-only:
  // a stranded jar belongs to another subject, so exposing it to a wallet session would cross
  // the subject isolation line. Owner/subject jar reads for non-owner sessions are tracked
  // separately (see issue #132). `?plugin=` narrows to one plugin. This is the structured
  // alternative to mining /api/audit for "the last sync was under a different subject".
  const stranded = path === "/api/jars/stranded";
  if (req.method === "GET" && stranded) {
    if (!isOwner(req)) return json({ error: "owner only" }, 401);
    const current = url.searchParams.get("subject") || "";
    if (!current) return json({ error: "?subject=<current wallet subject> required" }, 400);
    const plugin = url.searchParams.get("plugin") || undefined;
    return json({ current, stranded: strandedJars(current, plugin) });
  }

  // The enforced scope-ingredient ledger, public + read-only (RFC 0004 — closure-can't-drift):
  // the scope sentence shown to a user MUST come from here, not an app-authored string, so
  // the displayed claim is provably what's enforced at the gate (#73). An app fetching this
  // pre-approval has no token yet; the labels are not secret (they appear in gate 403s).
  // #88: the ledger now also carries the app → {consumes, offers} composition graph. Each
  // consumed id is resolved to its enforced ingredient record (no drift), so the UX layer can
  // render the pod as composable capability-utilities straight from this one public source.
  if (req.method === "GET" && path === "/api/scopes") {
    return json({ scopes: scopeIngredients(), plugins: pluginCapabilities(), apps: appDeclarations() });
  }
  const scopeMatch = path.match(/^\/api\/scopes\/(.+)$/);
  if (req.method === "GET" && scopeMatch) {
    const id = decodeURIComponent(scopeMatch[1]);
    const ing = scopeIngredient(id);
    return ing ? json(ing) : json({ error: `unknown scope ingredient: ${id}` }, 404);
  }

  // The 4th self-improvement loop (#72): cluster the gate-allow audit events per app/plugin
  // and PROPOSE named scope ingredients (entries for scopes.ts) capturing exactly what each
  // app was observed reading. A signed-in user sees proposals associated with their grants;
  // the owner sees all. Names/labels are drafts; a human finalizes them.
  if (req.method === "GET" && path === "/api/promote") {
    const subj = subjectOf();
    if (!subj) return json({ error: "unauthorized" }, 401);
    const proposals = proposeIngredients(auditLog());
    if (subj === "owner") return json({ proposals });
    const grants = new Set(listTokens().filter((t) => t.subject === subj).map((t) => `${t.app || ""}\0${t.plugin}`));
    return json({ proposals: proposals.filter((p) => grants.has(`${p.app}\0${p.plugin}`)) });
  }

  // Layer-1 listing catalog (read-only; no auth needed for discoverability).
  if (req.method === "GET" && path === "/api/listing") {
    return json({ listing: STATIC_LISTING });
  }

  // --- connect / approval ---
  if (req.method === "POST" && path === "/api/connect") {
    const body = await req.json().catch(() => null) as any;
    if (!getPlugin(body?.plugin)) return json({ error: "unknown plugin" }, 404);

    // Layer-1 listing gate (AC1, AC3, AC4): refuse unlisted, dev-mode for scope overflow.
    const appId = body?.app || "unknown";
    const requestedScope: Scope = body?.scope === "raw" ? "raw" : "read";
    const gateDecision = gate(appId, body.plugin, requestedScope);

    if (gateDecision.decision === "refuse") {
      await audit("connect.refuse", formatAuditDecision(appId, body.plugin, requestedScope, gateDecision));
      return json({ error: gateDecision.reason, mode: "refuse" }, 403);
    }

    if (gateDecision.decision === "devmode") {
      await audit("connect.devmode", formatAuditDecision(appId, body.plugin, requestedScope, gateDecision));
      // Dev-mode: explicit affordance, not silent (AC3, AC4). The response carries the reason
      // and a mode marker; the client must present an explicit dev-mode affordance to proceed.
      return json({
        error: gateDecision.reason,
        mode: "dev",
        note: "This request exceeds the app's listed scope. Use dev-mode to proceed (requires explicit owner approval).",
      }, 403);
    }

    // Allowed by the listing gate: proceed to layer-2 grant. caps (e.g. "jar",
    // "write:event:<id>") are surfaced on the approve page for informed consent; the minted
    // token only carries them after the owner approves. scope/attestation feed the RFC 0007
    // routing decision (friction) cached on the request for the approve page to render.
    const caps = Array.isArray(body?.caps) ? body.caps.filter((c: unknown) => typeof c === "string") : undefined;
    const r = await createConnect(body.plugin, body.subject, body.app, caps, body.scope, body.attestation, body?.account !== undefined ? String(body.account) : undefined);
    await audit("connect.request", { plugin: r.plugin, app: r.app, caps: r.caps, requestId: r.requestId, scope: r.scope, friction: r.routeResult?.friction });
    // RFC 0007 §4.1: log eval entry at request time
    await logEval({
      ts: Date.now(),
      app: r.app || r.requestId,
      plugin: r.plugin,
      scope: r.scope,
      statement: "(pending)", // filled when listing is resolved
      workflow: "llm-judge", // phase 1 default
      decision: "discharged", // the layer-1 gate only lets listed requests through
      friction: (r.routeResult?.friction || "informed-tap") as any,
    });
    return json({ requestId: r.requestId, approveUrl: `${origin}/approve/${r.requestId}` });
  }
  const conn = path.match(/^\/api\/connect\/([^/]+)(?:\/(approve|deny))?$/);
  if (conn) {
    const id = conn[1], action = conn[2];
    if (req.method === "GET" && !action) {
      const r = getConnect(id);
      return r ? json(statusOf(r)) : json({ error: "unknown request" }, 404);
    }
    if (req.method === "POST" && action) {
      const body = await req.json().catch(() => null) as any;
      const approver = subjectOf() ?? (!!ownerSecret && body?.owner_secret === ownerSecret ? "owner" : null);
      if (!approver) return json({ error: "sign in to approve" }, 401);
      // #111: at approve time the approver's jars are known — validate a named account, or
      // 409 with the account list when several exist and the request named none. The picker
      // UI is an oauth3-extension follow-up; the API contract lands here.
      if (action === "approve") {
        const pending = getConnect(id);
        if (pending) {
          const held = jarsFor(approver, pending.plugin).map((j) => j.account);
          if (pending.account !== undefined) {
            if (!held.includes(pending.account)) {
              return json({ error: `unknown account '${pending.account}' for ${pending.plugin}`, accounts: held }, 400);
            }
          } else if (held.length > 1) {
            return json({ error: `multiple accounts synced for ${pending.plugin}; the connect request must name one (account)`, accounts: held }, 409);
          }
        }
      }
      const r = action === "approve" ? await approveConnect(id, approver) : await denyConnect(id);
      if (!r) return json({ error: "unknown or already-decided request" }, 404);
      // The connect approval is the user's informed consent, so it also satisfies the
      // first-use step-up for the freshly minted token.
      if (action === "approve" && r.token) await recordTokenUse(r.token, r.plugin);
      await audit(`connect.${action}`, { subject: approver, plugin: r.plugin, app: r.app, requestId: id });
      // RFC 0007 §4.1: fill outcome when user decides
      await updateEvalOutcome(r.app || id, r.plugin, action === "approve" ? "approved" : "denied");
      return json({ ok: true, status: r.status });
    }
  }
  const ap = path.match(/^\/approve\/([^/]+)$/);
  if (req.method === "GET" && ap) {
    return html(approvePage(getConnect(ap[1]), ap[1]));
  }

  // --- step-up challenges (RFC 0005) — out-of-band confirmation channel for the gate
  // below. The app polls GET, the user (session or owner_secret) answers POST. ---
  const ch = path.match(/^\/api\/challenge\/([^/]+)(?:\/(approve|deny))?$/);
  if (ch) {
    const id = ch[1], action = ch[2];
    if (req.method === "GET" && !action) {
      const c = getChallenge(id);
      if (!c) return json({ error: "unknown challenge" }, 404);
      // Three outcomes for the polling app:
      // - approved: retry will succeed
      // - denied/expired: terminal fail
      // - pending: keep polling
      if (c.status === "approved") {
        return json({ status: "approved", challengeId: c.challengeId });
      } else if (c.status === "denied" || c.status === "expired") {
        return json({ status: c.status, challengeId: c.challengeId }, 403);
      } else {
        return json({ status: "pending", challengeId: c.challengeId, expiresAt: c.expiresAt });
      }
    }
    if (req.method === "POST" && action) {
      const body = await req.json().catch(() => null) as any;
      const approver = subjectOf() ?? (!!ownerSecret && body?.owner_secret === ownerSecret ? "owner" : null);
      if (!approver) return json({ error: "sign in to respond" }, 401);
      const c = action === "approve" ? await approveChallenge(id, approver, isOwner(req)) : denyChallenge(id, approver, isOwner(req));
      if (!c) return json({ error: "unknown or already-decided challenge" }, 404);
      return json({ ok: true, status: c.status, challengeId: c.challengeId });
    }
  }

  // --- Twitter/X debug tool (owner-only). First WRITE surface. Two paths over the
  // same vault jar: ?path=api (reverse-engineered client) or ?path=browser (real
  // browser + /capture-trace, the reification instrument). See twitter-actions.ts. ---
  if (path.startsWith("/api/twitter/debug/")) {
    if (!isOwner(req)) return json({ error: "owner only" }, 401);
    const twAcct = url.searchParams.get("account") || undefined;
    const rj = readJar("owner", "twitter", twAcct); if (!rj.ok) return rj.resp;
    const jar = rj.jar;
    const op = path.slice("/api/twitter/debug/".length);
    const body = req.method === "POST" ? (await req.json().catch(() => ({})) as any) : {};
    const way = url.searchParams.get("path") || body.path || "api";
    try {
      // browser path = record the real request trajectory & reify it (RFC 0001).
      if (way === "browser") {
        if (op !== "timeline" && op !== "trace") {
          return json({ error: `browser-path '${op}' needs the xdotool write-instrument (bridge /eval can't actuate)` }, 501);
        }
        const target = url.searchParams.get("url") || "https://x.com/home";
        const out = await browserTrace(browserSpiUrl, jar, target, browserSpiSecret, op === "trace" ? undefined : op);
        await audit("twitter.debug", { op, path: "browser", url: out.url });
        return json({ op, path: "browser", ...out });
      }
      // api path
      let data: unknown;
      if (op === "me") data = await apiMe(jar);
      else if (op === "timeline") data = await apiTimeline(jar, Number(url.searchParams.get("count")) || 20);
      else if (op === "tweet") data = await apiTweet(jar, String(body.text ?? ""));
      else if (op === "like") data = await apiLike(jar, String(body.tweetId ?? ""));
      else if (op === "unlike") data = await apiUnlike(jar, String(body.tweetId ?? ""));
      else return json({ error: `unknown op '${op}'` }, 404);
      await audit("twitter.debug", { op, path: "api" });
      return json({ op, path: "api", data });
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }

  // The read chokepoint — every scoped read passes here after auth and before the jar is
  // touched. Three seams at one point: (A) RFC 0003/0004 scope enforcement — a token
  // carrying a scope-ingredient cap is confined to that ingredient's reads; owner + legacy
  // tokens (no scope cap) are UNRESTRICTED (scopeReads → null). (B) RFC 0005 step-up gate —
  // a scoped token's first read is held for out-of-band confirmation (challenge_pending,
  // 409); a future reject signal would 403; the owner bypasses. (C) every passing read is
  // audited so the chokepoint accrues a corpus. First-use is consumed only AFTER a
  // successful read (recordTokenUse at each read call site), so a challenged read that never
  // completes stays hot — the app must answer the challenge AND get a clean read to clear it.
  async function gateRead(t: Token | null, pluginId: string, readKind: string, bearer: string): Promise<Response | null> {
    const by = t ? (t.app || t.subject || "token") : "owner";
    let allowed: Set<string> | null;
    try {
      const caps = t ? await verifiedCaps(t) : undefined;
      allowed = scopeReads(caps);
      if (allowed && !allowed.has(readKind)) {
        await audit("gate", { plugin: pluginId, readKind, decision: "deny", by });
        return json({ error: `scope: this token may read ${[...allowed].join("+")} only, not ${readKind}`, scope: scopeLabel(caps) }, 403);
      }
    } catch (e) {
      await audit("gate", { plugin: pluginId, readKind, decision: "deny", by, reason: (e as Error).message });
      return json({ error: "token delegation invalid" }, 403);
    }
    if (t && !isOwner(req)) {
      const scored = score(bearer, pluginId, readKind, t.app);
      if (scored.decision === "challenge") {
        const chal = createChallenge(pluginId, readKind, bearer, t.app, scored.signal || "unknown");
        await audit("stepup.challenged", {
          challengeId: chal.challengeId,
          plugin: pluginId,
          item: readKind,
          app: t.app,
          signal: scored.signal,
        });
        return json({
          error: "challenge_pending",
          challengeId: chal.challengeId,
          message: "Read requires step-up approval. Poll /api/challenge/:id for status.",
        }, 409);
      }
      if (scored.decision === "reject") {
        await audit("stepup.rejected", { plugin: pluginId, item: readKind, app: t.app, signal: scored.signal });
        return json({ error: "rejected", signal: scored.signal }, 403);
      }
    }
    await audit("gate", { plugin: pluginId, readKind, decision: "allow", by });
    return null;
  }

  // #52: reads audited only their success — the early returns (no jar / not logged in) and
  // the 502 catch left failed credential USE with no trace, so the trail could not show
  // whether an app's reads were working, failing, or not happening. One row per FAILED
  // outcome; successful reads keep their existing rows, and the `gate` row above stays the
  // attempt record.
  async function auditReadOutcome(
    t: Token | null,
    plugin: string,
    readKind: string,
    outcome: "no-jar" | "not-logged-in" | "error",
    message?: string,
  ): Promise<void> {
    await audit("read.outcome", {
      plugin,
      readKind,
      outcome,
      ...(message ? { message } : {}),
      by: t ? (t.app || t.subject || "token") : "owner",
    });
  }

  // --- logged-in render via the Browser SPI (same vault jar as /items) ---
  const sc = path.match(/^\/api\/([a-z0-9-]+)\/screenshot$/);
  if (req.method === "GET" && sc) {
    const plugin = getPlugin(sc[1]);
    if (!plugin) return json({ error: "unknown plugin" }, 404);
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const t = verify(bearer, plugin.id);
    if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
    const denied = await gateRead(t, plugin.id, "screenshot", bearer); if (denied) return denied;
    const subj = jarSubject(t);
    if (subj instanceof Response) return subj;
    const rj = readJar(subj, plugin.id, t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) { await auditReadOutcome(t, plugin.id, "screenshot", "no-jar"); return rj.resp; }
    const jar = rj.jar;
    if (!plugin.loggedIn(jar)) { await auditReadOutcome(t, plugin.id, "screenshot", "not-logged-in"); return json({ error: "jar present but not logged in" }, 409); }
    const target = url.searchParams.get("url") || plugin.renderUrl ||
      `https://www.${plugin.cookieDomains[0].replace(/^\./, "")}`;
    try {
      const shot = await browserScreenshot(browserSpiUrl, plugin, jar, target, browserSpiSecret);
      // Record token use after successful read (marks first-use as consumed)
      if (t && !isOwner(req)) {
        await recordTokenUse(bearer, plugin.id);
      }
      await audit("screenshot", { plugin: plugin.id, url: target, by: t ? (t.app || t.subject || "token") : "owner" });
      return json({ plugin: plugin.id, url: target, ...shot });
    } catch (e) {
      await auditReadOutcome(t, plugin.id, "screenshot", "error", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }
  }

  // --- raw-jar release (delegated-jar consumer apps like twitter-debug). This crosses the
  // "app never sees the raw jar" line, so it is gated by owner OR a token that carries the
  // "jar" capability — which is only granted through an explicit consent screen at approve time. ---
  const jarM = path.match(/^\/api\/([a-z0-9-]+)\/jar$/);
  if (req.method === "GET" && jarM) {
    const plugin = getPlugin(jarM[1]);
    if (!plugin) return json({ error: "unknown plugin" }, 404);
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const t = verifyCap(bearer, plugin.id, "jar");
    if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
    const subj = jarSubject(t);
    if (subj instanceof Response) return subj;
    const rj = readJar(subj, plugin.id, t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) return rj.resp;
    const jar = rj.jar;
    await audit("jar.release", { plugin: plugin.id, subject: subj, count: Object.keys(jar).length, by: t ? (t.app || t.subject || "token") : "owner" });
    return json({ plugin: plugin.id, subject: subj, jar });
  }

  // --- reconstructed feed as structured JSON (OAuth3's data API). The viewer is a
  // SEPARATE relying-party app (e.g. /timeline-peek) that fetches this with a scoped
  // token — not a page served here. Gated by owner or a scoped token.
  const feedM = path.match(/^\/api\/([a-z0-9-]+)\/feed$/);
  if (req.method === "GET" && feedM) {
    const plugin = getPlugin(feedM[1]);
    if (!plugin) return json({ error: "unknown plugin" }, 404);
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const t = verify(bearer, plugin.id);
    if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
    const denied = await gateRead(t, plugin.id, "feed", bearer); if (denied) return denied;
    const subj = jarSubject(t);
    if (subj instanceof Response) return subj;
    const rj = readJar(subj, plugin.id, t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) { await auditReadOutcome(t, plugin.id, "feed", "no-jar"); return rj.resp; }
    const jar = rj.jar;
    if (!plugin.loggedIn(jar)) { await auditReadOutcome(t, plugin.id, "feed", "not-logged-in"); return json({ error: "jar present but not logged in" }, 409); }
    const target = url.searchParams.get("url") || plugin.renderUrl ||
      `https://www.${plugin.cookieDomains[0].replace(/^\./, "")}`;
    try {
      const { who, items } = await browserFeed(browserSpiUrl, plugin, jar, target, browserSpiSecret);
      if (t && !isOwner(req)) await recordTokenUse(bearer, plugin.id);
      await audit("feed", { plugin: plugin.id, count: items.length, by: t ? (t.app || t.subject || "token") : "owner" });
      return json({ plugin: plugin.id, who, items });
    } catch (e) {
      await auditReadOutcome(t, plugin.id, "feed", "error", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }
  }

  // --- TEMP owner-only jar probe: names + critical-cookie lengths + pod-side fetch (IP-vs-jar). ---
  if (req.method === "GET" && path === "/api/youtube/debug") {
    if (!isOwner(req)) return json({ error: "owner only" }, 401);
    const subj = url.searchParams.get("subject") || "owner";
    const ytAcct = url.searchParams.get("account") || undefined;
    const rj = readJar(subj, "youtube", ytAcct); if (!rj.ok) return rj.resp;
    const jar = rj.jar;
    const crit = ["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID", "LOGIN_INFO"];
    const critical = Object.fromEntries(crit.map((c) => [c, c in jar ? (jar[c]?.length ?? 0) : null]));
    // ?egress=1 routes the probe fetch through the shared VPN (so we can A/B the SAME jar
    // direct-vs-proxied and confirm the datacenter-IP de-auth theory).
    const viaEgress = url.searchParams.get("egress") === "1";
    const doFetch = viaEgress ? egressFetch : fetch;
    let fetchInfo: Record<string, unknown>;
    try {
      const r = await doFetch("https://www.youtube.com/feed/history", {
        headers: {
          "Cookie": Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "),
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(30_000),
      });
      const txt = await r.text();
      const lg = txt.match(/"logged_in","value":"(\d)"/);
      fetchInfo = { status: r.status, len: txt.length, logged_in: lg ? lg[1] : "?", consentWall: /consent\.(youtube|google)\.com|CONSENT\+PENDING/.test(txt) };
    } catch (e) {
      fetchInfo = { error: (e as Error).message };
    }
    return json({ subject: subj, count: Object.keys(jar).length, egress: { via: viaEgress, proxy: egressProxy() || null }, names: Object.keys(jar), critical, fetch: fetchInfo });
  }

  // --- named reads (server/reads.ts) — ONE route for every read that is REGISTERED rather than
  // bolted onto the Plugin interface. #144's /api/youtube/liked was the last read to get its own
  // hand-written block here; it is now a registration in youtube.ts served from this route, so the
  // next read variant costs a file instead of an interface edit + a route + an attested deploy.
  // Confinement is unchanged — the same gateRead chokepoint — so a `youtube:liked` token reads
  // here and NOT /feed, and a `youtube:history` token the reverse. Placed AFTER every bespoke
  // route, and registerRead() refuses the reserved kinds, so this can neither shadow one nor be
  // shadowed by one.
  const namedRead = path.match(/^\/api\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (req.method === "GET" && namedRead) {
    const nr = getRead(namedRead[1], namedRead[2]);
    if (nr) {
      const plugin = getPlugin(nr.plugin);
      if (!plugin) return json({ error: "unknown plugin" }, 404);
      const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
      const t = verify(bearer, plugin.id);
      if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
      const denied = await gateRead(t, plugin.id, nr.kind, bearer); if (denied) return denied;
      const subj = jarSubject(t);
      if (subj instanceof Response) return subj;
      const rj = readJar(subj, plugin.id, t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) { await auditReadOutcome(t, plugin.id, nr.kind, "no-jar"); return rj.resp; }
      const jar = rj.jar;
      if (!plugin.loggedIn(jar)) { await auditReadOutcome(t, plugin.id, nr.kind, "not-logged-in"); return json({ error: "jar present but not logged in" }, 409); }
      try {
        const data = await nr.run(jar);
        if (t && !isOwner(req)) await recordTokenUse(bearer, plugin.id);
        const count = Array.isArray(data) ? data.length : undefined;
        await audit(nr.kind, { plugin: plugin.id, count, by: t ? (t.app || t.subject || "token") : "owner" });
        // Response shape preserved from the route this replaces: a list read answers { plugin, items }.
        return json(Array.isArray(data) ? { plugin: plugin.id, items: data } : { plugin: plugin.id, data });
      } catch (e) {
        await auditReadOutcome(t, plugin.id, nr.kind, "error", (e as Error).message);
        return json({ error: (e as Error).message }, 502);
      }
    }
  }

  // --- live-follow (scoped token or owner): the currently-live item's recent segments
  // + shared-screen frame urls. Same read scope as /items. ---
  const liveM = path.match(/^\/api\/([a-z0-9-]+)\/live$/);
  if (req.method === "GET" && liveM) {
    const plugin = getPlugin(liveM[1]);
    if (!plugin) return json({ error: "unknown plugin" }, 404);
    if (!plugin.live) return json({ error: `${plugin.id} has no live view` }, 404);
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const t = verify(bearer, plugin.id);
    if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
    const denied = await gateRead(t, plugin.id, "live", bearer); if (denied) return denied;
    const subj = jarSubject(t);
    if (subj instanceof Response) return subj;
    const rj = readJar(subj, plugin.id, t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) { await auditReadOutcome(t, plugin.id, "live", "no-jar"); return rj.resp; }
    const jar = rj.jar;
    if (!plugin.loggedIn(jar)) { await auditReadOutcome(t, plugin.id, "live", "not-logged-in"); return json({ error: "jar present but not logged in" }, 409); }
    try {
      const data = await plugin.live(jar, Number(url.searchParams.get("after") || "0") || 0);
      if (t && !isOwner(req)) await recordTokenUse(bearer, plugin.id);
      await audit("live", { plugin: plugin.id, by: t ? (t.app || t.subject || "token") : "owner" });
      return json({ plugin: plugin.id, data });
    } catch (e) {
      await auditReadOutcome(t, plugin.id, "live", "error", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }
  }

  // --- frame proxy (scoped token or owner): stream one shared-screen image from the
  // site CDN. ?u = base64url of the image url. Binary out, so not the json envelope. ---
  const frameM = path.match(/^\/api\/([a-z0-9-]+)\/frame$/);
  if (req.method === "GET" && frameM) {
    const plugin = getPlugin(frameM[1]);
    if (!plugin) return json({ error: "unknown plugin" }, 404);
    if (!plugin.fetchFrame) return json({ error: `${plugin.id} has no frames` }, 404);
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const t = verify(bearer, plugin.id);
    if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
    const denied = await gateRead(t, plugin.id, "frame", bearer); if (denied) return denied;
    const subj = jarSubject(t);
    if (subj instanceof Response) return subj;
    const rj = readJar(subj, plugin.id, t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) { await auditReadOutcome(t, plugin.id, "frame", "no-jar"); return rj.resp; }
    const jar = rj.jar;
    if (!plugin.loggedIn(jar)) { await auditReadOutcome(t, plugin.id, "frame", "not-logged-in"); return json({ error: "jar present but not logged in" }, 409); }
    let target: string;
    try { target = atob((url.searchParams.get("u") || "").replace(/-/g, "+").replace(/_/g, "/")); }
    catch { return json({ error: "bad frame url" }, 400); }
    try {
      const { bytes, contentType } = await plugin.fetchFrame(jar, target);
      if (t && !isOwner(req)) await recordTokenUse(bearer, plugin.id);
      await audit("frame", { plugin: plugin.id, by: t ? (t.app || t.subject || "token") : "owner" });
      return new Response(bytes as unknown as BodyInit, { headers: { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" } });
    } catch (e) {
      await auditReadOutcome(t, plugin.id, "frame", "error", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }
  }

  // --- reads (scoped token or owner) ---
  const m = path.match(/^\/api\/([a-z0-9-]+)\/items(?:\/(.+))?$/);
  if (req.method === "GET" && m) {
    const plugin = getPlugin(m[1]);
    if (!plugin) return json({ error: "unknown plugin" }, 404);
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const t = verify(bearer, plugin.id);
    if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
    const denied = await gateRead(t, plugin.id, "items", bearer); if (denied) return denied;
    // A scoped token reads its own subject's jar; the owner secret reads owner's.
    const subj = jarSubject(t);
    if (subj instanceof Response) return subj;
    const rj = readJar(subj, plugin.id, t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) { await auditReadOutcome(t, plugin.id, "items", "no-jar"); return rj.resp; }
    const jar = rj.jar;
    if (!plugin.loggedIn(jar)) { await auditReadOutcome(t, plugin.id, "items", "not-logged-in"); return json({ error: "jar present but not logged in" }, 409); }

    // Step-up gate now lives in gateRead at the read chokepoint (RFC 0005); first-use is
    // cleared by recordTokenUse below only after a successful read.

    try {
      const listOpts = {
        page: url.searchParams.get("page") ? Number(url.searchParams.get("page")) : undefined,
        pageSize: url.searchParams.get("page_size") ? Number(url.searchParams.get("page_size")) : undefined,
      };
      // Response shape (issue #95): a single item (/items/:id) is {plugin, data:<item>};
      // the list (/items) is {plugin, items:[...], data:items} — `items` matches the
      // endpoint name + listItems, `data` is a back-compat alias still read by oauth3-sdk,
      // cli.ts, app-page.ts and otterscope. Prefer `items` in new code.
      const recordUse = async () => {
        if (t && !isOwner(req)) await recordTokenUse(bearer, plugin.id);
      };
      const by = t ? (t.app || t.subject || "token") : "owner";
      if (m[2]) {
        const data = await plugin.fetchItem(jar, decodeURIComponent(m[2]));
        await recordUse();
        await audit("read", { plugin: plugin.id, item: m[2], by });
        return json({ plugin: plugin.id, data });
      }
      const items = await plugin.listItems(jar, listOpts);
      await recordUse();
      await audit("read", { plugin: plugin.id, item: "list", count: items.length, by });
      return json({ plugin: plugin.id, items, data: items });
    } catch (e) {
      await auditReadOutcome(t, plugin.id, "items", "error", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }
  }

  // --- account-level data (scoped token or owner): identity + stats for the logged-in
  // account. For reddit this is the account's karma (comment + link + total) — the read
  // behind the `reddit:karma` scope ingredient. Same chokepoint as /items (readKind
  // "account"), so a karma-scoped token is confined to this and cannot read saved posts. ---
  const acc = path.match(/^\/api\/([a-z0-9-]+)\/account$/);
  if (req.method === "GET" && acc) {
    const plugin = getPlugin(acc[1]);
    if (!plugin) return json({ error: "unknown plugin" }, 404);
    if (!plugin.account) return json({ error: `${plugin.id} has no account view` }, 404);
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const t = verify(bearer, plugin.id);
    if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
    const denied = await gateRead(t, plugin.id, "account", bearer); if (denied) return denied;
    const subj = jarSubject(t);
    if (subj instanceof Response) return subj;
    const rj = readJar(subj, plugin.id, t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) { await auditReadOutcome(t, plugin.id, "account", "no-jar"); return rj.resp; }
    const jar = rj.jar;
    if (!plugin.loggedIn(jar)) { await auditReadOutcome(t, plugin.id, "account", "not-logged-in"); return json({ error: "jar present but not logged in" }, 409); }
    try {
      const data = await plugin.account(jar);
      if (t && !isOwner(req)) await recordTokenUse(bearer, plugin.id);
      await audit("account", { plugin: plugin.id, by: t ? (t.app || t.subject || "token") : "owner" });
      return json({ plugin: plugin.id, account: data });
    } catch (e) {
      await auditReadOutcome(t, plugin.id, "account", "error", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }
  }

  // --- usage/quota (scoped token or owner): provider-side usage numbers for the logged-in
  // account. For zai this is the GLM Coding Plan dashboard (5h/weekly quota %, tokens, per
  // model); for codex the ChatGPT 5-hour/weekly windows — the read behind the
  // `*:usage-read` scope ingredients. Same chokepoint as /items (readKind "quota"), so a
  // usage-scoped token is confined to this and nothing else. ---
  const quota = path.match(/^\/api\/([a-z0-9-]+)\/quota$/);
  if (req.method === "GET" && quota) {
    const plugin = getPlugin(quota[1]);
    if (!plugin) return json({ error: "unknown plugin" }, 404);
    if (!plugin.quota) return json({ error: `${plugin.id} has no quota view` }, 404);
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const t = verify(bearer, plugin.id);
    if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
    const denied = await gateRead(t, plugin.id, "quota", bearer); if (denied) return denied;
    const subj = jarSubject(t);
    if (subj instanceof Response) return subj;
    const rj = readJar(subj, plugin.id, t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) { await auditReadOutcome(t, plugin.id, "quota", "no-jar"); return rj.resp; }
    const jar = rj.jar;
    if (!plugin.loggedIn(jar)) { await auditReadOutcome(t, plugin.id, "quota", "not-logged-in"); return json({ error: "jar present but not logged in" }, 409); }
    try {
      const data = await plugin.quota(jar);
      if (t && !isOwner(req)) await recordTokenUse(bearer, plugin.id);
      await audit("quota", { plugin: plugin.id, by: t ? (t.app || t.subject || "token") : "owner" });
      return json({ plugin: plugin.id, data });
    } catch (e) {
      await auditReadOutcome(t, plugin.id, "quota", "error", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }
  }

  const sub = path.match(/^\/api\/reddit\/sub\/([^/]+)$/);
  if (req.method === "GET" && sub) {
    const plugin = getPlugin("reddit");
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const t = verify(bearer, "reddit");
    if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
    const denied = await gateRead(t, "reddit", "sub", bearer); if (denied) return denied;
    const subj = jarSubject(t); if (subj instanceof Response) return subj;
    const rj = readJar(subj, "reddit", t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) { await auditReadOutcome(t, "reddit", "sub", "no-jar"); return rj.resp; }
    if (!plugin?.loggedIn(rj.jar)) { await auditReadOutcome(t, "reddit", "sub", "not-logged-in"); return json({ error: "not logged in to reddit" }, 409); }
    const sort = url.searchParams.get("sort") || "hot";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 25) || 25, 1), 100);
    try {
      const result = await plugin.subreddit!(rj.jar, decodeURIComponent(sub[1]), sort, limit, url.searchParams.get("t") || undefined);
      if (t && !isOwner(req)) await recordTokenUse(bearer, "reddit");
      await audit("read", { plugin: "reddit", item: "sub", by: t ? (t.app || t.subject || "token") : "owner" });
      return jsonWithHeaders({ plugin: "reddit", items: result.items, data: result.items }, result.rateLimitHeaders);
    } catch (e) { await auditReadOutcome(t, "reddit", "sub", "error", (e as Error).message); return json({ error: (e as Error).message }, 502); }
  }

  if (req.method === "GET" && path === "/api/reddit/search") {
    const plugin = getPlugin("reddit");
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const t = verify(bearer, "reddit");
    if (!isOwner(req) && !t) return json({ error: "unauthorized" }, 401);
    const denied = await gateRead(t, "reddit", "search", bearer); if (denied) return denied;
    const subj = jarSubject(t); if (subj instanceof Response) return subj;
    const rj = readJar(subj, "reddit", t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) { await auditReadOutcome(t, "reddit", "search", "no-jar"); return rj.resp; }
    if (!plugin?.loggedIn(rj.jar)) { await auditReadOutcome(t, "reddit", "search", "not-logged-in"); return json({ error: "not logged in to reddit" }, 409); }
    const query = url.searchParams.get("q") || "";
    if (!query) return json({ error: "q is required" }, 400);
    const sort = url.searchParams.get("sort") || "relevance";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 10) || 10, 1), 100);
    try {
      const result = await plugin.search!(rj.jar, query, url.searchParams.get("sub") || undefined, sort, limit);
      if (t && !isOwner(req)) await recordTokenUse(bearer, "reddit");
      await audit("read", { plugin: "reddit", item: "search", by: t ? (t.app || t.subject || "token") : "owner" });
      return jsonWithHeaders({ plugin: "reddit", items: result.items, data: result.items }, result.rateLimitHeaders);
    } catch (e) { await auditReadOutcome(t, "reddit", "search", "error", (e as Error).message); return json({ error: (e as Error).message }, 502); }
  }

  // --- google-calendar event-scoped WRITE (RFC: edit-on-behalf, attenuated to one event).
  // The owner may always edit; a delegated app may edit ONE event only if its token carries
  // the structured cap "write:event:<eventId>". verifyCap rejects any other event id (exact
  // string match — "write:event:A" does not satisfy "write:event:B") and rejects read-only
  // tokens. Every write attempt is audited, authorized or not. The actual session write
  // against calendar.google.com is captured from a live trajectory (operator-run, #69); until
  // then plugin.editItem throws an honest error rather than assuming an endpoint. ---
  const gcEvt = path.match(/^\/api\/google-calendar\/event\/([^/]+)$/);
  if (req.method === "POST" && gcEvt) {
    const eventId = decodeURIComponent(gcEvt[1]);
    const plugin = getPlugin("google-calendar");
    if (!plugin) return json({ error: "unknown plugin" }, 404);
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const cap = `write:event:${eventId}`;
    const t = verifyCap(bearer, "google-calendar", cap);
    if (!isOwner(req) && !t) {
      await audit("google-calendar.event.edit.denied", { eventId, reason: "unauthorized" });
      return json({ error: `unauthorized — token must carry ${cap}` }, 401);
    }
    const subj = jarSubject(t);
    if (subj instanceof Response) return subj;
    const by = t ? (t.app || t.subject || "token") : "owner";
    const body = await req.json().catch(() => null) as { changes?: unknown } | null;
    const rj = readJar(subj, "google-calendar", t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) return rj.resp;
    const jar = rj.jar;
    if (!plugin.loggedIn(jar)) return json({ error: "jar present but not logged in" }, 409);
    await audit("google-calendar.event.edit", { eventId, subject: subj, by });
    if (!plugin.editItem) return json({ error: "plugin does not expose writes" }, 501);
    try {
      const result = await plugin.editItem(jar, eventId, body?.changes);
      return json({ ok: true, plugin: "google-calendar", eventId, result });
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }

  // --- amazon cart-substitute WRITE (#98): edit-on-behalf, attenuated to ONE swap. The owner
  // may always substitute; a delegated friend may substitute ONE line only if its token carries
  // the `amazon:cart-substitute` cap (verifyCap — exact string, like write:event:<id>). The cap
  // grants NO reads (scopeReads(["amazon:cart-substitute"]) is an empty set, so a substitute-
  // only token is denied at every read chokepoint — it cannot read the cart or order history).
  // Server-side scope enforcement lives in amazonPlugin.substitute (normalize + price band +
  // same category + qty bound) which throws SubstituteDeniedError for any shape the cap must
  // NOT permit (arbitrary add, quantity-bomb, out-of-band/cross-category substitute, unreadable
  // replacement price); the handler maps denied -> 403 and any other failure -> 502. There is no
  // checkout/address/payment endpoint, so those are inherently unavailable to this cap. Every
  // attempt is audited, authorized or not.
  if (req.method === "POST" && path === "/api/amazon/cart/substitute") {
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const cap = "amazon:cart-substitute";
    const t = verifyCap(bearer, "amazon", cap);
    if (!isOwner(req) && !t) {
      await audit("amazon.cart.substitute.denied", { reason: "unauthorized" });
      return json({ error: `unauthorized — token must carry ${cap}` }, 401);
    }
    const subj = t ? (t.subject ?? "owner") : "owner";
    const by = t ? (t.app || t.subject || "token") : "owner";
    const body = await req.json().catch(() => null) as Partial<SubstituteOp> | null;
    const rj = readJar(subj, "amazon", t?.account || url.searchParams.get("account") || undefined); if (!rj.ok) return rj.resp;
    const jar = rj.jar;
    if (!amazonPlugin.loggedIn(jar)) return json({ error: "jar present but not logged in" }, 409);
    await audit("amazon.cart.substitute", { subject: subj, by, op: body });
    if (!amazonPlugin.substitute) return json({ error: "plugin does not expose cart writes" }, 501);
    try {
      const result = await amazonPlugin.substitute(jar, body || {});
      // #103: audit the reified trajectory — WHICH mutation path ran + how many cart-write ops
      // the network layer captured (cart.add + cart.remove). The reified `ops` ARE the ground
      // truth and ride the response body; this audit line is the durable record for review.
      await audit("amazon.cart.substitute.ok", {
        subject: subj, by, path: result.path,
        ops: Array.isArray(result.ops) ? result.ops.length : 0,
        removed: result.removed?.asin, added: result.added?.asin,
      });
      return json({ ok: true, plugin: "amazon", ...result });
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "denied") {
        return json({ error: `scope: ${err.message}`, cap }, 403);
      }
      return json({ error: err.message }, 502);
    }
  }

  if (req.method === "POST" && path === "/api/ctxauth-demo") {
    const rid = crypto.randomUUID().slice(0, 8);
    const app = `ctxauth-demo-${rid}`;
    const sameSet = (a: string[], b: string[]) =>
      a.length === b.length && [...a].sort().join() === [...b].sort().join();
    const trace: unknown[] = [];
    const broad = await mint("reddit", "demo", app);
    trace.push({
      n: 1,
      step: "broad grant",
      detail: `app '${app}' is minted an UNRESTRICTED reddit token`,
      scope: "none — reads account · items/saved · feed · screenshot",
      ok: true,
    });
    for (let i = 0; i < 3; i++) {
      await audit("gate", { plugin: "reddit", readKind: "account", decision: "allow", by: app });
    }
    trace.push({
      n: 2,
      step: "observed use",
      detail: "the app read /account ×3 — the gate logged each as an allowed 'account' read",
      ok: true,
    });
    const p = proposeIngredients(auditLog()).find((x) =>
      (x.app || "") === app && x.plugin === "reddit"
    );
    trace.push({
      n: 3,
      step: "promoter proposes",
      detail: `deterministically, from the audit trail, '${app}' only ever needed:`,
      scope: p?.proposed_ingredient?.name,
      label: p?.proposed_ingredient?.label,
      observations: p?.observations,
      ok: !!p,
    });
    const match = scopeIngredients().find((s) =>
      s.plugin === "reddit" && p && sameSet(s.reads, p.proposed_ingredient.reads)
    );
    const tightIng = match?.id;
    const tight = tightIng ? await mint("reddit", "demo", app, [tightIng]) : null;
    await revoke(broad.token);
    trace.push({
      n: 4,
      step: "tighten (re-mint)",
      detail: tightIng
        ? `re-minted → confined to ${tightIng}; the broad token is revoked`
        : "no registered scope matches yet — a human curates the draft into scopes.ts first",
      scope: tightIng,
      label: tightIng ? scopeIngredient(tightIng)?.label : null,
      ok: !!tightIng,
    });
    const allowed = scopeReads(tight?.caps);
    const itemsDenied = !!(allowed && !allowed.has("items"));
    const accountAllowed = !allowed || allowed.has("account");
    trace.push({
      n: 5,
      step: "enforced",
      detail: "with the tightened token, the gate now decides:",
      lines: [
        {
          read: "GET /api/reddit/items",
          verdict: itemsDenied
            ? `403 · scope: may read ${[...(allowed || [])].join("+")} only, not items`
            : "allowed",
          denied: itemsDenied,
        },
        {
          read: "GET /api/reddit/account",
          verdict: accountAllowed ? "passes the scope" : "403",
          denied: !accountAllowed,
        },
      ],
      ok: itemsDenied && accountAllowed,
    });
    if (tight) await revoke(tight.token);
    return json({ app, trace, closed: itemsDenied && accountAllowed });
  }

  return new Response("not found", { status: 404 });
}
