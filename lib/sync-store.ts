// lib/sync-store.ts
// The cache: one row per project holding the whole dashboard payload, gzipped.
//
// The cache is DISPOSABLE by design. It is overwritten on every sync and holds
// only the present, never history — so if the table is dropped, it refills itself
// from GHL and nothing is lost. That property is what keeps this one table instead
// of a schema, and it is also what keeps historical personal data from piling up.
//
// bytea + gzip rather than jsonb: we never query inside the payload, we ship it
// whole. Measured on the real Yconia dataset — 27.7 MB → 2.49 MB, 11.1x.
import { gzipSync, gunzipSync } from "node:zlib";
import { getSql } from "./db";
import type { ClientConfig } from "./clients";
import type { DashboardPayload } from "./types";

// How old a payload may be before a visit triggers a background refresh.
export const FRESH_WINDOW_MS = 15 * 60 * 1000;

// How long a claimed sync may run before another request may take the lock over.
// Self-healing: a function that dies mid-sync must not freeze the project forever.
const LOCK_TIMEOUT_MINUTES = 10;

export function isStale(syncedAt: string | Date, now: Date = new Date()): boolean {
  const then = syncedAt instanceof Date ? syncedAt : new Date(syncedAt);
  const age = now.getTime() - then.getTime();
  // A negative age means clock skew put synced_at in the future. Treat it as
  // fresh: re-syncing on every visit would be worse than trusting the row.
  if (age < 0) return false;
  return age >= FRESH_WINDOW_MS;
}

// Every function here takes the ClientConfig, never a bare string. Reading the
// wrong row would render project A's dashboard with project B's data — the same
// cross-project leak lib/ghl-context.ts exists to prevent — so the caller has to
// have resolved a real project through requireClient() to call these at all.
export async function readSync(
  client: ClientConfig,
): Promise<{ payload: DashboardPayload; syncedAt: string } | null> {
  const rows = await getSql()`
    SELECT payload, synced_at FROM project_sync WHERE project_id = ${client.id}
  `;
  if (rows.length === 0) return null;
  const gz = Buffer.from(rows[0].payload);
  // claimSync seeds an empty payload when it takes the lock on a project that was
  // never synced. If that sync then fails, the row survives with zero bytes —
  // gunzip would throw on it. An empty payload means "no cache", not "corrupt".
  if (gz.length === 0) return null;
  const raw = gunzipSync(gz);
  return {
    payload: JSON.parse(raw.toString("utf8")) as DashboardPayload,
    syncedAt: new Date(rows[0].synced_at).toISOString(),
  };
}

export async function writeSync(client: ClientConfig, payload: DashboardPayload): Promise<void> {
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  // synced_at comes from the payload, not from now(): it records when the data was
  // fetched from GHL, which is what the header means by "actualizado hace X".
  await getSql()`
    INSERT INTO project_sync (project_id, payload, synced_at, sync_started_at, last_error)
    VALUES (${client.id}, ${gz}, ${payload.meta.fetchedAt}, NULL, NULL)
    ON CONFLICT (project_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           synced_at = EXCLUDED.synced_at,
           sync_started_at = NULL,
           last_error = NULL
  `;
}

// Atomically takes the sync lock. Returns false when someone else holds it, which
// is how two people opening the same stale project at once produce ONE sync.
//
// The whole decision is inside the UPDATE's WHERE clause on purpose: doing it as
// read-then-write in TypeScript would leave a window where both callers see it
// free and both proceed.
export async function claimSync(client: ClientConfig): Promise<boolean> {
  const rows = await getSql()`
    INSERT INTO project_sync (project_id, payload, synced_at, sync_started_at)
    VALUES (${client.id}, ''::bytea, to_timestamp(0), now())
    ON CONFLICT (project_id) DO UPDATE
       SET sync_started_at = now()
     WHERE project_sync.sync_started_at IS NULL
        OR project_sync.sync_started_at < now() - make_interval(mins => ${LOCK_TIMEOUT_MINUTES})
    RETURNING project_id
  `;
  return rows.length > 0;
}

// Releases the lock WITHOUT touching the payload: a failed refresh must leave the
// last good cache in place. Serving data from an hour ago beats serving nothing.
export async function releaseSync(client: ClientConfig, error?: string): Promise<void> {
  await getSql()`
    UPDATE project_sync
       SET sync_started_at = NULL,
           last_error = ${error ?? null}
     WHERE project_id = ${client.id}
  `;
}
