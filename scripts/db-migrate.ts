// Crea las tablas del caché y de Meta. Idempotent — safe to run on every deploy or by hand.
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

  // La conexión con Meta: UNA por despliegue (PK = product), no por proyecto.
  // A diferencia de project_sync NO es desechable: si se borra hay que volver
  // a apretar "Conectar con Meta".
  await sql`
    CREATE TABLE IF NOT EXISTS meta_connection (
      product             text        PRIMARY KEY,
      token_encrypted     bytea       NOT NULL,
      token_kind          text        NOT NULL,
      token_expires_at    timestamptz,
      business_id         text,
      connected_by        text,
      available_accounts  jsonb       NOT NULL,
      connected_at        timestamptz NOT NULL,
      updated_at          timestamptz NOT NULL
    )
  `;

  // Qué cuentas publicitarias mira cada proyecto. Sin FK a meta_connection a
  // propósito: reconectar con la misma empresa no debe borrar asignaciones.
  await sql`
    CREATE TABLE IF NOT EXISTS meta_project_accounts (
      project_id   text        NOT NULL,
      product      text        NOT NULL,
      account_ids  jsonb       NOT NULL,
      updated_at   timestamptz NOT NULL,
      PRIMARY KEY (project_id, product)
    )
  `;

  for (const table of ["project_sync", "meta_connection", "meta_project_accounts"]) {
    const rows = await sql`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_name = ${table}
       ORDER BY ordinal_position
    `;
    console.log(`✅ ${table} lista:`);
    for (const r of rows) console.log(`   ${r.column_name} ${r.data_type}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
