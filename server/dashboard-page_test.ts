import { assert, assertStringIncludes } from "jsr:@std/assert";
import { dashboardPage } from "./dashboard-page.ts";

Deno.test("dashboard groups live tokens by app and exposes bulk revoke", () => {
  const page = dashboardPage();

  assertStringIncludes(page, "const groups=new Map()");
  assertStringIncludes(page, "data-app-group");
  assertStringIncludes(page, "data-revoke-app");
  assertStringIncludes(page, "revoke all");
  assert(page.includes("t.app||'(unnamed app)'"));
});
