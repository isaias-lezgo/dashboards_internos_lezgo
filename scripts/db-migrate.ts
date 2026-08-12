// Creates the cache table. Idempotent — safe to run on every deploy or by hand.
// Run: pnpm db:migrate
//
// No migration framework: one table does not justify one, and the repo has no
// test framework either. If this ever grows past a couple of tables, revisit.
//
// Wrapped in main() rather than using top-level await: this package is CJS
// ("type" is not "module"), so tsx compiles to CJS where TLA is unavailable.
import { neon } from "@neondatabase/serverless";

async function main() {
  // DDL goes through the UNPOOLED connection: pgbouncer in transaction mode
  // interferes with schema changes.
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set");
  const sql = neon(url);

  await sql`
    CREATE TABLE IF NOT EXISTS project_sync (
      project_id      text PRIMARY KEY,
      payload         bytea       NOT NULL,
      synced_at       timestamptz NOT NULL,
      sync_started_at timestamptz,
      last_error      text
    )
  `;

  const rows = await sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'project_sync'
     ORDER BY ordinal_position
  `;
  console.log("✅ project_sync lista:");
  for (const r of rows) console.log(`   ${r.column_name} ${r.data_type}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
