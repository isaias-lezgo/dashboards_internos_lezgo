// lib/db.ts
// The seam between "where the cache lives" and everything downstream — the same
// role lib/clients.ts plays for the roster. Nothing outside this file knows the
// database is Neon, so swapping providers (or dropping to object storage) touches
// only this module.
//
// Server-only: the browser never talks to the database. Every read and write is
// made by code that already resolved the project through requireClient().
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let cached: NeonQueryFunction<false, false> | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

// Lazy rather than initialised at module load: importing this file in an
// environment without DATABASE_URL (a verify script, a build step) must not throw.
export function getSql(): NeonQueryFunction<false, false> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  cached = neon(url);
  return cached;
}
