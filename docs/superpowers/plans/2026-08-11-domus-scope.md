# Alcance Domus y la puerta `/domus` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar al equipo Domus un link propio (`/domus`) con su propia contraseña, cuya sesión quede limitada de verdad a tres proyectos: `condesa`, `yconia` y `plaza-bosques`.

**Architecture:** Se introduce un concepto de **alcance** (scope): un conjunto de proyectos que una contraseña desbloquea. El payload firmado de la cookie `dash_access` deja de ser el sentinel fijo `"ok"` y pasa a ser el id del alcance. El alcance filtra el roster en los shells de servidor (cosmético) y se aplica como barrera real en `requireClient()`, el único punto por el que pasan todas las rutas que tocan GHL.

**Tech Stack:** Next.js 16 App Router, TypeScript, cookies firmadas con HMAC vía Web Crypto (`lib/auth.ts`), scripts de verificación con `node:assert/strict` ejecutados por `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-11-domus-scope-design.md`

## Global Constraints

- **No hay framework de tests y no se adopta uno.** La verificación son scripts `scripts/verify-*.ts` con `node:assert/strict`, ejecutados con `tsx`, más manejar la app real.
- **El paquete es CommonJS** (`package.json` no tiene `"type": "module"`), así que `tsx` compila a CJS y **`await` de nivel superior falla**. Si un script necesita `await`, envolverlo en `main()` y llamar `main().catch(...)`. Si no necesita `await`, se escribe a nivel superior (como `scripts/verify-clients.ts`).
- **Gestor de paquetes: pnpm.** Nunca `npm install`.
- **`npx tsc --noEmit` es obligatorio** antes de cada commit: `next build` ignora los errores de TypeScript (`next.config.mjs`), así que un build verde no prueba nada.
- **`lib/scopes.ts` debe permanecer puro y Edge-safe**: lo importa `middleware.ts`. **Nunca** importar `lib/clients.ts` desde ahí — arrastraría los tokens de GHL al bundle de Edge.
- **`AsyncLocalStorage` sigue siendo intocable**: nada en este plan reemplaza `withClient` por una variable de módulo.
- Los proyectos del alcance domus son exactamente: `condesa`, `yconia`, `plaza-bosques`. Fuera quedan `grand-center`, `balvanera` y `lezgo-suite`.
- El env var de la contraseña Domus se llama **`DOMUS_ACCESS_PASSWORD`** y ya está en `.env.local`. En Vercel lo carga el usuario.
- Comentarios y mensajes de commit en español, siguiendo la convención del repo (`feat(...)`, `fix(...)`, `docs(...)`).

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `lib/scopes.ts` **(nuevo)** | Declara los alcances y responde dos preguntas puras: `getScope(id)` y `scopeAllows(scope, projectId)`. Sin I/O, sin cookies, sin roster. |
| `scripts/verify-scopes.ts` **(nuevo)** | Afirma la configuración de alcances: ids cookie-safe, proyectos existentes, y que domus rechaza los tres proyectos ajenos. |
| `lib/auth.ts` | Firma/verifica tokens. Pierde `ACCESS_PAYLOAD`; el payload de `dash_access` pasa a ser un id de alcance. |
| `middleware.ts` | La puerta. Valida que el payload nombre un alcance conocido, y adjunta `?next=` al redirigir. |
| `app/api/auth/login/route.ts` | Compara la contraseña contra todos los alcances configurados y firma el id del ganador. Borra `dash_project`. |
| `lib/session.ts` | `currentScope()` (nuevo) y `requireClient()` **con la barrera**. |
| `app/api/project/select/route.ts` | Valida el proyecto contra el alcance antes de firmar. |
| `app/page.tsx` | Filtra el roster por alcance; título del picker desde el alcance. |
| `app/domus/page.tsx` **(nuevo)** | La puerta Domus: picker filtrado a los tres proyectos. |
| `components/dashboard/project-picker.tsx` | Gana un prop `title`. |
| `app/login/page.tsx` | Vuelve a `?next=` si es una ruta interna. |
| `package.json`, `CLAUDE.md` | Script `verify:scopes` y documentación. |

---

### Task 1: `lib/scopes.ts` — el modelo de alcances

**Files:**
- Create: `lib/scopes.ts`
- Create: `scripts/verify-scopes.ts`
- Modify: `package.json` (bloque `scripts`)

**Interfaces:**
- Consumes: `parseClients` de `lib/clients.ts` (solo en el script de verificación, nunca desde `lib/scopes.ts`).
- Produces:
  - `interface AccessScope { id: string; label: string; passwordEnv: string; projectIds: readonly string[] | null }`
  - `const SCOPES: readonly AccessScope[]`
  - `const DOMUS_SCOPE_ID = "domus"`
  - `function getScope(id: string | null | undefined): AccessScope | null`
  - `function scopeAllows(scope: AccessScope, projectId: string): boolean`

- [ ] **Step 1: Escribir el script de verificación (falla primero)**

Crear `scripts/verify-scopes.ts`. Sin `main()`: no hay `await` en ningún lado, igual que `scripts/verify-clients.ts`.

```ts
// Verification for lib/scopes.ts. Run: pnpm verify:scopes
//
// The point of this script: a scope is a list of project ids typed by hand, and a
// typo there fails SILENTLY — the project simply stops appearing for that team.
// So the roster below mirrors production exactly, and every id a scope names is
// checked against it.
import assert from "node:assert/strict";
import { SCOPES, DOMUS_SCOPE_ID, getScope, scopeAllows } from "../lib/scopes";
import { parseClients } from "../lib/clients";

const ROSTER = JSON.stringify([
  { id: "lezgo-suite", name: "Lezgo Suite", locationId: "loc-1", ghlToken: "pit-1" },
  { id: "condesa", name: "Condesa Cimatario", locationId: "loc-2", ghlToken: "pit-2" },
  { id: "plaza-bosques", name: "Plaza Bosques / Meseta", locationId: "loc-3", ghlToken: "pit-3" },
  { id: "grand-center", name: "Grand Center", locationId: "loc-4", ghlToken: "pit-4" },
  { id: "balvanera", name: "Balvanera", locationId: "loc-5", ghlToken: "pit-5" },
  { id: "yconia", name: "Yconia", locationId: "loc-6", ghlToken: "pit-6" },
]);

// Same constraint as a project id: the scope id rides inside the dot-delimited
// dash_access token, so a dot would split the payload.
const ID_RE = /^[a-z0-9-]+$/;

const rosterIds = new Set(parseClients(ROSTER).map((c) => c.id));

// --- shape: ids cookie-safe and unique, labels and env names present
const seen = new Set<string>();
for (const scope of SCOPES) {
  assert.ok(ID_RE.test(scope.id), `scope id "${scope.id}" must be lowercase letters, digits and hyphens`);
  assert.ok(!scope.id.includes("."), `scope id "${scope.id}" must not contain a dot`);
  assert.ok(!seen.has(scope.id), `duplicate scope id "${scope.id}"`);
  seen.add(scope.id);
  assert.ok(scope.label.trim() !== "", `scope "${scope.id}" needs a label`);
  assert.ok(scope.passwordEnv.trim() !== "", `scope "${scope.id}" needs a passwordEnv`);
}

// --- every project a scope names must exist in the roster
for (const scope of SCOPES) {
  for (const id of scope.projectIds ?? []) {
    assert.ok(rosterIds.has(id), `scope "${scope.id}" names unknown project "${id}"`);
  }
}

// --- the domus scope: exactly three projects, and the other three are refused
const domus = getScope(DOMUS_SCOPE_ID);
if (!domus) throw new Error("the domus scope must exist");
assert.deepEqual(
  [...(domus.projectIds ?? [])].sort(),
  ["condesa", "plaza-bosques", "yconia"],
  "domus must be exactly these three projects",
);
for (const id of ["condesa", "yconia", "plaza-bosques"]) {
  assert.equal(scopeAllows(domus, id), true, `domus must allow ${id}`);
}
for (const id of ["grand-center", "balvanera", "lezgo-suite"]) {
  assert.equal(scopeAllows(domus, id), false, `domus must NOT allow ${id}`);
}

// --- the full scope allows anything, including a project added to the roster later
const all = getScope("all");
if (!all) throw new Error("the all scope must exist");
assert.equal(all.projectIds, null, "the full scope must be null, not a hand-kept copy of the roster");
for (const id of [...rosterIds, "un-proyecto-futuro"]) {
  assert.equal(scopeAllows(all, id), true, `all must allow ${id}`);
}

// --- unknown / missing ids resolve to nothing: getScope fails closed, which is what
// lets middleware treat "no scope" as "not authenticated".
assert.equal(getScope("no-existe"), null);
assert.equal(getScope(""), null);
assert.equal(getScope(null), null);
assert.equal(getScope(undefined), null);

console.log("✅ lib/scopes.ts — all assertions passed");
```

- [ ] **Step 2: Registrar el script en `package.json`**

En el bloque `scripts`, justo después de `"verify:clients"`:

```json
    "verify:scopes": "tsx scripts/verify-scopes.ts",
```

- [ ] **Step 3: Correr la verificación y confirmar que falla**

Run: `pnpm verify:scopes`
Expected: FAIL — `Cannot find module '../lib/scopes'` (el módulo todavía no existe).

- [ ] **Step 4: Implementar `lib/scopes.ts`**

```ts
// lib/scopes.ts
// Access scopes: which projects one password unlocks.
//
// Pure and Edge-safe ON PURPOSE — middleware.ts imports this file, so it must NEVER
// import lib/clients.ts: that would pull every project's GHL token into the Edge
// bundle. Scopes name projects by id only, and ids are not secrets.
//
// A scope id rides inside the dot-delimited dash_access token, so it may not contain
// a dot — the same constraint project ids have (see lib/auth.ts).
//
// The list of projects lives HERE rather than in an env var so that changing who sees
// what is a commit: versioned, reviewable in the diff. The passwords — which ARE
// secrets — stay in env vars, named by `passwordEnv`.

export interface AccessScope {
  id: string;
  /** Title of the project picker, and of the browser tab. */
  label: string;
  /** Name of the env var holding THIS scope's password. */
  passwordEnv: string;
  /** null = every project in the roster, including ones added later. */
  projectIds: readonly string[] | null;
}

// Note this list is static even when a scope's password env var is absent. The login
// route is what refuses to mint a session for an unconfigured scope; keeping SCOPES
// free of process.env keeps this module pure and its behaviour identical everywhere.
export const SCOPES: readonly AccessScope[] = [
  {
    id: "all",
    label: "Proyectos Lezgo",
    passwordEnv: "DASHBOARD_ACCESS_PASSWORD",
    projectIds: null,
  },
  {
    id: "domus",
    label: "Proyectos Domus",
    passwordEnv: "DOMUS_ACCESS_PASSWORD",
    projectIds: ["condesa", "yconia", "plaza-bosques"],
  },
];

export const DOMUS_SCOPE_ID = "domus";

// Fails closed: an unknown, empty or missing id resolves to null, which every caller
// reads as "no access".
export function getScope(id: string | null | undefined): AccessScope | null {
  if (!id) return null;
  return SCOPES.find((s) => s.id === id) ?? null;
}

export function scopeAllows(scope: AccessScope, projectId: string): boolean {
  if (scope.projectIds === null) return true;
  return scope.projectIds.includes(projectId);
}
```

- [ ] **Step 5: Correr la verificación y confirmar que pasa**

Run: `pnpm verify:scopes`
Expected: PASS — `✅ lib/scopes.ts — all assertions passed`

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add lib/scopes.ts scripts/verify-scopes.ts package.json
git commit -m "feat(alcances): declara los alcances de acceso y su verificacion"
```

---

### Task 2: El payload de `dash_access` pasa a ser el id del alcance

Esta tarea cambia el significado de la cookie de la puerta, así que `lib/auth.ts`, `middleware.ts` y el login se mueven juntos: separarlos dejaría el árbol sin compilar.

**Files:**
- Modify: `lib/auth.ts` (quitar `ACCESS_PAYLOAD`, líneas 6-15 y 78-81)
- Modify: `middleware.ts:15-21`
- Modify: `app/api/auth/login/route.ts`
- Modify: `scripts/verify-auth.ts`

**Interfaces:**
- Consumes: `getScope` y `SCOPES` de `lib/scopes.ts` (Task 1); `signToken`, `verifyToken`, `safeEqual`, `ACCESS_COOKIE`, `PROJECT_COOKIE`, `COOKIE_OPTIONS`, `SESSION_MAX_AGE_SECONDS` de `lib/auth.ts`.
- Produces: una cookie `dash_access` cuyo payload verificado es un id de alcance (`"all"` | `"domus"`). `ACCESS_PAYLOAD` deja de existir — nadie más puede importarlo.

- [ ] **Step 1: Actualizar `scripts/verify-auth.ts` (el test que falla primero)**

Cambiar el import de la línea 9 quitando `ACCESS_PAYLOAD`:

```ts
import { signToken, verifyToken, ACCESS_COOKIE, PROJECT_COOKIE } from "../lib/auth";
```

Reemplazar el bloque de las líneas 14-20 por:

```ts
  // --- round trip: an arbitrary payload survives sign → verify.
  // The payload is a project id on dash_project and an ACCESS SCOPE id on dash_access.
  const token = await signToken("yconia", Date.now() + HOUR);
  assert.equal(await verifyToken(token), "yconia");

  const access = await signToken("all", Date.now() + HOUR);
  assert.equal(await verifyToken(access), "all");
```

Reemplazar la línea 28 (comentario) y la 31 por:

```ts
  // another project; on dash_access it stops a forged scope from being minted.
```
```ts
  assert.equal(await verifyToken(`all.${expiry}.${sig}`), null, "project token must not pass as an access token");
```

Reemplazar la línea 43 por:

```ts
  const expiredAccess = await signToken("all", Date.now() - 1000);
```

Reemplazar la línea 62 (`assert.equal(ACCESS_PAYLOAD, "ok")`) por este bloque nuevo, que es la aserción que realmente importa ahora:

```ts

  // --- THE SCOPE GUARANTEE: a narrow access cookie cannot be widened by hand.
  // This is what stops someone holding a Domus session from editing their cookie to
  // "all" and seeing every project.
  const domusAccess = await signToken("domus", Date.now() + HOUR);
  assert.equal(await verifyToken(domusAccess), "domus");
  const [, dExpiry, dSig] = domusAccess.split(".");
  assert.equal(await verifyToken(`all.${dExpiry}.${dSig}`), null, "widening domus → all must be rejected");
```

- [ ] **Step 2: Correr y anotar el resultado**

Run: `pnpm verify:auth`
Expected: **PASS**, y eso es correcto — `lib/auth.ts` es agnóstico al significado del payload: firma y verifica cualquier cadena. Las aserciones nuevas documentan qué significa ahora ese payload y protegen el ensanchamiento `domus → all`; no hay un rojo previo que producir aquí porque no hay lógica nueva en `auth.ts`.

El rojo real de esta tarea lo da el compilador en el Step 3: al borrar `ACCESS_PAYLOAD`, `middleware.ts` y el login dejan de compilar hasta que se actualizan. Eso es lo que garantiza que no quede ningún consumidor del sentinel viejo.

- [ ] **Step 3: Quitar `ACCESS_PAYLOAD` de `lib/auth.ts`**

Reemplazar el bloque de comentario de las líneas 6-15 por:

```ts
// Two cookies, two questions. dash_access answers "which projects may this person
// open at all?" — its payload is an ACCESS SCOPE id (see lib/scopes.ts) — and it is
// the only one Edge middleware checks. dash_project answers "which project are they
// viewing?" and is resolved by requireClient() (lib/session.ts), which needs the
// roster and therefore must stay out of the Edge bundle.
//
// Neither payload carries identity or PII: one names a set of projects, the other
// names one project.
export const ACCESS_COOKIE = "dash_access";
export const PROJECT_COOKIE = "dash_project";
```

(la constante `export const ACCESS_PAYLOAD = "ok";` y su comentario desaparecen).

Actualizar el comentario de la línea 80 (dentro del bloque de `verifyToken`):

```ts
// Returns the signed payload on success, null on any failure (missing, malformed,
// expired, or bad signature). Callers decide what the payload means: a scope id for
// dash_access, a project id for dash_project.
```

- [ ] **Step 4: Actualizar `middleware.ts`**

Cambiar el import de la línea 3 y el bloque 15-20:

```ts
import { ACCESS_COOKIE, verifyToken } from "@/lib/auth";
import { getScope } from "@/lib/scopes";
```

```ts
  // Verifies the gate cookie and that its payload names a known access scope. It
  // deliberately does NOT resolve the project or the roster, which would drag GHL
  // credentials into the Edge bundle — lib/scopes.ts names projects by id only, and
  // WHICH projects a scope allows is enforced in requireClient(), not here.
  const token = req.cookies.get(ACCESS_COOKIE)?.value;
  if (getScope(await verifyToken(token))) return NextResponse.next();
  return denied(req);
```

- [ ] **Step 5: Reescribir la comparación de contraseñas en `app/api/auth/login/route.ts`**

Cambiar el bloque de imports (líneas 1-10) por:

```ts
import { NextResponse } from "next/server";
import {
  ACCESS_COOKIE,
  COOKIE_OPTIONS,
  PROJECT_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  safeEqual,
  signToken,
} from "@/lib/auth";
import { SCOPES, type AccessScope } from "@/lib/scopes";
```

Reemplazar el cuerpo del `POST` (líneas 48-84) por:

```ts
export async function POST(req: Request) {
  if (!process.env.DASHBOARD_AUTH_SECRET) {
    console.error("[auth] DASHBOARD_AUTH_SECRET not set");
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  // A scope whose password env var is absent simply does not exist. That is how a
  // deployment without DOMUS_ACCESS_PASSWORD keeps behaving exactly as it did before
  // scopes existed, with no extra flag to remember.
  const configured = SCOPES.filter((s) => Boolean(process.env[s.passwordEnv]));
  if (configured.length === 0) {
    console.error("[auth] no access scope has its password configured");
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const ip = clientIp(req);
  if (isLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let submitted = "";
  try {
    const body = (await req.json()) as { password?: string };
    submitted = body.password ?? "";
  } catch {
    submitted = "";
  }

  // One password per scope, and the password IS the identity: it decides which
  // projects the session may open.
  //
  // NO early break, on purpose. Stopping at the first hit would make the response
  // time reveal WHICH password was guessed — the same class of leak safeEqual exists
  // to prevent, so every configured scope is compared on every attempt.
  let matched: AccessScope | null = null;
  for (const scope of configured) {
    if (safeEqual(submitted, process.env[scope.passwordEnv] as string)) matched = scope;
  }

  if (submitted === "" || !matched) {
    recordFailure(ip);
    return NextResponse.json({ error: "invalid_password" }, { status: 401 });
  }

  // Success: clear failures and set the signed gate cookie carrying the scope id.
  attempts.delete(ip);
  const expiryMs = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const token = await signToken(matched.id, expiryMs);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS });
  // Drop whatever project was selected before. Logging in with the Domus password on
  // a machine that had Grand Center open must land on the picker — requireClient()
  // would refuse that cookie anyway, but as a 401 it reads like a broken session
  // instead of like the fresh start it is.
  res.cookies.set(PROJECT_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return res;
}
```

Nota: la constante `expected` de la línea 49 desaparece; `DASHBOARD_ACCESS_PASSWORD` ahora se lee a través de `scope.passwordEnv`.

- [ ] **Step 6: Verificar**

Run: `pnpm verify:auth`
Expected: PASS — `✅ lib/auth.ts — all assertions passed`

Run: `npx tsc --noEmit`
Expected: sin errores. Si aparece `Property 'ACCESS_PAYLOAD' does not exist`, queda un import sin actualizar.

Run: `grep -rn "ACCESS_PAYLOAD" --include="*.ts" --include="*.tsx" .`
Expected: sin resultados fuera de `node_modules`.

- [ ] **Step 7: Commit**

```bash
git add lib/auth.ts middleware.ts app/api/auth/login/route.ts scripts/verify-auth.ts
git commit -m "feat(alcances): dash_access lleva el id del alcance y el login lo resuelve"
```

---

### Task 3: La barrera — `currentScope()` y `requireClient()`

Esta es la tarea que convierte el filtro en una restricción real. Todo lo demás es cosmético sin ella.

**Files:**
- Modify: `lib/session.ts`
- Modify: `app/api/project/select/route.ts:26-36`

**Interfaces:**
- Consumes: `getScope`, `scopeAllows`, `AccessScope` de `lib/scopes.ts`; `ACCESS_COOKIE`, `PROJECT_COOKIE`, `verifyToken` de `lib/auth.ts`; `getClientById` de `lib/clients.ts`.
- Produces: `async function currentScope(): Promise<AccessScope | null>` exportada desde `lib/session.ts`, consumida por Task 4 (`app/page.tsx`), Task 5 (`app/domus/page.tsx`) y por el select route. `requireClient()` mantiene su firma `Promise<ClientConfig | null>`, así que ninguna de las ~10 rutas que la llaman cambia.

- [ ] **Step 1: Reescribir `lib/session.ts`**

Archivo completo:

```ts
// lib/session.ts
// Node-only. Kept OUT of lib/auth.ts on purpose: auth.ts is imported by Edge
// middleware and must stay pure/runtime-agnostic, and importing the roster there
// would pull it into the Edge bundle.
import { cookies } from "next/headers";
import { ACCESS_COOKIE, PROJECT_COOKIE, verifyToken } from "./auth";
import { getClientById, type ClientConfig } from "./clients";
import { getScope, scopeAllows, type AccessScope } from "./scopes";

// The access scope of the current session: the set of projects the password they
// logged in with unlocks. Re-verifies the cookie rather than trusting anything
// middleware might have injected, for the same reason requireClient does.
export async function currentScope(): Promise<AccessScope | null> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  return getScope(await verifyToken(token));
}

// Re-verifies the signed cookies themselves rather than trusting a header injected
// by middleware — a header would be a spoofing surface, and an HMAC verify costs
// microseconds. Returns null when a cookie is invalid, when the id no longer
// resolves (so removing a project from the roster instantly invalidates the live
// sessions viewing it), or when the project lies outside the session's scope.
export async function requireClient(): Promise<ClientConfig | null> {
  const scope = await currentScope();
  if (!scope) return null;

  const token = (await cookies()).get(PROJECT_COOKIE)?.value;
  const clientId = await verifyToken(token);
  if (!clientId) return null;

  let client: ClientConfig | null;
  try {
    client = getClientById(clientId);
  } catch (err) {
    // Roster missing/invalid — fail closed rather than serving anyone.
    console.error("[session] Could not load project roster:", err);
    return null;
  }
  if (!client) return null;

  // THE BARRIER. A dash_project cookie signed during a wider session stays
  // cryptographically valid forever, so the signature is not what stops a Domus
  // session from opening Grand Center — this check is. Every GHL-touching route
  // funnels through requireClient(), which is why this is the only place it needs
  // to live, and why it must not be relaxed here "just for one route".
  if (!scopeAllows(scope, client.id)) return null;

  return client;
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
```

- [ ] **Step 2: Aplicar el alcance en `app/api/project/select/route.ts`**

Agregar al bloque de imports:

```ts
import { scopeAllows } from "@/lib/scopes";
import { currentScope } from "@/lib/session";
```

Reemplazar el bloque de validación (líneas 26-36) por:

```ts
  const scope = await currentScope();
  if (!scope) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Validate against the roster AND the session's scope BEFORE signing: signing an
  // id the session may not open would mint a cookie that passes verifyToken but that
  // requireClient() refuses on every request, which reads as "logged out" rather
  // than as the bad input it is.
  let known = false;
  try {
    const client = getClientById(id);
    known = client !== null && scopeAllows(scope, client.id);
  } catch (err) {
    console.error("[project] Could not load project roster:", err);
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }
  if (!known) {
    return NextResponse.json({ error: "unknown_project" }, { status: 400 });
  }
```

- [ ] **Step 3: Verificar que compila y que nada más se rompió**

Run: `npx tsc --noEmit`
Expected: sin errores.

Run: `pnpm verify:auth && pnpm verify:clients && pnpm verify:scopes`
Expected: las tres pasan.

- [ ] **Step 4: Commit**

```bash
git add lib/session.ts app/api/project/select/route.ts
git commit -m "feat(alcances): requireClient rechaza proyectos fuera del alcance de la sesion"
```

---

### Task 4: El picker respeta el alcance

**Files:**
- Modify: `components/dashboard/project-picker.tsx:41-44`, `:93`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `currentScope` de `lib/session.ts` (Task 3); `scopeAllows` de `lib/scopes.ts` (Task 1).
- Produces: `ProjectPicker` acepta `{ projects: PickerProject[]; title?: string }` con default `"Proyectos Lezgo"`. Task 5 pasa `title={domus.label}`.

- [ ] **Step 1: Dar a `ProjectPicker` un prop `title`**

En `components/dashboard/project-picker.tsx`, reemplazar la firma y el efecto del título (líneas 41-44):

```tsx
export function ProjectPicker({
  projects,
  // The scope's own label: a Domus session reads "Proyectos Domus" here and on /,
  // so the filtered wall never looks like a broken copy of the full one.
  title = "Proyectos Lezgo",
}: {
  projects: PickerProject[]
  title?: string
}) {
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => { document.title = title }, [title])
```

Y en el `<h1>` (línea 93), reemplazar el texto literal `Proyectos Lezgo` por `{title}`:

```tsx
            {title}
```

- [ ] **Step 2: Filtrar el roster en `app/page.tsx`**

Archivo completo:

```tsx
// app/page.tsx
// Server shell. Decides between the project picker and the dashboard based on the
// dash_project cookie, narrowed by the session's access scope. The middleware gate
// has already run, so anyone reaching here holds a valid dash_access.
import { cookies } from "next/headers";
import { PROJECT_COOKIE, verifyToken } from "@/lib/auth";
import { getClientById, getClients } from "@/lib/clients";
import { scopeAllows } from "@/lib/scopes";
import { currentScope } from "@/lib/session";
import { DashboardApp } from "@/components/dashboard/dashboard-app";
import { ProjectPicker } from "@/components/dashboard/project-picker";

export default async function Page() {
  const scope = await currentScope();
  const token = (await cookies()).get(PROJECT_COOKIE)?.value;
  const projectId = await verifyToken(token);
  const selected = scope && projectId ? safeLookup(projectId) : null;

  // A project selected before the session narrowed (or by a different password on
  // this machine) is treated as no selection: the picker is the honest answer, and
  // requireClient() would 401 every fetch the dashboard made anyway.
  if (scope && selected && scopeAllows(scope, selected.id)) return <DashboardApp />;

  // Only id and name cross into the browser bundle — never ghlToken or locationId,
  // and never a project outside this session's scope.
  const projects = scope
    ? safeRoster()
        .filter((c) => scopeAllows(scope, c.id))
        .map((c) => ({ id: c.id, name: c.name }))
    : [];
  return <ProjectPicker projects={projects} title={scope?.label ?? "Proyectos Lezgo"} />;
}

function safeLookup(id: string) {
  try {
    return getClientById(id);
  } catch (err) {
    console.error("[page] Could not load project roster:", err);
    return null;
  }
}

function safeRoster() {
  try {
    return getClients();
  } catch (err) {
    // A broken roster shows an empty picker rather than a Next.js error overlay.
    console.error("[page] Could not load project roster:", err);
    return [];
  }
}
```

- [ ] **Step 3: Verificar**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx components/dashboard/project-picker.tsx
git commit -m "feat(alcances): el picker muestra solo los proyectos del alcance"
```

---

### Task 5: La puerta `/domus`

**Files:**
- Create: `app/domus/page.tsx`

**Interfaces:**
- Consumes: `DOMUS_SCOPE_ID`, `getScope`, `scopeAllows` de `lib/scopes.ts`; `currentScope` de `lib/session.ts`; `ProjectPicker` con su prop `title` (Task 4).
- Produces: la ruta `/domus`. No exporta nada.

- [ ] **Step 1: Crear `app/domus/page.tsx`**

```tsx
// app/domus/page.tsx
// The Domus door: a shareable link that opens the picker filtered to the Domus
// projects. It is ONLY a door — the dashboard itself still lives at /, so opening a
// project from here navigates there.
//
// This route is NOT the security boundary. A session's scope comes from the password
// it was opened with (lib/scopes.ts) and is enforced in requireClient(); this page
// only narrows what the picker offers. Reaching /domus with the general password
// grants nothing extra — it is a filtered view of what that session could already
// open.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PROJECT_COOKIE, verifyToken } from "@/lib/auth";
import { getClients } from "@/lib/clients";
import { DOMUS_SCOPE_ID, getScope, scopeAllows } from "@/lib/scopes";
import { currentScope } from "@/lib/session";
import { ProjectPicker } from "@/components/dashboard/project-picker";

export default async function DomusPage() {
  const domus = getScope(DOMUS_SCOPE_ID);
  const session = await currentScope();
  if (!domus || !session) redirect("/");

  // Already inside a Domus project → the dashboard, which lives at /. The test is
  // membership in DOMUS, not merely in the session's scope: a general session with
  // Grand Center open is better served the Domus picker than Grand Center's
  // dashboard, which is not what this link means.
  const token = (await cookies()).get(PROJECT_COOKIE)?.value;
  const projectId = await verifyToken(token);
  if (projectId && scopeAllows(domus, projectId) && scopeAllows(session, projectId)) {
    redirect("/");
  }

  // The intersection of the two scopes: a general session sees the same three, and a
  // Domus session cannot be widened by visiting this route.
  const projects = safeRoster()
    .filter((c) => scopeAllows(domus, c.id) && scopeAllows(session, c.id))
    .map((c) => ({ id: c.id, name: c.name }));

  return <ProjectPicker projects={projects} title={domus.label} />;
}

function safeRoster() {
  try {
    return getClients();
  } catch (err) {
    console.error("[domus] Could not load project roster:", err);
    return [];
  }
}
```

Nota sobre `redirect()`: lanza una excepción de control de flujo de Next, así que **no** debe llamarse dentro de un `try`. Por eso `safeRoster()` está aparte.

- [ ] **Step 2: Verificar**

Run: `npx tsc --noEmit`
Expected: sin errores.

Run: `pnpm dev` y abrir `http://localhost:3000/domus` con una sesión general activa.
Expected: el picker con **tres** plates — Condesa Cimatario, Yconia, Plaza Bosques / Meseta — y el título "Proyectos Domus". Al abrir uno, aterriza en `/` con el dashboard de ese proyecto.

- [ ] **Step 3: Commit**

```bash
git add app/domus/page.tsx
git commit -m "feat(domus): agrega la puerta /domus con el picker filtrado"
```

---

### Task 6: El link `/domus` sobrevive al login

**Files:**
- Modify: `middleware.ts:23-31` (función `denied`)
- Modify: `app/login/page.tsx:30-33`, y una función nueva al final del archivo

**Interfaces:**
- Consumes: nada nuevo.
- Produces: el redirect a `/login` lleva `?next=<pathname>`; la página de login lo consume.

- [ ] **Step 1: Adjuntar `?next=` en `middleware.ts`**

Reemplazar la función `denied` completa:

```ts
function denied(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const requested = req.nextUrl.pathname;
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  // Carry the requested page so the login can return there — this is what makes a
  // shared /domus link survive the gate. Only the pathname: the original search is
  // dropped, since it is attacker-controllable and nothing downstream needs it.
  url.search = requested && requested !== "/" ? `?next=${encodeURIComponent(requested)}` : "";
  return NextResponse.redirect(url);
}
```

- [ ] **Step 2: Consumir `?next=` en `app/login/page.tsx`**

Reemplazar el bloque de éxito (líneas 30-33):

```tsx
      if (res.ok) {
        router.replace(safeNext());
        router.refresh();
        return;
      }
```

Y agregar al final del archivo, después del componente:

```tsx
// Reads ?next= from the current URL. Read from window rather than useSearchParams so
// this page needs no Suspense boundary — useSearchParams would make the build demand
// one.
//
// Only same-origin paths are honoured: "//evil.com" is protocol-relative and "/\evil"
// is normalised the same way by some browsers, so both would leave the site. Anything
// else falls back to "/".
function safeNext(): string {
  if (typeof window === "undefined") return "/";
  const raw = new URLSearchParams(window.location.search).get("next");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
```

- [ ] **Step 3: Verificar**

Run: `npx tsc --noEmit`
Expected: sin errores.

Con `pnpm dev` corriendo, borrar las cookies del sitio y visitar `http://localhost:3000/domus`.
Expected: redirige a `/login?next=%2Fdomus`; al escribir una contraseña válida aterriza de vuelta en `/domus`.

Visitar `http://localhost:3000/login?next=//example.com` sin sesión y entrar.
Expected: aterriza en `/`, **no** en example.com.

- [ ] **Step 4: Commit**

```bash
git add middleware.ts app/login/page.tsx
git commit -m "feat(login): vuelve al link de origen tras autenticarse"
```

---

### Task 7: Documentación y verificación de punta a punta

**Files:**
- Modify: `CLAUDE.md` (bloque `Commands`, sección `Environment Variables`, sección `Internal projects & the access gate`)

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada de código.

- [ ] **Step 1: Documentar el comando de verificación**

En el bloque ```bash de `## Commands`, después de la línea de `verify:clients`:

```
pnpm verify:scopes       # lib/scopes.ts   — alcances: ids cookie-safe + proyectos existentes
```

Y en el párrafo que sigue al bloque ("Run them after touching auth, the roster, the credential context, or the limiter"), agregar `los alcances,` a la lista: *"…after touching auth, the roster, **los alcances**, the credential context, or the limiter."*

- [ ] **Step 2: Documentar el env var**

En `## Environment Variables`, después de la entrada de `DASHBOARD_ACCESS_PASSWORD`:

```markdown
- `DOMUS_ACCESS_PASSWORD` — la contraseña del alcance **domus**. Una sesión abierta
  con ella queda limitada a Condesa, Yconia y Plaza Bosques / Meseta (ver
  `lib/scopes.ts`). Si no está definida, ese alcance no se puede abrir y el
  deployment se comporta como si no existiera. Mismo cuidado con `$` que
  `DASHBOARD_ACCESS_PASSWORD`: comillas simples en `.env.local`, sin comillas en la
  UI de Vercel.
```

Y actualizar la entrada de `DASHBOARD_ACCESS_PASSWORD`, que ya no es "the one shared password":

```markdown
- `DASHBOARD_ACCESS_PASSWORD` — la contraseña del alcance **all**: acceso a todos los
  proyectos del roster. Gates the whole deployment; past the gate a user may open any
  project their scope allows. If the value contains `$`, single-quote it in
  `.env.local` so dotenv doesn't expand it — but paste it **unquoted** in the Vercel
  UI, where quotes become part of the password.
```

- [ ] **Step 3: Documentar el modelo de alcances**

En `### Internal projects & the access gate`, reemplazar la tabla de las dos cookies por:

```markdown
| Cookie | Payload | Verified by | Answers |
|---|---|---|---|
| `dash_access` | `<scopeId>.<expiry>.<hmac>` | `middleware.ts` | ¿qué conjunto de proyectos puede abrir? |
| `dash_project` | `<clientId>.<expiry>.<hmac>` | `requireClient()` (`lib/session.ts`) | ¿cuál está viendo? |
```

Y agregar, justo después de la lista numerada de esa sección:

```markdown
**Alcances (`lib/scopes.ts`).** Una contraseña no solo abre la puerta: decide **qué
proyectos** puede abrir la sesión. Cada alcance declara su `passwordEnv` y su lista de
`projectIds` (`null` = todo el roster). Hoy son dos: `all` (`DASHBOARD_ACCESS_PASSWORD`,
todos) y `domus` (`DOMUS_ACCESS_PASSWORD`, solo Condesa, Yconia y Plaza Bosques /
Meseta). El id del alcance es el payload firmado de `dash_access`.

`lib/scopes.ts` es puro y **no importa `lib/clients.ts`** — lo importa el middleware, y
el roster arrastraría los tokens de GHL al bundle de Edge. Nombra proyectos por id, que
no son secretos.

**La barrera vive en `requireClient()`**, no en el picker ni en las páginas. Una cookie
`dash_project` firmada durante una sesión más amplia sigue siendo criptográficamente
válida para siempre; lo que impide que una sesión Domus abra Grand Center es
`scopeAllows()` dentro de `requireClient()`. Filtrar el roster en `app/page.tsx` es
cosmético — necesario para no mandar proyectos ajenos al navegador, pero no es lo que
protege. **Nunca relajes esa comprobación "solo para una ruta".**

`/domus` (`app/domus/page.tsx`) es un link compartible que abre el picker filtrado a
los proyectos Domus. Es una puerta, no una segunda app: el dashboard sigue viviendo en
`/`. Abrirla con la contraseña general no concede nada extra.

El login (`app/api/auth/login/route.ts`) compara la contraseña enviada contra **todos**
los alcances configurados **sin cortar en el primer acierto**: un `break` haría que el
tiempo de respuesta delatara cuál contraseña se acertó. También borra `dash_project`,
para que entrar con otra contraseña en la misma máquina caiga en el picker y no en un
401.
```

- [ ] **Step 4: Verificación completa antes del commit final**

Run: `pnpm verify:scopes && pnpm verify:auth && pnpm verify:clients && pnpm verify:limiter && pnpm verify:context`
Expected: las cinco pasan.

Run: `npx tsc --noEmit`
Expected: sin errores.

Run: `pnpm build`
Expected: build exitoso (recordando que ignora errores de TS — por eso el `tsc` de arriba es el que cuenta).

- [ ] **Step 5: Manejar la app real — el guion completo**

Con `pnpm dev` y las cookies del sitio borradas entre pasos:

1. Entrar en `/` con `DASHBOARD_ACCESS_PASSWORD` → **seis** proyectos, título "Proyectos Lezgo".
2. Cerrar sesión. Entrar en `/` con `DOMUS_ACCESS_PASSWORD` → **tres** proyectos (Condesa Cimatario, Yconia, Plaza Bosques / Meseta), título "Proyectos Domus". Grand Center, Balvanera y Lezgo Suite no aparecen.
3. Sin sesión, visitar `/domus` → `/login?next=%2Fdomus` → tras entrar, de vuelta en `/domus`.
4. Con la sesión Domus abierta, en la consola del navegador:
   ```js
   await fetch("/api/project/select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "grand-center" }) }).then(r => r.status)
   ```
   Expected: `400`.
5. El ataque de cookie robada. Con la sesión **general**, abrir Grand Center y copiar el valor de la cookie `dash_project` desde DevTools → Application → Cookies. Cerrar sesión, entrar con la contraseña Domus, y pegar esa cookie `dash_project` a mano. Recargar `/`.
   Expected: el **picker** (no el dashboard de Grand Center). Y en consola:
   ```js
   await fetch("/api/dashboard").then(r => r.status)
   ```
   Expected: `401`.
6. Abrir Condesa desde la sesión Domus → el dashboard sincroniza normal, las tres pestañas funcionan, y "Cambiar proyecto" vuelve al picker de tres.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(alcances): documenta los alcances de acceso y la puerta /domus"
```

---

## Después del plan

`DOMUS_ACCESS_PASSWORD` ya está en `.env.local`. **Falta darla de alta en Vercel** antes de desplegar — sin ella el alcance domus existe en el código pero nadie puede abrir una sesión con él, y `/domus` solo sirve como vista filtrada para el equipo general.

**Al desplegar, toda sesión viva queda invalidada** (el payload `ok` de las cookies actuales ya no resuelve a ningún alcance) y cada persona escribe la contraseña una vez más. Es esperado, no un bug.
