import { after } from "next/server";
import { requireClient, unauthorized } from "@/lib/session";
import { isDbConfigured } from "@/lib/db";
import { claimSync, isStale, readSync, releaseSync, writeSync } from "@/lib/sync-store";
import { syncProject } from "@/lib/sync";
import type { ClientConfig } from "@/lib/clients";
import type { DashboardPayload } from "@/lib/types";

export const runtime = "nodejs";

// A cold sync took 33.9s on 2026-08-11 and 60.3s half an hour later, on the same
// data — GHL's response time swings by nearly 2x. 300s leaves room for that plus
// growth.
//
// This needs Fluid Compute enabled (Settings → Functions), which is what raises the
// cap to 300s — the plan itself does not: Hobby with Fluid allows it. Without Fluid
// the cap is 60s, which a real 60.3s sync already exceeded, and a refresh killed
// mid-flight fails SILENTLY because it runs after the response was sent.
export const maxDuration = 300;

function enc(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export async function GET(req: Request) {
  // Resolve the client here, in the request scope — cookies() is unavailable both
  // inside the stream callback and inside after().
  const client = await requireClient();
  if (!client) return unauthorized();

  const forceFresh = new URL(req.url).searchParams.get("fresh") === "1";

  // The cache is an accelerator, never a dependency: any database failure logs and
  // falls through to the live sync, exactly as the app behaved before it existed.
  const cached = forceFresh ? null : await readCache(client);

  if (cached) {
    // Warm path: one frame, no progress, no GHL. This is the whole point.
    const body = enc({ type: "data", ...cached.payload });
    if (isStale(cached.syncedAt)) {
      // after() runs once the response is fully sent, so the user never waits on
      // this. Without it the function would be torn down as soon as the response
      // closed and the refresh would silently never happen.
      after(() => refreshInBackground(client));
    }
    return ndjson(body);
  }

  // Cold path (never synced, ?fresh=1, or the database is unreachable): stream the
  // live sync with the loading screen, exactly as before, and cache the result.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // The client context is entered inside syncProject, not around GET(): the
      // stream keeps producing frames after GET() has returned, so wrapping the
      // handler would leave the pump running outside the context (where
      // currentClient() throws).
      const send = (obj: unknown) => controller.enqueue(encoder.encode(enc(obj)));
      try {
        const payload = await syncProject(client, send);
        send({ type: "data", ...payload });
        await saveQuietly(client, payload);
      } catch (error) {
        console.error("[GHL Dashboard API Error]", error);
        send({
          type: "error",
          error: "Failed to fetch dashboard data",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        controller.close();
      }
    },
  });
  return ndjson(stream);
}

function ndjson(body: BodyInit): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

async function readCache(client: ClientConfig) {
  if (!isDbConfigured()) return null;
  try {
    return await readSync(client);
  } catch (err) {
    console.error("[cache] read failed, falling back to a live sync:", err);
    return null;
  }
}

// A cache write must never break a response the user already got.
async function saveQuietly(client: ClientConfig, payload: DashboardPayload) {
  if (!isDbConfigured()) return;
  try {
    await writeSync(client, payload);
  } catch (err) {
    console.error("[cache] write failed:", err);
  }
}

// Runs after the response. Nothing here can reach the user, so every failure path
// ends in a log — but the lock MUST be released either way, or the project stops
// refreshing until the 10-minute timeout expires.
async function refreshInBackground(client: ClientConfig) {
  let claimed = false;
  try {
    claimed = await claimSync(client);
    // Someone else is already syncing this project: two people opening the same
    // stale project at once must produce one sync, not two.
    if (!claimed) return;
    const payload = await syncProject(client);
    // writeSync clears sync_started_at itself, so the success path needs no release.
    await writeSync(client, payload);
    console.log(`[cache] ${client.id} refrescado en segundo plano`);
  } catch (err) {
    console.error(`[cache] background refresh failed for ${client.id}:`, err);
    if (claimed) {
      // Release WITHOUT touching the payload: the last good cache stays, because
      // an hour-old dashboard beats no dashboard.
      await releaseSync(client, err instanceof Error ? err.message : String(err)).catch(() => {});
    }
  }
}
