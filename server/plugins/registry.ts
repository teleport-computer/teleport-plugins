import { Plugin } from "./types.ts";
import { otterPlugin } from "./otter.ts";
import { youtubePlugin } from "./youtube.ts";
import { redditPlugin } from "./reddit.ts";
import { nytimesPlugin } from "./nytimes.ts";
import { twitterPlugin } from "./twitter.ts";
import { googleCalendarPlugin } from "./google-calendar.ts";
import { amazonPlugin } from "./amazon.ts";
import { zaiPlugin } from "./zai.ts";
import { codexPlugin } from "./codex.ts";
import { loadSites } from "./declarative.ts";

const plugins = new Map<string, Plugin>();
for (const p of [otterPlugin, youtubePlugin, redditPlugin, nytimesPlugin, twitterPlugin, googleCalendarPlugin, amazonPlugin, zaiPlugin, codexPlugin]) plugins.set(p.id, p);

// Declarative longtail sites (./sites/*.json) — no code, no core edit per site.
for (const p of loadSites().plugins) plugins.set(p.id, p);

export function getPlugin(id: string): Plugin | undefined { return plugins.get(id); }
export function allPlugins(): Plugin[] { return [...plugins.values()]; }
// Runtime registration of a declarative site (POST /api/sites), via sites.ts.
export function registerSitePlugin(p: Plugin): void { plugins.set(p.id, p); }
export function unregisterSitePlugin(id: string): boolean { return plugins.delete(id); }
