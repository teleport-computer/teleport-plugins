// Federated login providers (RFC 0002). v1: GitHub OAuth Authorization Code. The
// verification lives here, away from routing. Credentials come from the handler's
// ctx.env (NEVER top-level Deno.env — the isolated container runs --deny-env). A
// provider is enabled iff its creds are present. Base URLs are overridable so an e2e
// can point GitHub at a mock (like OTTER_BASE for the otter plugin).

export interface ProviderEnv { id: string; secret: string; oauthBase: string; apiBase: string; }

export function githubEnv(env: Record<string, string>): ProviderEnv | null {
  const id = env.GITHUB_CLIENT_ID || env.OAUTH3_GITHUB_CLIENT_ID || "";
  const secret = env.GITHUB_CLIENT_SECRET || env.OAUTH3_GITHUB_CLIENT_SECRET || "";
  if (!id || !secret) return null;
  return {
    id, secret,
    oauthBase: (env.GITHUB_OAUTH_BASE || "https://github.com").replace(/\/$/, ""),
    apiBase: (env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, ""),
  };
}

export function enabledProviders(env: Record<string, string>): { github: boolean; google: boolean; openkey: boolean } {
  return { github: !!githubEnv(env), google: !!googleEnv(env), openkey: true }; // openkey is client-side (SIWE)
}

// --- Google (OIDC). Basic scopes (openid email profile) → no verification/cap. Three hosts
// (authorize, token, userinfo), each overridable so an e2e can point at a mock. ---
export interface GoogleEnv { id: string; secret: string; authBase: string; tokenBase: string; userinfoBase: string; }
export function googleEnv(env: Record<string, string>): GoogleEnv | null {
  const id = env.GOOGLE_CLIENT_ID || env.OAUTH3_GOOGLE_CLIENT_ID || "";
  const secret = env.GOOGLE_CLIENT_SECRET || env.OAUTH3_GOOGLE_CLIENT_SECRET || "";
  if (!id || !secret) return null;
  return {
    id, secret,
    authBase: (env.GOOGLE_OAUTH_BASE || "https://accounts.google.com").replace(/\/$/, ""),
    tokenBase: (env.GOOGLE_TOKEN_BASE || "https://oauth2.googleapis.com").replace(/\/$/, ""),
    userinfoBase: (env.GOOGLE_USERINFO_BASE || "https://openidconnect.googleapis.com").replace(/\/$/, ""),
  };
}
export function googleAuthUrl(g: GoogleEnv, state: string, redirectUri: string): string {
  const q = new URLSearchParams({ client_id: g.id, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state });
  return `${g.authBase}/o/oauth2/v2/auth?${q}`;
}
export function googleCalendarAuthUrl(g: GoogleEnv, state: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: g.id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile https://www.googleapis.com/auth/calendar.events",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${g.authBase}/o/oauth2/v2/auth?${q}`;
}
// Exchange code → Google's STABLE `sub` (the subject part). userinfo call (no JWKS) per RFC 0002 v1.
export async function googleExchange(g: GoogleEnv, code: string, redirectUri: string): Promise<{ sub: string; email?: string }> {
  const tr = await fetch(`${g.tokenBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: g.id, client_secret: g.secret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (!tr.ok) throw new Error(`google token ${tr.status}`);
  const tok = await tr.json();
  if (!tok?.access_token) throw new Error(`google token: ${tok?.error || "no access_token"}`);
  const ur = await fetch(`${g.userinfoBase}/v1/userinfo`, { headers: { "Authorization": `Bearer ${tok.access_token}` } });
  if (!ur.ok) throw new Error(`google userinfo ${ur.status}`);
  const u = await ur.json();
  if (!u?.sub) throw new Error("google userinfo: no sub");
  return { sub: u.sub, email: u.email };
}

export interface GoogleCalendarExchange { sub: string; email?: string; access_token: string; refresh_token: string; expires_in?: number; }
export async function googleCalendarExchange(g: GoogleEnv, code: string, redirectUri: string): Promise<GoogleCalendarExchange> {
  const tr = await fetch(`${g.tokenBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: g.id, client_secret: g.secret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (!tr.ok) throw new Error(`google calendar token ${tr.status}`);
  const tok = await tr.json();
  if (!tok?.access_token || !tok?.refresh_token) throw new Error("google calendar token: no refresh_token");
  const ur = await fetch(`${g.userinfoBase}/v1/userinfo`, { headers: { "Authorization": `Bearer ${tok.access_token}` } });
  if (!ur.ok) throw new Error(`google calendar userinfo ${ur.status}`);
  const u = await ur.json();
  if (!u?.sub) throw new Error("google calendar userinfo: no sub");
  return { sub: u.sub, email: u.email, access_token: tok.access_token, refresh_token: tok.refresh_token, expires_in: tok.expires_in };
}

export async function googleCalendarRefresh(g: GoogleEnv, refreshToken: string): Promise<{ access_token: string; expires_in?: number }> {
  const tr = await fetch(`${g.tokenBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: g.id, client_secret: g.secret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!tr.ok) throw new Error(`google calendar refresh ${tr.status}`);
  const tok = await tr.json();
  if (!tok?.access_token) throw new Error(`google calendar refresh: ${tok?.error || "no access_token"}`);
  return { access_token: tok.access_token, expires_in: tok.expires_in };
}

export function githubAuthUrl(p: ProviderEnv, state: string, redirectUri: string): string {
  const q = new URLSearchParams({ client_id: p.id, redirect_uri: redirectUri, scope: "read:user", state, allow_signup: "true" });
  return `${p.oauthBase}/login/oauth/authorize?${q}`;
}

// Exchange the auth code for GitHub's STABLE numeric user id (the subject part).
export async function githubExchange(p: ProviderEnv, code: string, redirectUri: string): Promise<{ id: number; login: string }> {
  const tr = await fetch(`${p.oauthBase}/login/oauth/access_token`, {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: p.id, client_secret: p.secret, code, redirect_uri: redirectUri }),
  });
  if (!tr.ok) throw new Error(`github token ${tr.status}`);
  const tok = await tr.json();
  if (!tok?.access_token) throw new Error(`github token: ${tok?.error || "no access_token"}`);
  const ur = await fetch(`${p.apiBase}/user`, {
    headers: { "Authorization": `Bearer ${tok.access_token}`, "User-Agent": "oauth3", "Accept": "application/vnd.github+json" },
  });
  if (!ur.ok) throw new Error(`github /user ${ur.status}`);
  const u = await ur.json();
  if (!u?.id) throw new Error("github /user: no id");
  return { id: u.id, login: u.login };
}

// CSRF `state`: single-use, TTL, carries the return url + optional linkSubject (set when
// a signed-in user is LINKING rather than logging in).
interface St { ret: string; linkSubject?: string; purpose?: string; exp: number; }
const states = new Map<string, St>();
const TTL = 10 * 60_000;

export function newState(ret: string, linkSubject?: string, purpose?: string): string {
  const now = Date.now();
  for (const [k, v] of states) if (v.exp <= now) states.delete(k);
  const s = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  states.set(s, { ret, linkSubject, purpose, exp: now + TTL });
  return s;
}
export function consumeState(s: string): St | null {
  const v = states.get(s);
  if (!v) return null;
  states.delete(s);
  return v.exp > Date.now() ? v : null;
}
