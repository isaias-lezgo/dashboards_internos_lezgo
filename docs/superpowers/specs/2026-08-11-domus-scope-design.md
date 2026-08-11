# Alcances de acceso y la puerta `/domus`

**Fecha:** 2026-08-11
**Estado:** aprobado, pendiente de implementar

## Problema

Hoy el deployment tiene una sola contraseña compartida (`DASHBOARD_ACCESS_PASSWORD`)
y, pasada la puerta, cualquier usuario puede abrir cualquiera de los seis proyectos
del roster. Queremos entregarle al equipo Domus un link propio — `/domus` — con su
propia contraseña, cuya sesión quede **limitada** a tres proyectos:

- `condesa` — Condesa Cimatario
- `yconia` — Yconia
- `plaza-bosques` — Plaza Bosques / Meseta

Quedan fuera `grand-center`, `balvanera` y `lezgo-suite`.

Esto es una **barrera real**, no una vista de conveniencia: una sesión Domus no debe
poder abrir Grand Center, Balvanera ni Lezgo Suite aunque escriba la URL, forje la
selección o conserve una cookie de una sesión anterior.

## Modelo: alcances (scopes)

Se introduce el concepto de **alcance**: un conjunto de proyectos al que da acceso
una contraseña.

Nuevo módulo `lib/scopes.ts`. Es **puro y Edge-safe** y **no importa `lib/clients.ts`**,
por la misma razón que `lib/auth.ts` no lo hace: el middleware lo importa, y arrastrar
el roster metería las credenciales de GHL en el bundle de Edge.

```ts
export interface AccessScope {
  id: string                              // viaja dentro de la cookie punteada → sin puntos
  label: string                           // título del picker
  passwordEnv: string                     // nombre del env var con SU contraseña
  projectIds: readonly string[] | null    // null = todo el roster
}

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
]

export function getScope(id: string | null): AccessScope | null
export function scopeAllows(scope: AccessScope, projectId: string): boolean
```

`scopeAllows` devuelve `true` para cualquier proyecto cuando `projectIds` es `null`.

La lista de proyectos vive **en código** (no en un env var): los ids no son secretos,
y así cambiar quién ve qué queda versionado y revisable en el diff. La contraseña —
que sí es secreta — vive en un env var.

Si `DOMUS_ACCESS_PASSWORD` no está configurada, el alcance domus simplemente no
existe y el deployment se comporta exactamente como hoy.

### El payload de `dash_access` cambia

`ACCESS_PAYLOAD = "ok"` desaparece de `lib/auth.ts`. El payload firmado de la cookie
`dash_access` pasa a ser el **id del alcance** (`all` | `domus`). La cookie sigue sin
llevar identidad ni PII: solo dice a qué conjunto de proyectos da derecho.

**Consecuencia de despliegue:** las cookies vivas llevan el payload `ok`, que ya no
resuelve a ningún alcance, así que **toda sesión activa queda invalidada y cada
usuario escribe la contraseña una vez más**. Se evaluó dejar `"ok"` como id del
alcance general para evitarlo, y se descartó: es un nombre críptico que habría que
arrastrar para siempre a cambio de un re-login trivial en una herramienta interna.

## Dónde se aplica

Cuatro puntos. El segundo es el que convierte esto en una barrera de verdad.

### 1. `middleware.ts`

```ts
const payload = await verifyToken(req.cookies.get(ACCESS_COOKIE)?.value)
if (payload && getScope(payload)) return NextResponse.next()
return denied(req)
```

Sigue verificando **solo** la puerta, sin resolver el roster ni el proyecto.

### 2. `requireClient()` — `lib/session.ts`

El choke point. Toda ruta que toca GHL ya pasa por aquí, así que es el único lugar
donde hay que poner la validación para que no haya ruta que se la salte.

Pasa a leer **las dos** cookies:

1. `dash_access` → `getScope(payload)`; si es `null`, devuelve `null`.
2. `dash_project` → `getClientById(id)`; si es `null`, devuelve `null`.
3. Si `!scopeAllows(scope, client.id)` → devuelve `null` (los llamadores ya
   responden `401` vía `unauthorized()`).

Esto es lo que hace que una cookie `dash_project` de Grand Center — legítimamente
firmada por una sesión anterior — no sirva de nada dentro de una sesión Domus.

### 3. `app/api/project/select/route.ts`

Hoy valida el id contra el roster. Pasa a validar contra el **alcance de la sesión**:
lee `dash_access`, resuelve el alcance, y si el proyecto no está permitido responde
`400 unknown_project` sin firmar nada. Firmar un id fuera del alcance produciría una
cookie válida que `requireClient` rechaza en cada request, que se lee como "sesión
caída" en vez de como la entrada inválida que es.

### 4. Los shells de servidor

`app/page.tsx` filtra el roster por el alcance de la sesión antes de mapear a
`{ id, name }`. Grand Center, Balvanera y Lezgo Suite **nunca llegan al bundle del
navegador** de una sesión Domus.

Si la cookie `dash_project` apunta a un proyecto fuera del alcance, el shell la trata
como no seleccionada y renderiza el picker.

El título del picker sale del `label` del alcance, así que el equipo Domus lee
"Proyectos Domus" también al volver a `/`.

## Login: una pantalla, varias contraseñas

`app/api/auth/login/route.ts` deja de comparar contra un único valor y recorre los
alcances configurados:

```ts
let matched: AccessScope | null = null
for (const scope of SCOPES) {
  const expected = process.env[scope.passwordEnv]
  if (!expected) continue
  if (safeEqual(submitted, expected)) matched = scope   // sin break
}
```

**Sin `break`, a propósito.** Cortar en el primer acierto haría que el tiempo de
respuesta delatara *cuál* contraseña se acertó. El bucle recorre siempre todos los
alcances, en la misma línea de por qué la comparación es `safeEqual` y no `===`.

Si ningún alcance tiene contraseña configurada (o falta `DASHBOARD_AUTH_SECRET`) →
`500 server_misconfigured`, como hoy.

El limitador por IP (5 intentos / 15 min) no cambia: es por IP, no por alcance.

**El login borra `dash_project`** al establecer `dash_access`. Cubre el caso real de
entrar con la clave general, abrir Grand Center, y después entrar con la clave Domus
en la misma máquina: sin esto la cookie de Grand Center sobrevive y, aunque
`requireClient` la rechaza, el usuario ve un error en vez del picker.

### Volver al link de origen

`middleware.ts`, al denegar una **página**, adjunta `?next=<pathname>` en vez de
vaciar el search. `app/login/page.tsx` lee ese parámetro y redirige ahí tras un login
exitoso, **solo si** es una ruta interna: empieza con `/` y no con `//` (que el
navegador interpretaría como protocol-relative hacia otro host). Cualquier otro valor
cae a `/`. Así el link `/domus` sobrevive al login.

Las rutas `/api/` siguen recibiendo `401 JSON`, sin `next`.

## La puerta `/domus`

`app/domus/page.tsx`, gemelo de `app/page.tsx`:

- Si ya hay un proyecto seleccionado **y es uno de los tres de Domus** →
  `redirect("/")`. El dashboard sigue viviendo en `/`; `/domus` es la puerta, no una
  segunda aplicación. La condición es la pertenencia a Domus, no solo al alcance de
  la sesión: si un usuario `all` con Grand Center abierto entra a `/domus`, ver el
  picker de Domus es más útil que aterrizar en el dashboard de Grand Center.
- Si no → picker con la **intersección** de los tres proyectos Domus con el alcance
  de la sesión. Una sesión `all` que abra `/domus` ve los tres: es una vista
  filtrada legítima, no un hueco. Una sesión `domus` ve los mismos tres.
- Título: "Proyectos Domus".

`ProjectPicker` recibe un prop `title` con default `"Proyectos Lezgo"`; también
gobierna el `document.title`. Nada más cambia en el picker — los logos de los tres
proyectos ya existen en `public/logos/` y ya están en el mapa `LOGOS`.

La selección desde `/domus` sigue haciendo `window.location.href = "/"`: recarga
completa, nunca `router.push`, por la regla de que toda transición de proyecto debe
tirar el árbol de React del proyecto anterior.

## Verificación

No hay framework de tests en este repo y no se adopta uno. Se sigue la convención de
`scripts/verify-*.ts` (`node:assert/strict` vía `tsx`), recordando que el paquete es
CommonJS: el trabajo asíncrono va dentro de un `main()` con `main().catch(...)`,
nunca `await` de nivel superior.

**`scripts/verify-scopes.ts`** (nuevo, `pnpm verify:scopes`):

- Todo `scope.id` cumple el mismo `ID_RE` que los ids de proyecto y **no contiene
  puntos** — viaja dentro del token punteado.
- Los `id` de alcance son únicos.
- Todo `projectId` de todo alcance existe en un roster de ejemplo: un alcance que
  apunte a un proyecto borrado del roster es un error de configuración silencioso.
- `scopeAllows(domus, ...)` acepta los tres y **rechaza `grand-center`, `balvanera`
  y `lezgo-suite`**.
- `scopeAllows(all, ...)` acepta cualquier id (`projectIds: null`).
- `getScope("no-existe") === null` y `getScope(null) === null`.

**`scripts/verify-auth.ts`** (extender):

- Quitar la aserción `ACCESS_PAYLOAD === "ok"`.
- Roundtrip firmar/verificar con un payload de alcance.
- Una cookie manipulada de `domus` a `all` falla la verificación (el payload va
  dentro de la firma).

**`npx tsc --noEmit`** — obligatorio: `next build` ignora los errores de TypeScript,
así que un build verde no prueba nada.

**Manejar la app real** (lo único que prueba el flujo completo):

1. Login con la contraseña general → seis proyectos, título "Proyectos Lezgo".
2. Login con la contraseña Domus → tres proyectos, título "Proyectos Domus".
3. Visitar `/domus` sin sesión → login → aterriza de vuelta en `/domus`.
4. Desde una sesión Domus: `POST /api/project/select {"id":"grand-center"}` → `400`.
5. Desde una sesión Domus con una cookie `dash_project` de Grand Center pegada a
   mano (tomada de una sesión general válida): `/api/dashboard` → `401`.
6. Un proyecto Domus abre y sincroniza con normalidad.

## Configuración

- Nuevo env var **`DOMUS_ACCESS_PASSWORD`** en `.env.local` y en Vercel. Como con
  `DASHBOARD_ACCESS_PASSWORD`: si contiene `$`, entrecomillar con comillas simples en
  `.env.local`, pero pegarla **sin comillas** en la UI de Vercel.
- Documentar en CLAUDE.md: el env var nuevo, el modelo de alcances y el hecho de que
  `requireClient()` es el punto donde se aplica.

## Fuera de alcance (YAGNI)

- UI de administración de alcances.
- Alcances por usuario o identidad individual — la puerta sigue siendo por
  contraseña compartida dentro de cada alcance.
- Un tercer alcance. Agregarlo después es una entrada en `SCOPES` más un env var.
