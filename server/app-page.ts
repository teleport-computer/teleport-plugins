// The instance serves its own demo app at GET /app?plugin=<id>. Open it in any
// browser: with the oauth3 extension your browser is your identity (the provider
// carries the whole flow); without it, the SDK's web handshake renders an approve
// link for your OAuth3 room and a poll carries the rest (RFC 0008 — extension
// optional). The page talks to whatever instance served it (derived from its own
// URL), so it works unchanged on a local node or a real pod under any mount prefix.

import { DESIGN_CSS } from "./design.ts";

// Per-plugin display config. Unknown plugins fall back to a generic copy so a new
// adapter is demoable the moment it lands, without editing this file.
const APPS: Record<string, { title: string; noun: string; domain: string }> = {
  otter: { title: "Otter recaps", noun: "conversations", domain: "otter.ai" },
  reddit: { title: "Reddit saved", noun: "saved posts", domain: "reddit.com" },
};

export function appPage(pluginId = "otter"): string {
  const plugin = pluginId.replace(/[^a-z0-9-]/g, "") || "otter";
  const cfg = APPS[plugin] ?? { title: plugin, noun: "items", domain: plugin };
  return `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${cfg.title} — log in with your browser</title>
<style>${DESIGN_CSS}
 /* app demo page local — everything derives from the tokens above */
 body{max-width:40rem;margin:3rem auto;padding:0 1rem}
 h1{font:800 clamp(26px,5vw,32px)/0.96 var(--cond);text-transform:uppercase;letter-spacing:.02em;margin:0 0 4px;color:var(--ink1);text-shadow:var(--off) var(--off) 0 var(--ink2)}
 .sub{color:var(--faint);margin:0 0 22px;font-size:15px}
 .sub b{color:var(--i1-text)}
 .acts{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
 #login[disabled]{opacity:.5;cursor:default}
 /* web-handshake approve link (RFC 0008): same shape as the primary action, plus a hint */
 #approve{display:none;margin:14px 0 0;padding:14px;border-left:6px solid var(--ink1);background:var(--wash1)}
 #approve a{display:inline-block;font:800 14px var(--cond);text-transform:uppercase;letter-spacing:.12em;color:#fff;background:var(--ink1);padding:10px 16px;text-decoration:none;box-shadow:3px 3px 0 var(--rule)}
 #approve .hint{display:block;margin-top:8px;color:var(--faint);font-size:13px}
 /* read-failed / no-wallet banner: ink2 danger note (wash2 + ink2 spine) */
 .err{background:var(--wash2);color:var(--i2-text);border-left:6px solid var(--ink2);padding:12px 14px;font-size:14px}
 .err code{font-family:var(--mono);font-size:12px}
 #result{margin-top:22px}
 .row{padding:10px 0;border-top:1px solid var(--rule)}
 .row b{font-weight:700}
 .row .meta{color:var(--faint);font:12px var(--mono);margin-top:3px;word-break:break-word}
</style></head><body>
  <h1>${cfg.title}</h1>
  <p class=sub>No account, no password. With the <b>oauth3 extension</b> your browser is your identity; without it you approve once in your OAuth3 room — the web handshake carries the rest.</p>
  <div class=acts>
    <button id=login class=btn>Log in with my browser</button>
    <span id=token class="pill bad">no token yet</span>
  </div>
  <div id=approve></div>
  <div id=result></div>
<script>
const PLUGIN = ${JSON.stringify(plugin)};
const NOUN = ${JSON.stringify(cfg.noun)};
const DOMAIN = ${JSON.stringify(cfg.domain)};
// The instance that served this page IS the instance to read from (mount-aware),
// overridable with ?node= for testing.
const NODE = new URLSearchParams(location.search).get("node")
  || (location.origin + location.pathname.replace(/\\/app\\/?$/, ""));
const $ = (id) => document.getElementById(id);
const out = $("result");

function showErr(status, body) {
  const hint = status === 409
    ? " — your " + DOMAIN + " cookies aren't synced to this instance yet. Sign into " + DOMAIN
      + " where the oauth3 extension runs (it copies the jar), then retry here."
    : "";
  out.innerHTML = '<div class=err>read failed (' + status + '): ' + (body && body.error || "unknown") + hint + '</div>';
}

function showApprove(url) {
  $("approve").style.display = "block";
  $("approve").innerHTML = '<a href="' + url + '" target=_blank rel=noopener>Open your OAuth3 room to approve →</a>'
    + '<span class=hint>no extension needed — approve there; this page continues on its own.</span>';
}
function clearApprove() { $("approve").style.display = "none"; $("approve").innerHTML = ""; }

// oauth3-sdk connect() — ported verbatim from oauth3-sdk src/index.ts (the same port
// otterscope carries, webhost-apps PR #143; feedling-web/oauth3-client.ts hand-drives
// the same handshake). Provider-preferred: if the extension provider is present it
// carries the whole flow — copy the jar if needed, approve, hand back a token. Web
// fallback (no extension — phone, same-pod): POST /api/connect, surface the approveUrl
// for the user's signed-in room, poll until the token comes back. RFC 0008: the page
// never touches the injected provider itself — the SDK port decides.
async function oauth3Connect(opts) {
  const prov = globalThis.oauth3 ?? globalThis.window?.oauth3;
  if (prov && typeof prov.connect === "function") {
    const t = await prov.connect({ node: opts.node, plugin: opts.plugin, subject: opts.subject, app: opts.app });
    return t;
  }
  const cr = await fetch(opts.node + "/api/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plugin: opts.plugin, subject: opts.subject, app: opts.app }) });
  const cb = await cr.json().catch(() => ({}));
  if (!cr.ok) throw new Error(cb.error || ("connect " + cr.status));
  await opts.onApproveUrl?.(cb.approveUrl);
  const interval = opts.intervalMs ?? 2000, deadline = Date.now() + (opts.timeoutMs ?? 300000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const s = await (await fetch(opts.node + "/api/connect/" + cb.requestId)).json().catch(() => ({}));
    if (s.status === "approved") return s.token;
    if (s.status === "denied") throw new Error("connect denied by user");
  }
  throw new Error("connect timed out");
}

$("login").addEventListener("click", async () => {
  out.innerHTML = "";
  clearApprove();
  $("login").disabled = true;
  try {
    const token = await oauth3Connect({
      // "demo-app" is the instance demo's entry in the listing gate (server/listing.ts) —
      // an unlisted id is refused by POST /api/connect before any approval can happen.
      node: NODE, plugin: PLUGIN, app: "demo-app",
      onApproveUrl: (url) => showApprove(url),
    });
    clearApprove();
    $("token").className = "pill ok"; $("token").textContent = "scoped token ✓";

    const r = await fetch(NODE + "/api/" + PLUGIN + "/items", { headers: { Authorization: "Bearer " + token } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { showErr(r.status, body); return; }
    const items = body.data || [];
    // scoped-token proof line lives in a deep evidence block (ink2 spine, mono) — this
    // is the receipt that the read used a scoped token, not your cookies.
    out.innerHTML = '<div class=block>'
      + '<div><span class=k>read with</span> scoped token, not your cookies</div>'
      + '<div><span class=k>items</span> ' + items.length + ' ' + NOUN + '</div>'
      + '</div>'
      + items.slice(0, 20).map((it) => '<div class=row><b>' + (it.title || "(untitled)") + '</b>'
        + '<div class=meta>' + (it.date ? new Date(it.date).toLocaleString() : "") + ' · ' + it.id + '</div></div>').join("");
  } catch (e) {
    out.innerHTML = '<div class=err>' + String(e.message || e) + '</div>';
  } finally {
    $("login").disabled = false;
  }
});
</script></body></html>`;
}
