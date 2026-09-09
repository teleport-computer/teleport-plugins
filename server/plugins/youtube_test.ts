// #11 — youtube fetchItem: real per-video metadata via the InnerTube player API.
// Verified against a LOCAL 127.0.0.1 mock answering /youtubei/v1/player with the SAME
// shapes YouTube serves live (fixtures below are trimmed from real player responses —
// including the UNPLAYABLE-but-detailed and bot-wall cases observed on 2026-08-15), so
// the contract is pinned without live network in tests. Live behavior is separately
// proven on staging in the PR's Tier 1 transcript.

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { configureYoutube, youtubePlugin } from "./youtube.ts";

// Real jNQXAC9IVRw player response (trimmed): UNPLAYABLE yet fully detailed — the
// "resolved" signal is videoDetails.title+author, NOT playabilityStatus === "OK".
const ZOO = {
  playabilityStatus: { status: "UNPLAYABLE", reason: "This video is unavailable in embedded players" },
  videoDetails: {
    videoId: "jNQXAC9IVRw",
    title: "Me at the zoo",
    lengthSeconds: "19",
    channelId: "UC4QobU6STFB0P71PMvOGN5A",
    shortDescription:
      'Microplastics are accumulating in human brains at an alarming rate\nhttps://www.youtube.com/watch?v=0PT5c1z3LL8\n\n\u201cNanoplastics and Human Health\u201d',
    viewCount: "404886875",
    author: "jawed",
    isLiveContent: false,
  },
};
// Real bogus-id shape: ERROR, reason, NO videoDetails at all.
const BOGUS = {
  playabilityStatus: { status: "ERROR", reason: "Video unavailable" },
};
// Real datacenter-egress shape (observed on staging): bot-wall, no videoDetails.
const BOTWALL = {
  playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" },
};

let base = "";
let server: { shutdown(): Promise<void> } | undefined;
let lastBody: { videoId?: string } = {};

// The mock dispatches on videoId in the POST body — per-call deterministic, 127.0.0.1 only.
async function handler(req: Request): Promise<Response> {
  const u = new URL(req.url);
  if (u.pathname !== "/youtubei/v1/player" || req.method !== "POST") {
    return new Response("not found", { status: 404 });
  }
  lastBody = await req.json();
  const id = String(lastBody.videoId ?? "");
  const payload = id === "jNQXAC9IVRw"
    ? ZOO
    : id === "ZZZZZZZZZZZ"
    ? BOGUS
    : id === "BOTWALL1"
    ? BOTWALL
    : id === "NOTJSON"
    ? null
    : BOGUS;
  if (payload === null) return new Response("<html>not json</html>", { status: 200 });
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("youtube fetchItem: start mock server", async () => {
  const ready = Promise.withResolvers<string>();
  server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: (a) => ready.resolve(`http://${a.hostname}:${a.port}`) },
    handler,
  );
  base = await ready.promise;
  configureYoutube({ YOUTUBE_BASE: base });
});

Deno.test("youtube fetchItem: returns real title/channel for a resolved id", async () => {
  const d = await youtubePlugin.fetchItem({ SAPISID: "x" }, "jNQXAC9IVRw") as Record<string, unknown>;
  assertEquals(d.id, "jNQXAC9IVRw");
  assertEquals(d.title, "Me at the zoo");
  assertEquals(d.channel, "jawed");
  assertEquals(d.channelId, "UC4QobU6STFB0P71PMvOGN5A");
  assertEquals(d.lengthSeconds, "19");
  assertEquals(d.viewCount, "404886875");
  assertEquals(d.url, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  // the requested id rode the InnerTube POST body
  assertEquals(lastBody.videoId, "jNQXAC9IVRw");
});

Deno.test("youtube fetchItem: unresolvable id THROWS (never a shaped-but-empty object)", async () => {
  await assertRejects(
    () => youtubePlugin.fetchItem({}, "ZZZZZZZZZZZ"),
    Error,
    "Video unavailable",
  );
});

Deno.test("youtube fetchItem: bot-walled egress is an honest error, not empty data", async () => {
  await assertRejects(
    () => youtubePlugin.fetchItem({}, "BOTWALL1"),
    Error,
    "not a bot",
  );
});

Deno.test("youtube fetchItem: non-JSON player response throws", async () => {
  await assertRejects(
    () => youtubePlugin.fetchItem({}, "NOTJSON"),
    Error,
    "not JSON",
  );
});

Deno.test("youtube fetchItem: stop mock server", async () => {
  await server!.shutdown();
  configureYoutube({ YOUTUBE_BASE: "" }); // restore live base for any later test
});
