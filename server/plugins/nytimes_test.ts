// #12: nytimes is a browser-path plugin — the availability marker contract.
// GET /api/plugins must carry `path:"browser", available:false` on the nytimes entry ONLY;
// every other entry keeps its exact current shape (no extra keys), so listings/dashboards
// that don't know the marker are unaffected. The loud datadome-403 read failure itself is
// verified LIVE against staging (Tier 1 transcript in the PR) — it is deliberately not
// mocked here and this diff does not touch that code path.

import { assertEquals } from "jsr:@std/assert";
import handler from "../handler.ts";

const OWNER = "test-owner-secret";

function ctx() {
  return { env: { OWNER_SECRET: OWNER }, dataDir: "" };
}

async function call(method: string, path: string): Promise<Response> {
  return await handler(
    new Request(`http://oauth3.test${path}`, {
      method,
      headers: { "Authorization": `Bearer ${OWNER}` },
    }),
    ctx(),
  );
}

Deno.test("nytimes #12: /api/plugins marks browser-path + unavailable", async () => {
  const r = await call("GET", "/api/plugins");
  assertEquals(r.status, 200);
  const j = await r.json();
  const nyt = j.plugins.find((p: { id: string }) => p.id === "nytimes");
  assertEquals(nyt.path, "browser");
  assertEquals(nyt.available, false);
});

Deno.test("nytimes #12: every other plugin entry keeps its current shape", async () => {
  const r = await call("GET", "/api/plugins");
  const j = await r.json();
  const others = j.plugins.filter((p: { id: string }) => p.id !== "nytimes");
  for (const p of others) {
    // The pre-#12 serialization keys, and nothing more — save the intentional additions
    // since: #12's own path/available (nytimes itself, excluded above), and #133's
    // tokenSource, declared ONLY by plugins whose credential is not a cookie (codex) so
    // the extension can sync it. Any other key on any other plugin is still a regression.
    const base = ["account", "cookieDomains", "id", "jars", "label"];
    const extra = Object.keys(p).filter((k) => !base.includes(k));
    assertEquals(extra, p.id === "codex" && "tokenSource" in p ? ["tokenSource"] : []);
  }
});
