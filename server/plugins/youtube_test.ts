// #144: unit tests for the liked-videos extractors. YouTube's InnerTube shape shifts between
// builds, so these pin the field paths we rely on (videoId, title.runs[0].text,
// shortBylineText, lengthText.simpleText) + the continuation-token location for both the
// first page (ytInitialData) and a browse continuation response. Fixture-based — no network.
// #54 adds parseHistory date-stamping tests below, same fixture discipline.

import { assert, assertEquals } from "jsr:@std/assert";
import { parseHistory, parseLikedContinuation, parseLikedItem, parseLikedPage } from "./youtube.ts";

Deno.test("parseLikedItem: id + title + channel + length from a playlistVideoRenderer", () => {
  const pvr = {
    videoId: "dQw4w9WgXcQ",
    title: { runs: [{ text: "Never Gonna Give You Up (Official Video)" }] },
    shortBylineText: { runs: [{ text: "Rick Astley" }, { text: " · " }, { text: "Topic" }] },
    lengthText: { accessibility: { accessibilityData: { label: "3 minutes, 33 seconds" } }, simpleText: "3:33" },
  };
  assertEquals(parseLikedItem(pvr), {
    id: "dQw4w9WgXcQ",
    title: "Never Gonna Give You Up (Official Video)",
    meta: { channel: "Rick Astley · Topic", length: "3:33" },
  });
});

Deno.test("parseLikedItem: null when no videoId (continuation/telemetry entries)", () => {
  assertEquals(parseLikedItem({}), null);
  assertEquals(parseLikedItem({ continuationItemRenderer: {} }), null);
});

Deno.test("parseLikedItem: falls back to accessibility label when title.runs is absent", () => {
  const pvr = {
    videoId: "abc123",
    title: { accessibility: { accessibilityData: { label: "Some Title - 4:20" } } },
    shortBylineText: { runs: [{ text: "Chan" }] },
    lengthText: { simpleText: "4:20" },
  };
  assertEquals(parseLikedItem(pvr)!.title, "Some Title - 4:20");
  assertEquals(parseLikedItem(pvr)!.meta, { channel: "Chan", length: "4:20" });
});

// The first-page shape: ytInitialData.contents.twoColumnBrowseResultsRenderer.tabs[0]
// .tabRenderer.content.playlistVideoListRenderer.contents, with a trailing
// continuationItemRenderer holding the next-page token.
Deno.test("parseLikedPage: items + continuation token from the first-page shape", () => {
  const data = {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{
          tabRenderer: {
            content: {
              playlistVideoListRenderer: {
                contents: [
                  { playlistVideoRenderer: { videoId: "v1", title: { runs: [{ text: "A" }] }, shortBylineText: { runs: [{ text: "C1" }] }, lengthText: { simpleText: "1:00" } } },
                  { playlistVideoRenderer: { videoId: "v2", title: { runs: [{ text: "B" }] }, shortBylineText: { runs: [{ text: "C2" }] }, lengthText: { simpleText: "2:00" } } },
                  { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "NEXT_PAGE_TOKEN" } } } },
                ],
              },
            },
          },
        }],
      },
    },
  };
  const { items, cont } = parseLikedPage(data);
  assertEquals(items.length, 2);
  assertEquals(items[0], { id: "v1", title: "A", meta: { channel: "C1", length: "1:00" } });
  assertEquals(items[1].id, "v2");
  assertEquals(cont, "NEXT_PAGE_TOKEN");
});

// Continuation responses may put the token under either continuationEndpoint or
// continuationCommand directly across builds — collectLiked checks both.
Deno.test("parseLikedContinuation: appendContinuationItemsAction items + token", () => {
  const body = {
    onResponseReceivedActions: [{
      appendContinuationItemsAction: {
        continuationItems: [
          { playlistVideoRenderer: { videoId: "v3", title: { runs: [{ text: "C" }] }, shortBylineText: { runs: [{ text: "C3" }] }, lengthText: { simpleText: "3:00" } } },
          { continuationItemRenderer: { continuationCommand: { token: "PAGE3_TOKEN" } } },
        ],
      },
    }],
  };
  const { items, cont } = parseLikedContinuation(body);
  assertEquals(items.length, 1);
  assertEquals(items[0].id, "v3");
  assertEquals(cont, "PAGE3_TOKEN");
});

Deno.test("parseLikedContinuation: no actions -> empty, no token", () => {
  assertEquals(parseLikedContinuation({}), { items: [] });
  assertEquals(parseLikedContinuation({ onResponseReceivedActions: [] }), { items: [] });
});

Deno.test("parseLikedPage: empty/missing contents -> empty, no token (never throws)", () => {
  assertEquals(parseLikedPage({}), { items: [], cont: undefined });
  assertEquals(parseLikedPage({ contents: { twoColumnBrowseResultsRenderer: { tabs: [] } } }), { items: [], cont: undefined });
});

// --- #54: parseHistory stamps each item with its day-section header as `date` (ISO) ---

const section = (label: string, ...contents: unknown[]) => {
  const runs = label ? [{ text: label }] : [];
  return {
    itemSectionRenderer: {
      header: { itemSectionHeaderRenderer: { title: { runs } } },
      contents,
    },
  };
};
const video = (id: string) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: `video ${id}` }] } } });
const lockup = (id: string) => ({
  lockupViewModel: {
    contentId: id,
    metadata: { lockupMetadataViewModel: { title: { content: `video ${id}` } } },
  },
});
const reel = (id: string, title: string) => ({
  shortsLockupViewModel: {
    entityId: `history-shorts-shelf-item-${id}`,
    overlayMetadata: { primaryText: { content: title } },
  },
});
const page = (...sections: unknown[]) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: sections } } } }],
    },
  },
});

Deno.test("parseHistory: day-section header stamps every item's date", () => {
  // Fixed "now" (2026-08-27 14:03) so the relative-label assertions are deterministic.
  const now = new Date(2026, 7, 27, 14, 3);
  const items = parseHistory(
    page(
      section("Today", video("a1"), { reelShelfRenderer: { items: [reel("s1", "short one")] } }),
      section("Yesterday", lockup("b1")),
      section("Aug 25", video("c1"), lockup("c2")),
      section("July 12, 2025", video("d1")),
      section("", video("e1")), // continuation-style section: empty header, items undated
    ),
    now,
  );
  assertEquals(items.length, 7);
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assertEquals(byId["a1"].date, "2026-08-27", "Today resolves to now's ISO date");
  assertEquals(byId["s1"].date, "2026-08-27", "shorts inherit their day section's date");
  assertEquals(byId["b1"].date, "2026-08-26", "Yesterday resolves to now minus one day");
  assertEquals(byId["c1"].date, "2026-08-25");
  assertEquals(byId["c2"].date, "2026-08-25");
  assertEquals(byId["d1"].date, "2025-07-12", "explicit year is kept verbatim");
  assert(byId["e1"].date === undefined, "empty header leaves date unset");
  assertEquals(byId["e1"].id, "e1", "undated items are still returned, never dropped");
});

Deno.test("parseHistory: year-less month/day wraps to last year when in the future", () => {
  // YouTube omits the year only for the current year: a "Dec 30" header seen on 2026-08-27
  // must be 2025-12-30, not a future date.
  const items = parseHistory(page(section("Dec 30", video("w1"))), new Date(2026, 7, 27));
  assertEquals(items[0].date, "2025-12-30");
});

Deno.test("parseHistory: unparseable header leaves items undated, not dropped", () => {
  const items = parseHistory(
    page(
      section("Watched earlier this week", video("u1")), // not a date format we recognize
      section("Today", video("u2")),
    ),
    new Date(2026, 7, 27),
  );
  assertEquals(items.length, 2);
  assert(items[0].date === undefined, "unparseable header must not guess a date");
  assertEquals(items[0].id, "u1", "item under an unparseable header is still returned");
  assertEquals(items[1].date, "2026-08-27");
});
