// #144: unit tests for the liked-videos extractors. YouTube's InnerTube shape shifts between
// builds, so these pin the field paths we rely on (videoId, title.runs[0].text,
// shortBylineText, lengthText.simpleText) + the continuation-token location for both the
// first page (ytInitialData) and a browse continuation response. Fixture-based — no network.

import { assert, assertEquals } from "jsr:@std/assert";
import { parseLikedContinuation, parseLikedItem, parseLikedPage } from "./youtube.ts";

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
