// Google Calendar delegated access through the documented Calendar v3 API.
// The vault jar for this plugin contains OAuth data (refresh_token and a short-lived
// access_token), not Google cookies. Event writes remain gated by the handler's exact
// write:event:<id> capability from #69.

import { googleCalendarRefresh, googleEnv } from "../oidc.ts";
import { Jar, Plugin, PluginItem } from "./types.ts";

let env: Record<string, string> = {};
export function configureGoogleCalendar(next: Record<string, string>): void {
  env = next;
}

const apiBase = () =>
  (env.GOOGLE_CALENDAR_API_BASE || "https://www.googleapis.com/calendar/v3").replace(/\/$/, "");

async function accessToken(jar: Jar): Promise<string> {
  if (!jar.refresh_token) throw new Error("google calendar is not connected");
  if (jar.access_token && Number(jar.access_token_expires_at || 0) > Date.now() + 30_000) {
    return jar.access_token;
  }
  const g = googleEnv(env);
  if (!g) throw new Error("google OAuth is not configured");
  const refreshed = await googleCalendarRefresh(g, jar.refresh_token);
  jar.access_token = refreshed.access_token;
  jar.access_token_expires_at = String(Date.now() + (refreshed.expires_in || 3600) * 1000);
  return jar.access_token;
}

async function calendarFetch(jar: Jar, path: string, init: RequestInit = {}): Promise<any> {
  const token = await accessToken(jar);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(
      `google calendar ${init.method || "GET"} ${path} ${response.status}: ${await response
        .text()}`,
    );
  }
  return await response.json();
}

export const googleCalendarPlugin: Plugin = {
  id: "google-calendar",
  label: "Google Calendar",
  cookieDomains: [],
  renderUrl: "https://calendar.google.com/calendar/u/0/r",

  loggedIn(jar: Jar): boolean {
    return !!jar.refresh_token;
  },

  async listItems(jar: Jar): Promise<PluginItem[]> {
    const q = new URLSearchParams({
      timeMin: new Date().toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    });
    const data = await calendarFetch(jar, `/calendars/primary/events?${q}`);
    return (data.items || []).map((event: any) => ({
      id: event.id,
      title: event.summary || "(untitled)",
      date: event.start?.dateTime || event.start?.date,
    }));
  },

  async fetchItem(jar: Jar, id: string): Promise<unknown> {
    return await calendarFetch(jar, `/calendars/primary/events/${encodeURIComponent(id)}`);
  },

  async editItem(jar: Jar, id: string, patch: unknown): Promise<unknown> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("calendar changes must be an object");
    }
    const changes = { ...(patch as Record<string, unknown>) };
    if ("title" in changes && !("summary" in changes)) changes.summary = changes.title;
    delete changes.title;
    return await calendarFetch(jar, `/calendars/primary/events/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
  },
};
