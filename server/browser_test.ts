// RFC 0001 M0 (#41): the capture-trace consumer contract.
//   - every browser SPI control call carries the bearer (the deployed bridge is
//     BRIDGE_SECRET-gated; without it /capture-trace is never even reached);
//   - a 200 trace without network_log is a broken capture and fails loud — it is never
//     laundered into an empty log.

import { browserCaptureTrace, requireNetworkLog } from "./browser.ts";
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { Jar, Plugin } from "./plugins/types.ts";

const plugin: Plugin = {
  id: "t",
  site: "t",
  cookieDomains: [".t.example"],
} as unknown as Plugin;
const jar: Jar = { session: "s" };

Deno.test("requireNetworkLog: returns the log when present", () => {
  assertEquals(requireNetworkLog({ network_log: [{ url: "u" }] }), [{ url: "u" }]);
});

Deno.test("requireNetworkLog: a trace without network_log fails loud, not empty", () => {
  const err = assertThrows(() => requireNetworkLog({ network_log: undefined, ...{ screenshot: "x" } }), Error);
  assertEquals(err.message.includes("no network_log"), true);
});

Deno.test("browserCaptureTrace: threads the secret to every SPI call and surfaces network_log", async () => {
  const calls: { path: string; auth?: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, auth: (init?.headers as Record<string, string>)?.Authorization });
    const body = path === "/capture-trace"
      ? { screenshot: "s", title: "t", dom_html: "<html>", network_log: [{ url: "https://t.example/x", response_body: "{}" }] }
      : {};
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
  try {
    const t = await browserCaptureTrace("https://spi.example", plugin, jar, "https://t.example/", "sekrit");
    assertEquals(calls.map((c) => c.path), ["/session", "/navigate", "/capture-trace"]);
    assertEquals(calls.every((c) => c.auth === "Bearer sekrit"), true);
    assertEquals((t.network_log as Array<{ response_body: string }>)[0].response_body, "{}");
    assertEquals(t.dom_html, "<html>");
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("browserCaptureTrace: a 200 /capture-trace with no network_log throws", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
    const path = new URL(String(_url)).pathname;
    return Promise.resolve(new Response(
      JSON.stringify(path === "/capture-trace" ? { screenshot: "s", dom_html: "<html>" } : {}),
      { status: 200 },
    ));
  }) as typeof fetch;
  try {
    const err = await assertRejects(
      () => browserCaptureTrace("https://spi.example", plugin, jar, "https://t.example/", ""),
      Error,
    );
    assertEquals(err.message.includes("no network_log"), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
