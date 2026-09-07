import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { googleCalendarAuthUrl, googleCalendarExchange } from "../oidc.ts";
import { configureGoogleCalendar, googleCalendarPlugin } from "./google-calendar.ts";

Deno.test("google calendar uses Calendar v3 and maps upcoming events", async () => {
  configureGoogleCalendar({
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_API_BASE: "https://calendar.test/v3",
    GOOGLE_TOKEN_BASE: "https://oauth.test",
  });
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.startsWith("https://oauth.test/token")) {
      return Response.json({ access_token: "fresh", expires_in: 3600 });
    }
    return Response.json({
      items: [{ id: "evt-1", summary: "Planning", start: { dateTime: "2026-07-19T10:00:00Z" } }],
    });
  };
  try {
    assertEquals(googleCalendarPlugin.loggedIn({ refresh_token: "refresh" }), true);
    const items = await googleCalendarPlugin.listItems({ refresh_token: "refresh" });
    assertEquals(items, [{ id: "evt-1", title: "Planning", date: "2026-07-19T10:00:00Z" }]);
    assertStringIncludes(requests[1].url, "/calendars/primary/events?");
    assertStringIncludes(requests[1].url, "singleEvents=true");
    assertEquals(requests[1].headers.get("Authorization"), "Bearer fresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("google calendar edits one event with a Calendar PATCH", async () => {
  configureGoogleCalendar({
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_CALENDAR_API_BASE: "https://calendar.test/v3",
    GOOGLE_TOKEN_BASE: "https://oauth.test",
  });
  const originalFetch = globalThis.fetch;
  let patch: Request | undefined;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.includes("/token")) {
      return Response.json({ access_token: "fresh", expires_in: 3600 });
    }
    patch = request;
    return Response.json({ id: "evt-1", summary: "Renamed" });
  };
  try {
    await googleCalendarPlugin.editItem!({ refresh_token: "refresh" }, "evt-1", {
      title: "Renamed",
    });
    assertEquals(patch!.method, "PATCH");
    assertEquals(patch!.url, "https://calendar.test/v3/calendars/primary/events/evt-1");
    assertEquals(await patch!.json(), { summary: "Renamed" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("google calendar consent requests offline calendar scope", async () => {
  const url = new URL(
    googleCalendarAuthUrl(
      {
        id: "client",
        secret: "secret",
        authBase: "https://accounts.test",
        tokenBase: "https://oauth.test",
        userinfoBase: "https://userinfo.test",
      },
      "state",
      "https://app.test/callback",
    ),
  );
  assertStringIncludes(
    url.searchParams.get("scope")!,
    "https://www.googleapis.com/auth/calendar.events",
  );
  assertEquals(url.searchParams.get("access_type"), "offline");
  assertEquals(url.searchParams.get("prompt"), "consent");
});

Deno.test("google calendar exchange requires and returns a refresh token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/token")) {
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    }
    return Response.json({ sub: "sub-1", email: "owner@example.test" });
  };
  try {
    const grant = await googleCalendarExchange(
      {
        id: "client",
        secret: "secret",
        authBase: "https://accounts.test",
        tokenBase: "https://oauth.test",
        userinfoBase: "https://userinfo.test",
      },
      "code",
      "https://app.test/callback",
    );
    assertEquals(grant.refresh_token, "refresh");
    assertEquals(grant.sub, "sub-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
