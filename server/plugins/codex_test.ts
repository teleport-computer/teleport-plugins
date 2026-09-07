import { assert, assertEquals } from "jsr:@std/assert";
import { codexPlugin, configureCodex, parseCodexUsage } from "./codex.ts";

const FIXTURE = JSON.parse(
  await Deno.readTextFile(new URL("./codex_usage_fixture.json", import.meta.url)),
);
Deno.test("codex usage: parses the committed wham fixture", () =>
  assertEquals(parseCodexUsage(FIXTURE), {
    fiveHourPct: 25,
    fiveHourResetIso: new Date(1784246400 * 1000).toISOString(),
    weeklyPct: 18,
    weeklyResetIso: new Date(1784846400 * 1000).toISOString(),
    planType: "pro",
  }));
Deno.test("codex usage: rejects missing windows instead of inventing zeros", () => {
  try {
    parseCodexUsage({ rate_limits: { primary: {} } });
    throw new Error("expected parser to reject incomplete response");
  } catch (e) {
    assert(/secondary|missing object/.test((e as Error).message));
  }
});
Deno.test("codex usage: declares local-storage bearer source and quota-only surface", async () => {
  assertEquals(codexPlugin.tokenSource?.jarKey, "codex_token");
  assertEquals(codexPlugin.tokenSource?.origin, "https://chatgpt.com");
  assertEquals(codexPlugin.loggedIn({ codex_token: "x" }), true);
  await codexPlugin.listItems({ codex_token: "x" }).then(() => {
    throw new Error("expected no items");
  }, (e) => assert(/quota-only/.test(e.message)));
});
Deno.test("codex usage: mock endpoint sends bearer and product headers", async () => {
  let seen: Headers | undefined;
  let server: Deno.HttpServer;
  const addr = await new Promise<string>((resolve) => {
    server = Deno.serve({
      port: 0,
      hostname: "127.0.0.1",
      onListen: (a) => resolve(`http://${a.hostname}:${a.port}`),
    }, (req) => {
      seen = req.headers;
      return Response.json(FIXTURE);
    });
  });
  configureCodex({ CODEX_BASE: addr });
  const data = await codexPlugin.quota!({ codex_token: "fixture-token" });
  assertEquals((data as Record<string, unknown>).weeklyPct, 18);
  assertEquals(seen?.get("Authorization"), "Bearer fixture-token");
  assertEquals(seen?.get("OAI-Product-Sku"), "CODEX");
  await server!.shutdown();
});
