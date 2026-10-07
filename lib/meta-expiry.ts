// lib/meta-expiry.ts
// Cuándo caduca el token de Meta de un proyecto. Puro y sin imports: lo usa la
// píldora en el navegador, que no debe arrastrar lib/meta-oauth (y con él
// lib/auth) al bundle. Un token de usuario del sistema no caduca (null); uno de
// usuario dura ~60 días y la píldora avisa a partir de EXPIRY_WARNING_DAYS.

export const EXPIRY_WARNING_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Días enteros (hacia arriba) hasta la caducidad; ≤ 0 si ya caducó; null sin fecha. */
export function tokenExpiryDays(expiresAt: string | null, now: number = Date.now()): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now) / DAY_MS);
}
