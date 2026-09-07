// The reads registry is the seam that stops the Plugin interface growing a member every time one
// site learns one new API shape. These tests pin the properties that make that safe.
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getRead, readsOf, registerRead, unregisterReads } from "./reads.ts";
import { validateManifest } from "./plugins/declarative.ts";

const jar = { SID: "x" };

Deno.test("a registered read is retrievable by (plugin, kind)", () => {
  registerRead({ plugin: "t-a", kind: "widgets", label: "l", run: () => Promise.resolve([1, 2]) });
  const r = getRead("t-a", "widgets");
  assertEquals(r?.kind, "widgets");
  assertEquals(getRead("t-a", "nope"), undefined);
  assertEquals(getRead("other", "widgets"), undefined); // never leaks across plugins
  unregisterReads("t-a");
});

Deno.test("a reserved kind is refused — it would silently shadow, or be shadowed by, a bespoke route", () => {
  for (const kind of ["items", "account", "quota", "feed", "live", "frame", "screenshot", "jar"]) {
    assertThrows(
      () => registerRead({ plugin: "t-b", kind, label: "l", run: () => Promise.resolve(1) }),
      Error,
      "bespoke route",
    );
  }
});

Deno.test("a duplicate (plugin, kind) is a bug, not an override — two reads on one URL", () => {
  registerRead({ plugin: "t-c", kind: "dup", label: "l", run: () => Promise.resolve(1) });
  assertThrows(
    () => registerRead({ plugin: "t-c", kind: "dup", label: "l2", run: () => Promise.resolve(2) }),
    Error,
    "already registered",
  );
  unregisterReads("t-c");
});

Deno.test("a non-url-safe kind is refused (it would not match the route)", () => {
  assertThrows(
    () =>
      registerRead({
        plugin: "t-d",
        kind: "Liked Videos",
        label: "l",
        run: () => Promise.resolve(1),
      }),
    Error,
    "url-safe",
  );
});

Deno.test("unregisterReads drops only that plugin's reads, and reports how many", () => {
  registerRead({ plugin: "t-e", kind: "one", label: "l", run: () => Promise.resolve(1) });
  registerRead({ plugin: "t-e", kind: "two", label: "l", run: () => Promise.resolve(1) });
  registerRead({ plugin: "t-f", kind: "one", label: "l", run: () => Promise.resolve(1) });
  assertEquals(readsOf("t-e").length, 2);
  assertEquals(unregisterReads("t-e"), 2);
  assertEquals(readsOf("t-e").length, 0);
  assertEquals(getRead("t-f", "one")?.plugin, "t-f"); // untouched
  unregisterReads("t-f");
});

Deno.test("youtube:liked survives the move off the Plugin interface", async () => {
  await import("./plugins/youtube.ts"); // registration happens at module scope
  const r = getRead("youtube", "liked");
  assertEquals(r?.kind, "liked");
  assertEquals(r?.plugin, "youtube");
});

// The manifest half: a site is no longer capped at three read shapes.
Deno.test("a manifest may declare a read kind beyond items/account/item", () => {
  validateManifest({
    id: "t-site",
    label: "T",
    cookieDomains: [".example.com"],
    loginCookie: "u",
    reads: { items: { url: "https://example.com/i" }, liked: { url: "https://example.com/l" } },
    scopes: [{ id: "t-site:liked", reads: ["liked"], label: "read-only · likes" }],
    capability: "CAN read likes. CANNOT write.",
  } as any);
});

Deno.test("a manifest scope still cannot grant a read the manifest never declared", () => {
  assertThrows(
    () =>
      validateManifest({
        id: "t-site2",
        label: "T",
        cookieDomains: [".example.com"],
        loginCookie: "u",
        reads: { items: { url: "https://example.com/i" } },
        scopes: [{ id: "t-site2:ghost", reads: ["ghost"], label: "l" }],
        capability: "CAN x. CANNOT y.",
      } as any),
    Error,
    "doesn't declare",
  );
});

Deno.test("a named read is still host-pinned to the manifest's cookieDomains", () => {
  assertThrows(
    () =>
      validateManifest({
        id: "t-site3",
        label: "T",
        cookieDomains: [".example.com"],
        loginCookie: "u",
        reads: {
          items: { url: "https://example.com/i" },
          liked: { url: "https://evil.test/steal" },
        },
        capability: "CAN x. CANNOT y.",
      } as any),
    Error,
    "is not a cookieDomain",
  );
});
