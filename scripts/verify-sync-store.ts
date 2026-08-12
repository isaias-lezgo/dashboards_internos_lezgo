// Verification for lib/sync-store.ts. Run: pnpm verify:sync-store
//
// The store is keyed BY PROJECT, so a bug here is a cross-project data leak — the
// same class of failure the credential context exists to prevent. That is why this
// script also exercises the real database when DATABASE_URL is present: the SQL is
// where the key actually gets used.
//
// Wrapped in main() rather than using top-level await: this package is CJS
// ("type" is not "module"), so tsx compiles to CJS where TLA is unavailable.
import assert from "node:assert/strict";
import {
  FRESH_WINDOW_MS,
  isStale,
  readSync,
  writeSync,
  claimSync,
  releaseSync,
} from "../lib/sync-store";
import type { ClientConfig } from "../lib/clients";
import type { DashboardPayload } from "../lib/types";

// Synthetic ids that can never collide with a real project: the roster's ID_RE
// forbids underscores, so nothing in DASHBOARD_CLIENTS can ever be named this.
const A: ClientConfig = { id: "__verify_a", name: "A", locationId: "loc-a", ghlToken: "pit-a" };
const B: ClientConfig = { id: "__verify_b", name: "B", locationId: "loc-b", ghlToken: "pit-b" };

function payload(marker: string, fetchedAt: string): DashboardPayload {
  return {
    locationName: `Ubicación ${marker} ñ 🎯`,
    contacts: [],
    opportunities: [],
    calls: [],
    tasks: [],
    appointments: [],
    pipelines: [],
    members: [marker],
    tags: [],
    campaigns: [],
    sources: [],
    pautas: [],
    customFieldDefs: [],
    locationId: `loc-${marker}`,
    meta: { totalContacts: 0, totalOpportunities: 0, fetchedAt },
  };
}

async function main() {
  const now = new Date("2026-08-12T12:00:00.000Z");

  // --- freshness: exact boundaries, not "about 15 minutes"
  assert.equal(FRESH_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(isStale(new Date(now.getTime() - 1000).toISOString(), now), false, "1s old is fresh");
  assert.equal(
    isStale(new Date(now.getTime() - FRESH_WINDOW_MS + 1).toISOString(), now),
    false,
    "just under the window is fresh",
  );
  assert.equal(
    isStale(new Date(now.getTime() - FRESH_WINDOW_MS).toISOString(), now),
    true,
    "exactly the window is stale",
  );
  assert.equal(
    isStale(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), now),
    true,
    "an hour old is stale",
  );
  // A clock skew that puts synced_at in the future must not read as stale.
  assert.equal(isStale(new Date(now.getTime() + 5000).toISOString(), now), false, "future is not stale");

  if (!process.env.DATABASE_URL) {
    console.log("⚠️  DATABASE_URL ausente — se omitió el roundtrip real");
    console.log("✅ lib/sync-store.ts — aserciones puras pasaron");
    return;
  }

  // --- roundtrip: what goes in comes out byte-identical, accents and emoji included
  const stamp = new Date().toISOString();
  await writeSync(A, payload("a", stamp));
  const readA = await readSync(A);
  assert.ok(readA, "A must read back");
  assert.deepEqual(readA.payload, payload("a", stamp), "payload must survive gzip roundtrip");
  assert.equal(readA.payload.locationName, "Ubicación a ñ 🎯");

  // --- THE ISOLATION GUARANTEE: one project's write is invisible to another
  await writeSync(B, payload("b", stamp));
  const againA = await readSync(A);
  assert.ok(againA);
  assert.equal(againA.payload.members[0], "a", "A must still read A's payload, never B's");
  const readB = await readSync(B);
  assert.ok(readB);
  assert.equal(readB.payload.members[0], "b");

  // --- a project that was never synced reads as null, not as an error
  const never = await readSync({ ...A, id: "__verify_nunca" });
  assert.equal(never, null);

  // --- the lock: the second claimer gets nothing while the first holds it
  assert.equal(await claimSync(A), true, "first claim wins");
  assert.equal(await claimSync(A), false, "second claim is refused while held");
  await releaseSync(A);
  assert.equal(await claimSync(A), true, "claimable again after release");
  await releaseSync(A, "boom");

  // --- releasing with an error records it without destroying the cached payload
  const afterError = await readSync(A);
  assert.ok(afterError, "a failed sync must NOT drop the payload we already had");
  assert.equal(afterError.payload.members[0], "a");

  // --- a claim on a project that was never synced seeds an EMPTY payload. Reading
  // that must return null ("no cache"), not blow up in gunzip.
  const C: ClientConfig = { ...A, id: "__verify_c" };
  assert.equal(await claimSync(C), true, "claiming an unsynced project must work");
  await releaseSync(C, "murió a medio sync");
  assert.equal(await readSync(C), null, "an empty payload reads as no cache, not as corruption");

  // --- writing overwrites: the cache holds only the present
  const newer = new Date(Date.now() + 1000).toISOString();
  await writeSync(A, payload("a2", newer));
  const overwritten = await readSync(A);
  assert.ok(overwritten);
  assert.equal(overwritten.payload.members[0], "a2");
  assert.equal(overwritten.syncedAt, newer);

  // --- clean up so the table only ever holds real projects
  const { getSql } = await import("../lib/db");
  await getSql()`DELETE FROM project_sync WHERE project_id LIKE '\\_\\_verify%'`;
  const leftovers =
    await getSql()`SELECT count(*)::int AS n FROM project_sync WHERE project_id LIKE '\\_\\_verify%'`;
  assert.equal(leftovers[0].n, 0, "verification rows must be cleaned up");

  console.log("✅ lib/sync-store.ts — todas las aserciones pasaron (incluido el roundtrip real)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
