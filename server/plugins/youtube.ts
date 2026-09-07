// YouTube plugin — watch history, with each item flagged `isShort` so a consumer
// (e.g. the doomscroll notifier) can tell Shorts from regular videos.
//
// YouTube renders history three ways and the original port read only the first, so it
// silently dropped every Short and every modern video:
//   - videoRenderer        — legacy items; a Short is tagged by a SHORTS time-status overlay
//   - lockupViewModel      — current regular videos
//   - reelShelfRenderer    — a per-day shelf of shortsLockupViewModel items (this is where
//                            Shorts live now; missing it = no Shorts at all)
// Field paths shift between YouTube builds, so each extractor tries a couple of fallbacks.

import { cookieHeader, Jar, Plugin, PluginItem, PluginListOptions } from "./types.ts";
import { egressFetch } from "../egress.ts";
import { registerRead } from "../reads.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ORIGIN = "https://www.youtube.com";

const item = (id: string, title: string, isShort: boolean): PluginItem => ({ id, title, meta: { isShort } });

// A shorts-shelf entry. Newer builds use shortsLockupViewModel; older use reelItemRenderer.
function parseShort(reel: any): PluginItem | null {
  const slv = reel?.shortsLockupViewModel;
  if (slv) {
    const id = slv.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ||
      String(slv.entityId ?? "").replace(/^history-shorts-shelf-item-/, "");
    const title = slv.overlayMetadata?.primaryText?.content ||
      String(slv.accessibilityText ?? "").replace(/,\s*[\d.,]+[KMB]?\s*views?\b.*$/i, "").trim();
    return id ? item(String(id), title, true) : null;
  }
  const r = reel?.reelItemRenderer;
  if (r?.videoId) return item(String(r.videoId), r.headline?.simpleText ?? "", true);
  return null;
}

// #144: one liked-video entry -> PluginItem. YouTube returns the channel under
// shortBylineText and the length under lengthText.simpleText ("3:04"). Title under
// title.runs[0].text (newer builds also wrap it in an accessibility label).
export function parseLikedItem(pvr: any): PluginItem | null {
  const id = pvr?.videoId;
  if (!id) return null;
  const title = pvr?.title?.runs?.[0]?.text ?? pvr?.title?.accessibility?.accessibilityData?.label ?? "";
  const channel = pvr?.shortBylineText?.runs?.map((r: any) => r?.text ?? "").join("") ?? "";
  const length = pvr?.lengthText?.simpleText ?? "";
  return { id: String(id), title: String(title), meta: { channel, length } };
}

// Shared collector over a contents[] array (both the first page and a continuation
// response use the same per-entry renderer + continuation-token locations).
function collectLiked(contents: any[]): { items: PluginItem[]; cont?: string } {
  const items: PluginItem[] = [];
  let cont: string | undefined;
  for (const c of contents ?? []) {
    if (c?.playlistVideoRenderer) {
      const it = parseLikedItem(c.playlistVideoRenderer);
      if (it) items.push(it);
      continue;
    }
    const token = c?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ??
      c?.continuationItemRenderer?.continuationCommand?.token;
    if (token) cont = String(token);
  }
  return { items, cont };
}

// First page (ytInitialData from /playlist?list=LL): the list lives under
// twoColumnBrowseResultsRenderer.tabs[0].content.playlistVideoListRenderer.contents.
export function parseLikedPage(data: any): { items: PluginItem[]; cont?: string } {
  const contents = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
    ?.playlistVideoListRenderer?.contents ??
    data?.contents?.playlistVideoListRenderer?.contents ?? [];
  return collectLiked(contents);
}

// A browse continuation RESPONSE: items under
// onResponseReceivedActions[].appendContinuationItemsAction.continuationItems.
export function parseLikedContinuation(body: any): { items: PluginItem[]; cont?: string } {
  for (const a of body?.onResponseReceivedActions ?? []) {
    const items = a?.appendContinuationItemsAction?.continuationItems;
    if (items) return collectLiked(items);
  }
  return { items: [] };
}

// SHA-1 -> hex (Web Crypto). Used to build SAPISIDHASH for the InnerTube browse call.
async function sha1hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseHistory(data: any): PluginItem[] {
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  const sections = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  const out: PluginItem[] = [];
  for (const section of sections) {
    for (const it of section?.itemSectionRenderer?.contents ?? []) {
      if (it.reelShelfRenderer) {
        for (const reel of it.reelShelfRenderer.items ?? []) {
          const s = parseShort(reel);
          if (s) out.push(s);
        }
        continue;
      }
      const v = it.videoRenderer;
      if (v?.videoId) {
        const isShort = (v.thumbnailOverlays ?? []).some((o: any) =>
          o.thumbnailOverlayTimeStatusRenderer?.style === "SHORTS");
        out.push(item(String(v.videoId), v.title?.runs?.[0]?.text ?? "", isShort));
        continue;
      }
      const lvm = it.lockupViewModel;
      if (lvm?.contentId) {
        const title = lvm.metadata?.lockupMetadataViewModel?.title?.content ?? "";
        out.push(item(String(lvm.contentId), title, false));
      }
    }
  }
  return out;
}


// #144: the owner's liked-videos playlist (LL). A module function, NOT a member of the plugin:
// a read is not part of the credential contract. Registered into server/reads.ts at the bottom
// of this file and served by handler.ts's one generic named-read route.
// #144: the owner's liked-videos playlist (LL) as structured items. YouTube serves LL only
// via the logged-in InnerTube browse API (it is a private playlist), so we hit
// /youtubei/v1/browse authenticated with a SAPISIDHASH derived from the SAPISID cookie, and
// page via continuation until the playlist is exhausted. The first page is read off the
// /playlist?list=LL HTML (which also yields ytcfg: the API key + client version), so a single
// fetch seeds both the items and the paging context. Errors propagate (never an empty list
// for a logged-out/rotted jar) — a rotted jar must read as "not logged in", not "you liked
// nothing" (the issue's anti-hollow-green bullet).
async function likedVideos(jar: Jar): Promise<PluginItem[]> {
  const sapisid = jar["SAPISID"] || jar["__Secure-3PAPISID"];
  if (!sapisid) throw new Error("youtube liked: not logged in (no SAPISID)");

  const headers = (extra: Record<string, string> = {}) => ({
    "Cookie": cookieHeader(jar),
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9",
    ...extra,
  });

  // First page: fetch the /playlist?list=LL HTML. It carries ytcfg (API key + client
  // version) AND ytInitialData (the first page of items), so one fetch seeds both.
  const page = await egressFetch(`${ORIGIN}/playlist?list=LL`, {
    headers: headers({ "Accept": "text/html,application/xhtml+xml" }),
    signal: AbortSignal.timeout(30_000),
    redirect: "manual",
  });
  if (!page.ok && page.status !== 0) throw new Error(`youtube liked page ${page.status}`);
  const html = await page.text();

  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ||
    html.match(/"clientVersion":"([^"]+)"/)?.[1];
  if (!apiKey || !clientVersion) {
    throw new Error("youtube liked: could not derive InnerTube key/version — cookies likely invalid");
  }
  const context = { client: { clientName: "WEB", clientVersion, hl: "en", gl: "US" } };

  const authHeader = async () => {
    const ts = Math.floor(Date.now() / 1000);
    const h = await sha1hex(`${ts} ${sapisid} ${ORIGIN}`);
    return `SAPISIDHASH ${ts}_${h}`;
  };

  // Parse the first page's items + any continuation token from ytInitialData.
  const dataMatch = html.match(/var ytInitialData\s*=\s*(\{[\s\S]+?\});\s*<\/script>/);
  if (!dataMatch) throw new Error("youtube liked: ytInitialData not found — cookies likely invalid");
  const firstData = JSON.parse(dataMatch[1]);
  const out: PluginItem[] = [];
  let continuation: string | undefined;
  const { items: firstItems, cont: firstCont } = parseLikedPage(firstData);
  out.push(...firstItems);
  continuation = firstCont;

  // Page via continuation until exhausted. Cap at a generous bound so a misbehaving token
  // can't loop forever.
  let guard = 0;
  while (continuation && guard++ < 200) {
    const r = await egressFetch(`${ORIGIN}/youtubei/v1/browse?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
      method: "POST",
      headers: headers({
        "Authorization": await authHeader(),
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": "1",
        "X-YouTube-Client-Version": clientVersion,
        "Accept": "application/json",
      }),
      body: JSON.stringify({ context, continuation }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`youtube liked browse ${r.status}`);
    const body = await r.json();
    const { items: more, cont: moreCont } = parseLikedContinuation(body);
    out.push(...more);
    continuation = moreCont;
  }
  return out;
}

export const youtubePlugin: Plugin = {
  id: "youtube",
  label: "YouTube history",
  // ONLY .youtube.com — a browser fetch to youtube.com sends only youtube.com cookies and
  // authenticates fine. Including .google.com made the extension's flat name->value jar
  // (grabJar: last-write-wins across cookieDomains) overwrite youtube.com's session cookies
  // (__Secure-1PSID/3PSID, SAPISID, …) with .google.com's DIFFERENT values, so the server
  // sent wrong values to youtube.com → logged_in=0 regardless of egress IP or cookie freshness.
  cookieDomains: [".youtube.com"],

  loggedIn(jar: Jar): boolean {
    return !!(jar["SAPISID"] || jar["__Secure-3PAPISID"]);
  },

  async listItems(jar: Jar, _opts?: PluginListOptions): Promise<PluginItem[]> {
    const r = await egressFetch("https://www.youtube.com/feed/history", {
      headers: {
        "Cookie": cookieHeader(jar),
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`youtube history ${r.status}`);
    const m = (await r.text()).match(/var ytInitialData\s*=\s*(\{[\s\S]+?\});\s*<\/script>/);
    if (!m) throw new Error("ytInitialData not found — cookies likely invalid");
    const data = JSON.parse(m[1]);
    // Confirm the session is actually logged in, else we'd parse a public/empty page.
    const loggedIn = (data?.responseContext?.serviceTrackingParams ?? []).some((p: any) =>
      (p.params ?? []).some((pp: any) => pp.key === "logged_in" && pp.value === "1"));
    if (!loggedIn) throw new Error("youtube returned not-logged-in — cookies expired");
    return parseHistory(data);
  },

  fetchItem(_jar: Jar, id: string): Promise<unknown> {
    return Promise.resolve({ id, url: `https://www.youtube.com/watch?v=${id}` });
  },

};

// #144 read, registered rather than declared on the shared Plugin interface (2026-08-19). The
// implementation is unchanged — only where it hangs. `liked` is served by handler.ts's one generic
// named-read route and confined by the same gateRead chokepoint, so `youtube:liked` still cannot
// reach /feed and `youtube:history` still cannot reach here.
registerRead({
  plugin: "youtube",
  kind: "liked",
  label: "the owner's liked-videos playlist (id, title, channel, length)",
  run: likedVideos,
});
