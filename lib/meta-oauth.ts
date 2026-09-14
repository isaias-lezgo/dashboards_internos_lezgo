// lib/meta-oauth.ts
// Lo puro del flujo OAuth con Meta: el `state` firmado que viaja al diálogo y
// regresa en el callback, el cifrado del token en reposo, y la URL del diálogo.
//
// Sin imports de Next ni de la base: se prueba con pnpm verify:meta-oauth y lo
// usan las rutas de app/api/meta/*. Web Crypto (crypto.subtle) igual que
// lib/auth.ts, así que corre en Node y en Edge sin cambios.
//
// El `state` lleva el id del ALCANCE dentro del payload firmado. En este
// despliegue la conexión es una por instalación, así que lo que el callback
// exige es que el state venga de una sesión del alcance `all` — la misma que
// puede apretar "Conectar". Un state ajeno bien firmado no debe guardar nada.
import { safeEqual } from "./auth";

export type MetaProduct = "ads" | "whatsapp";

export interface MetaState {
  scopeId: string;
  product: MetaProduct;
  /** Ruta relativa a la que regresar tras el callback (siempre empieza con "/"). */
  returnTo: string;
  nonce: string;
  iat: number;
}

/** Cuánto puede tardar el usuario en el diálogo de Meta antes de que el state caduque. */
export const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Cookie httpOnly que /connect deja con el nonce del state y /callback exige.
 * Ata el callback al navegador que empezó el flujo: sin ella, un state válido
 * en manos ajenas bastaría para conectar el panel a una cuenta de Meta que no
 * es del cliente.
 */
export const OAUTH_COOKIE = "meta_oauth";

export const GRAPH_VERSION = "v23.0";

function getSecret(): string {
  const secret = process.env.DASHBOARD_AUTH_SECRET;
  if (!secret) throw new Error("DASHBOARD_AUTH_SECRET is not set");
  return secret;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return new Uint8Array(Buffer.from(s, "base64url"));
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toBase64Url(new Uint8Array(sig));
}

// Formato: "<base64url(json)>.<hmac(base64url(json))>".
export async function signState(
  s: Omit<MetaState, "nonce" | "iat">,
  now: number = Date.now()
): Promise<string> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const full: MetaState = { ...s, nonce, iat: now };
  const payload = toBase64Url(enc.encode(JSON.stringify(full)));
  return `${payload}.${await hmac(payload)}`;
}

// null ante cualquier falla: formato, firma, edad, o un iat del futuro.
export async function verifyState(
  value: string | null | undefined,
  now: number = Date.now()
): Promise<MetaState | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const bytes = fromBase64Url(payload);
  if (!bytes || !sig) return null;
  if (!safeEqual(sig, await hmac(payload))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const s = parsed as Partial<MetaState>;
  if (typeof s.scopeId !== "string" || !s.scopeId) return null;
  if (s.product !== "ads" && s.product !== "whatsapp") return null;
  if (typeof s.returnTo !== "string" || !s.returnTo.startsWith("/")) return null;
  if (typeof s.nonce !== "string" || typeof s.iat !== "number") return null;
  if (s.iat > now) return null;
  if (now - s.iat > STATE_MAX_AGE_MS) return null;
  return s as MetaState;
}

// Llave AES-256 derivada del secreto de sesión con HKDF. Una llave distinta por
// uso ("meta-token") para que el secreto compartido no se reutilice crudo.
async function aesKey(): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(getSecret()), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("lezgo-paneles"), info: enc.encode("meta-token") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const IV_BYTES = 12;

// Salida: iv (12 bytes) ‖ ciphertext+tag. Se guarda tal cual en un bytea.
export async function encryptToken(plain: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(plain));
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return out;
}

// null si el blob está corto, alterado, o cifrado con otra llave. GCM autentica,
// así que no hay forma de obtener basura "plausible".
export async function decryptToken(blob: Uint8Array): Promise<string | null> {
  if (blob.length <= IV_BYTES + 16) return null;
  try {
    const iv = blob.slice(0, IV_BYTES);
    const ct = blob.slice(IV_BYTES);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(), ct);
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// Con Facebook Login for Business NO se manda `scope`: los permisos los define
// la configuración (config_id) creada en el panel de la app.
export function buildDialogUrl(p: {
  appId: string;
  configId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", p.appId);
  url.searchParams.set("config_id", p.configId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("state", p.state);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

// El redirect_uri tiene que coincidir EXACTAMENTE con uno registrado en la app.
// META_PUBLIC_ORIGIN lo fija en producción (detrás de un alias de Vercel el Host
// puede ser cualquiera de los cuatro); sin él, el origen de la petición sirve
// para localhost. Nunca se deriva de Origin/Referer, que el cliente controla.
export function redirectUriFor(requestUrl: string, publicOrigin?: string): string {
  const origin = publicOrigin?.trim() || new URL(requestUrl).origin;
  return `${origin}/api/meta/callback`;
}
