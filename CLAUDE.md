# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev        # Start Next.js dev server (localhost:3000)
pnpm build      # Production build (TypeScript errors are ignored — see next.config.mjs)
pnpm start      # Serve production build
pnpm lint       # Run ESLint

# Multi-client
pnpm add-client # Add a project to the DASHBOARD_CLIENTS roster (prompts, validates, prints the blob)
                #   Non-interactive: pnpm add-client --name "X" --location <id> --token pit-…
pnpm db:migrate # Crea/verifica la tabla project_sync en Neon. Idempotente.

# Verification (see below — there is no test framework)
pnpm verify:clients      # lib/clients.ts   — roster parsing
pnpm verify:scopes       # lib/scopes.ts    — alcances: ids cookie-safe + proyectos existentes
pnpm verify:sync-store   # lib/sync-store.ts — roundtrip gzip + aislamiento por proyecto + candado
pnpm verify:auth         # lib/auth.ts      — session token; incl. the cookie-tamper rejection
pnpm verify:limiter      # lib/ghl-limiter.ts — per-location isolation + retry backoff caps
pnpm verify:context      # lib/ghl-context.ts — credential isolation across concurrent requests
pnpm verify:attachments  # lib/attachments.ts + lib/attachment-tools.ts — tabular parse/query/join
pnpm verify:cf-merge     # lib/custom-field-merge.ts — fusión de opciones (no borra) + validación de valores
pnpm verify:write-tools  # WRITE_TOOLS ⊇ definiciones + lista blanca de /api/ghl-write sin borrado
pnpm verify:filters      # lib/dashboard-filters.ts — la cascada por contacto + los cuatro criterios
npx tsc --noEmit         # REQUIRED: next build ignores TS errors, so a green build proves nothing
```

**No test framework, and not adopting one.** Instead, the modules where a silent bug
would be a *cross-project data leak* — or would strand a sync — have assertion scripts
under `scripts/verify-*.ts` (plain `node:assert/strict`, run via `tsx`). Run them after
touching auth, the roster, los alcances, the credential context, or the limiter.
Everything else is verified by driving the real app.

`verify:sync-store` es el único que toca una base real: corre sus aserciones puras
siempre, y el roundtrip contra Postgres solo si hay `DATABASE_URL`. Usa ids sintéticos
(`__verify_*`, imposibles en el roster porque `ID_RE` prohíbe guiones bajos) y los borra
al terminar. Su script de npm carga `--env-file-if-exists=.env.local`, así que corre
igual en un entorno sin ese archivo.

Gotcha when writing these scripts: this package is CommonJS (no `"type": "module"`),
so `tsx` compiles to CJS where **top-level `await` fails**. Wrap async work in a
`main()` and call `main().catch(...)` — see the existing scripts.

**Package manager: pnpm.** This repo is managed with pnpm (`packageManager: pnpm@11.x`
in `package.json`), and the Vercel deploy runs `pnpm install --frozen-lockfile` against
`pnpm-lock.yaml`. **Install and add dependencies with `pnpm install` / `pnpm add <pkg>`
— never `npm install`.** Running `npm install` writes `package-lock.json` but leaves
`pnpm-lock.yaml` stale, which makes the Vercel build fail with
`ERR_PNPM_OUTDATED_LOCKFILE`. If a lockfile ever drifts, run `pnpm install
--lockfile-only` to resync only the lockfile (no `node_modules` churn), then commit it.
A tracked `package-lock.json` lingers from before the switch; it is **not** the source
of truth — ignore it.

## Environment Variables

Required vars in `.env.local`:
- `DASHBOARD_ACCESS_PASSWORD` — the password of the **`all`** access scope: every
  project in the roster. Gates the whole deployment; past the gate a user may open any
  project **their scope allows**. If the value contains `$`, single-quote it in
  `.env.local` so dotenv doesn't expand it — but paste it **unquoted** in the Vercel
  UI, where quotes become part of the password.
- `DOMUS_ACCESS_PASSWORD` — the password of the **`domus`** scope. A session opened
  with it is limited to Condesa Cimatario, Yconia and Plaza Bosques / Meseta (see
  `lib/scopes.ts`). If it is not set, that scope cannot be opened by anyone and the
  deployment behaves as if it did not exist. Same `$` caveat as above.
- `DASHBOARD_CLIENTS` — JSON array of projects, one per GHL sub-account:
  `[{"id","name","locationId","ghlToken"}]`. Use `pnpm add-client` to extend it safely.
- `DASHBOARD_AUTH_SECRET` — random string used to HMAC-sign both session cookies
  (`openssl rand -hex 32`). Rotating it invalidates every live session.
- `DATABASE_URL` — Neon (Postgres serverless), el caché de sincronización. La
  integración de Vercel la inyecta sola. **Región `us-east-1`: las funciones de Vercel
  deben estar en `iad1`**, o cada lectura del payload paga el viaje entre continentes
  y se come lo que el caché gana.
- `DATABASE_URL_UNPOOLED` — la misma base sin pgbouncer. Solo la usa `pnpm db:migrate`:
  el pooler en modo transaction estorba al DDL.
- `ANTHROPIC_API_KEY` — used by `app/api/chat` (assistant), `analyze-report` (PDF analyses)
  and `analyze-contact`
- `GHL_API_TOKEN` / `GHL_LOCATION_ID` — **not read by the app.** Kept only so the dev
  GHL MCP server (`.mcp.json`) can point at one sub-account.

All are server-side only. `DASHBOARD_CLIENTS` is read in `lib/clients.ts`;
`DASHBOARD_AUTH_SECRET` in `lib/auth.ts`, `app/api/auth/login/route.ts`,
`app/api/project/select/route.ts`, and `middleware.ts` — never exposed to the browser.

## Architecture

This is a single-page Next.js 16 (App Router) dashboard that surfaces GoHighLevel CRM data in three tabs: **Marketing**, **Ventas**, and **Asistente IA**. It is **multi-tenant**: one deployment serves every client, and a client's password resolves to their own GHL sub-account (see "Multi-client" below).

### Current state

- `components/dashboard/marketing-dashboard.tsx` and `components/dashboard/sales-dashboard.tsx` — **fully built**: each receives already-filtered data as props and renders its own set of charts, KPI cards, and drill-down drawers.
- The third tab (`DashboardTab` id `"conversations"`, labelled **"Asistente IA"**) renders `conversations-chat.tsx`. It is **permanently mounted and merely hidden** when inactive, so the chat history survives tab switches — do not make it conditional. It always sees the full, unfiltered dataset.
- Both dashboards can **export a branded PDF report** of their own charts (see "PDF report export").

### Data flow

```
browser → middleware.ts (verifies the signed dash_access cookie)
    ↓
app/api/dashboard/route.ts
    ↓  requireClient()  → resolves dash_project to a ClientConfig (lib/session.ts)
    ↓  withClient(...)  → establishes the per-request credential context (lib/ghl-context.ts)
    ↓
lib/ghl-client.ts  (raw GHL types + fetch helpers; reads token+location from the context)
    ↓  lib/ghl-limiter.ts  (concurrency + rate limiting, keyed PER LOCATION)
GHL REST API (services.leadconnectorhq.com)
    ↓  back up: transforms GHL → internal types; contacts/opps/pautas/appointments/tasks fetched concurrently
    ↓  NDJSON stream of {progress|location|step|data|error} frames
hooks/fetch-stream.ts  (parses the NDJSON stream)
    ↓
hooks/use-dashboard-data.ts  (custom streaming fetcher; exposes data, progress text, and structured per-dataset `steps`. No SWR/caching — refresh() re-runs the full sync)
    ↓
components/dashboard/dashboard-app.tsx  (tab state, date-filter state, applies the client-side date-range filter, renders dashboard)
    ↓
components/dashboard/{marketing,sales}-dashboard.tsx
```

Beyond that main sync, the app has these routes. Every one that touches GHL runs through
`requireClient()` + `withClient()`; the ones marked **no GHL** work off data the browser
already holds and need only the middleware gate:

| Route | Purpose |
|---|---|
| `dashboard` | the main NDJSON sync above |
| `dashboard-messages` | NDJSON stream of conversation messages, loaded separately from the main sync |
| `conversations` | on-demand full message threads for a batch of contacts |
| `contact-notes` / `contact-tasks` | per-contact detail, fetched live when a drawer opens |
| `analyze-contact` | Anthropic call summarizing one contact (does read GHL for the opportunity) |
| `chat` | one Anthropic turn for the AI assistant — **no GHL** |
| `analyze-report` | Anthropic pass writing the PDF report's analyses — **no GHL** |
| `auth/login` / `auth/logout` | the shared-password gate cookie |
| `project/select` / `project/clear` | which project the session is viewing — **no GHL** |

Client-side data hooks mirror this: `use-dashboard-data.ts` (main sync),
`use-conversations-data.ts` (messages), `use-agent-loop.ts` (the AI agent loop), all
built on `fetch-stream.ts` for the NDJSON routes.

### El caché de sincronización

Un sync completo tarda entre 34 y 60 segundos (Yconia, medido dos veces el mismo día
con los mismos datos — GHL varía casi al doble). Por eso `/api/dashboard` **no llama a
GHL en el camino normal**: lee `project_sync`, una fila por proyecto con el payload en
gzip (27.7 MB → 2.49 MB, 11x) y su `synced_at`.

```
GET /api/dashboard
    ↓  requireClient()   → proyecto + alcance
    ↓  readSync(client)  → fila de project_sync
    ├─ hay fila → manda el payload YA; si pasó de 15 min, after(() => refrescar)
    └─ no hay   → sync en vivo con pantalla de carga, y lo guarda
```

- `lib/db.ts` es **la costura**: nada aguas abajo sabe que la base es Neon.
- `lib/sync.ts` tiene la orquestación, extraída del route handler para que la ruta y el
  refresco en segundo plano llamen al mismo código. Dos copias se desincronizarían.
- **El caché es desechable.** Se sobrescribe cada vez y guarda solo el presente, nunca
  historia: si se borra la tabla, se rellena sola desde GHL. Esa propiedad es lo que lo
  mantiene en una tabla en vez de un esquema, y lo que evita acumular datos personales
  históricos.
- **La base no es una dependencia.** Todo fallo de Postgres se registra y cae al sync en
  vivo. Introducir el caché no debe crear una forma nueva de que el dashboard no
  cargue — está probado apuntando `DATABASE_URL` a un host inválido y confirmando que
  la app sigue funcionando.
- **`maxDuration = 300` depende de Fluid Compute, no del plan.** Con Fluid activado
  (Settings → Functions) Hobby permite 300s; sin él el techo es 60s, que un sync real
  de 60.3s ya rebasó. Verificado el 2026-08-12: el proyecto corre en **Hobby con Fluid
  activado**, así que los 300s son reales. Si alguien apaga Fluid, el síntoma es sutil
  — un proyecto cuyo "Actualizado hace X" deja de avanzar, porque el refresco en
  segundo plano se corta en silencio al correr *después* de que la respuesta salió.
- **La región de las funciones debe coincidir con la de Neon.** Ambas en `iad1` /
  `us-east-1`. Medido el 2026-08-12 desde producción: Yconia 2.4s, Condesa 1.1s,
  Lezgo Suite 0.8s, contra 34-60s sin caché.
- El candado (`sync_started_at`) hace que dos personas abriendo el mismo proyecto
  vencido produzcan **una** sincronización. Se auto-sana a los 10 minutos, para que una
  función muerta a medio sync no congele el proyecto.
- `writeSync` limpia el candado por sí solo, así que solo el camino de error llama a
  `releaseSync` — y ese **no toca el payload**: un refresco fallido debe dejar el
  último caché bueno en su lugar.
- El header muestra **"Actualizado hace X"** en tiempo relativo, no la hora del reloj:
  un caché sin antigüedad visible miente por omisión. El botón **Actualizar** manda
  `?fresh=1`, que se salta el caché.
- `/api/dashboard-messages` **no está cacheado** — se puede agregar igual después.

### Internal projects & the access gate

This deployment is **internal**. It serves the projects the company commercializes
for third parties, to company staff. The client-facing product — where a client's
password is their identity — is a *separate* deployment and shares no state with
this one.

**Vocabulary warning:** the UI says "proyecto" everywhere, but the internal code
still says `client` (`ClientConfig`, `getClientById`, `withClient`,
`DASHBOARD_CLIENTS`). This is deliberate — renaming would touch ~20 files without
changing behavior. When reading this code, "client" means "one of our projects",
not "a paying customer".

Two cookies, two questions:

| Cookie | Payload | Verified by | Answers |
|---|---|---|---|
| `dash_access` | `<scopeId>.<expiry>.<hmac>` | `middleware.ts` | which projects may they open at all? |
| `dash_project` | `<clientId>.<expiry>.<hmac>` | `requireClient()` (`lib/session.ts`) | which one are they viewing? |

1. `lib/clients.ts` — the roster, parsed from `DASHBOARD_CLIENTS`. This is the
   **seam**: nothing downstream knows the roster comes from an env var, so swapping
   in a database later touches only this file. Project ids may not contain dots —
   they ride inside the dot-delimited cookie.
2. Login (`app/api/auth/login/route.ts`) compares the submitted value against **every
   configured scope's password** with `safeEqual` and signs the winning scope id into
   `dash_access`. It keeps a per-IP rate limiter (5 attempts / 15 min) — soft, since
   Vercel resets it on cold starts, but it matters more with shared passwords than it
   did with per-client ones.
3. `app/page.tsx` is a **server shell**: it reads `dash_project` and renders either
   `project-picker.tsx` or `dashboard-app.tsx`. The picker receives only
   `{ id, name }` per project — **never `ghlToken` or `locationId`**, which would
   put credentials in the browser bundle.
   The picker is a **brand wall**: one plate per project carrying that logo's own
   background, with the name below it. The plate IS the surface — an earlier
   version nested a logo chip inside a card, which is the "nested cards" ban and
   also made every project weigh the same.

   Logos live in `public/logos/<project-id>.<ext>`, mapped in the `LOGOS` const in
   `project-picker.tsx`. `tone` is **not cosmetic**: most logos are dark ink on
   transparency and need a light plate, but Plaza Bosques ships a white wordmark
   and is invisible on anything but a dark one.

   Amber (`#F59B1B`) appears on hover, focus and pending — nowhere else. Per
   DESIGN.md's north star it marks where attention belongs, so decorating with it
   would destroy the signal.

   Three things have each bitten this picker when adding an asset:
   - **CMYK** — browsers render 4-component JPEGs inconsistently. Convert to RGB.
   - **Baked-in background or whitespace** — trim it and key the background to
     transparent. A hard white rectangle shows as a seam against the plate, which
     is tinted warm rather than pure `#fff`.
   - **Which background it was designed for** — see `tone`.

   A project with no `LOGOS` entry renders without a chip rather than breaking.
4. `POST /api/project/select` validates the id against the roster before signing.
   `POST /api/project/clear` drops the selection, keeping the gate.
5. Middleware verifies **only** `dash_access`. It deliberately does not resolve the
   project — that would drag the roster into the Edge bundle.
6. Every GHL-touching route calls `requireClient()` (`lib/session.ts`), which
   re-verifies `dash_project` **itself** rather than trusting a middleware-injected
   header, which would be a spoofing surface.
7. The route runs its GHL work inside `withClient(client, ...)`
   (`lib/ghl-context.ts`, an `AsyncLocalStorage`). `ghlFetch` reads credentials via
   `currentClient()`, which is why none of its ~113 exported functions needed a
   signature change. `currentClient()` **fails closed** — it throws rather than
   falling back to a default token.
8. `lib/ghl-limiter.ts` keys the concurrency semaphore, token bucket, and 429
   cooldown **by location id**, because GHL's budget is per location. Shared, one
   project's 429 would freeze every other project's sync.

**Alcances (`lib/scopes.ts`).** Una contraseña no solo abre la puerta: decide **qué
proyectos** puede abrir la sesión. Cada alcance declara su `passwordEnv` y su lista de
`projectIds` (`null` = todo el roster). Hoy son dos: `all`
(`DASHBOARD_ACCESS_PASSWORD`, todos) y `domus` (`DOMUS_ACCESS_PASSWORD`, solo Condesa,
Yconia y Plaza Bosques / Meseta). El id del alcance es el payload firmado de
`dash_access`.

`lib/scopes.ts` es puro y **no importa `lib/clients.ts`** — lo importa el middleware, y
el roster arrastraría los tokens de GHL al bundle de Edge. Nombra proyectos por id, que
no son secretos. La lista vive en código, no en un env var, para que cambiar quién ve
qué quede versionado y revisable en el diff.

**La barrera vive en `requireClient()`**, no en el picker ni en las páginas. Una cookie
`dash_project` firmada durante una sesión más amplia sigue siendo criptográficamente
válida para siempre; lo que impide que una sesión Domus abra Grand Center es
`scopeAllows()` dentro de `requireClient()`. Filtrar el roster en `app/page.tsx` es
cosmético — necesario para no mandar proyectos ajenos al navegador, pero no es lo que
protege. **Nunca relajes esa comprobación "solo para una ruta".**

`/domus` (`app/domus/page.tsx`) es un link compartible que abre el picker filtrado a
los proyectos Domus. Es una puerta, no una segunda app: el dashboard sigue viviendo en
`/`. Abrirla con la contraseña general no concede nada extra. Cuando el middleware
rechaza una **página** adjunta `?next=<pathname>`, y `app/login/page.tsx` vuelve ahí
solo si es una ruta interna (`/` sí, `//host` y `/\host` no).

El login compara la contraseña contra **todos** los alcances configurados **sin cortar
en el primer acierto**: un `break` haría que el tiempo de respuesta delatara cuál
contraseña se acertó. También borra `dash_project`, para que entrar con otra contraseña
en la misma máquina caiga en el picker y no en un 401.

**Never obey an upstream `Retry-After` verbatim.** `serverErrorDelayMs()` and
`rateLimitCooldownMs()` (`lib/ghl-limiter.ts`) cap it, because that header is a
value someone else controls. GHL once answered `522 Retry-After: 120` and every
parallel dataset fetch slept two minutes — with `MAX_RETRIES = 4` the worst case
was an eight-minute stall. A 5xx is a broken gateway, not a rate limit; it has no
legitimate knowledge of when we should come back, so its cap is the tighter one.

While `ghlFetch` waits out a backoff the NDJSON stream would otherwise go silent,
leaving the loading screen pinned at 0% with no way to tell "retrying" from
"hung". `reportRetry()` (`lib/ghl-context.ts`) rides the same AsyncLocalStorage as
the credentials so the route can turn a retry into a progress frame. It is
**diagnostics only** — no reporter is a no-op and a throwing reporter is
swallowed, because telling the user about a retry must never break the sync.

**NEVER** replace the AsyncLocalStorage context with a module-level "current client"
variable: one serverless instance serves overlapping requests, so that would
silently render project A's dashboard using project B's token. The users being
internal does not change this — it is a correctness bug, not just a leak.

**Every project transition must be a full page load** (`window.location.href`),
never `router.push` / `router.refresh`. A soft navigation leaves the previous
project's contacts, opportunities and chat history mounted in the cached React
tree. This applies to the picker, "Cambiar proyecto", and logout alike.

The two streaming routes (`dashboard`, `dashboard-messages`) enter the context
**inside** the `ReadableStream` `start()` callback — the stream outlives the
handler's return, so wrapping the handler would leave the pump running outside the
context.

`app/api/chat` and `app/api/analyze-report` never touch GHL (they work off data the
browser already holds), so they need no client context — only the middleware gate.

Verification scripts (no test framework in this repo): `pnpm verify:clients`,
`verify:scopes`, `verify:auth`, `verify:limiter`.

### Loading & progress

**`LoadingScreen` is imported with `next/dynamic` + `ssr: false`, on purpose.** It is a
tree of framer-motion elements, and their `initial` prop (`opacity: 0`,
`translateX(-8px)`, …) gets serialised into the SSR HTML — but on the client the
animations have already advanced past it by the time React hydrates, so the `style`
attributes don't match and React reports a hydration mismatch. `/` is a dynamic route,
so it really was server-rendering that screen. Nothing in `DashboardApp` is
server-renderable anyway: every byte arrives from a client-side fetch. Importing it
normally again silently reintroduces the mismatch.


The dashboard fetch streams NDJSON progress frames rather than returning a single JSON blob, so the UI can show live progress during the multi-second GHL sync:
- `{ type: "location", name }` — sub-account name (resolved first, for the loading header).
- `{ type: "step", key, status, count }` — structured per-dataset progress. `key` ∈ `config | contacts | opportunities | pautas | appointments | tasks`; `status` ∈ `loading | done`. The loading screen no longer lists these one row each — see below — but it still **counts** them to size its progress rail.

**The loading screen is sized for the cached path, not the sync.** Since the Postgres
cache landed, the normal open takes about a second, so `loading-screen.tsx` is a quiet
identity hold: mark, wordmark, one rail. It says nothing it cannot know.

- Two regimes, one screen, discriminated by whether **any step frame has arrived**. The
  cached response is a single `data` frame, so all-pending means "waiting on the cache"
  → indeterminate rail, no text. The moment a step frame moves off `pending` we are on
  the cold path → the rail goes determinate on completed-step count and a single line
  shows the sync's own progress message, which already carries the dataset name and its
  running count. That is what replaced the six rows.
- **Never show a percentage on the cached path.** The old screen rendered a determinate
  bar pinned at 0% and "Iniciando sincronización…" for the whole one-second cache read,
  because the cached path emits no frames to move them. A progress number that cannot
  advance is worse than no number.
- No skeleton for the sub-account name: on the cached path `locationName` never arrives
  before the data does, so a pill that pulses and then vanishes promises something that
  was never coming. The kicker falls back to "Marketing y Ventas".
- The mark keeps its own `#0D172F` plate. It is a white "L" in an amber outline, drawn
  for the dark header, and it disappears on the light theme's background without it.
- `dashboard-app.tsx` delays mounting the screen by 300 ms, so a fast cache read never
  flashes it at all. The screen's own 5 s `PATIENCE_MS` timer is the other end of that:
  only past it does a still-silent wait admit it is slow.
- `{ type: "progress", message }` — human-readable fallback text.
- `{ type: "data", ... }` / `{ type: "error", ... }` — terminal frames.

### AI assistant

The assistant is an **agent loop that runs in the browser**, not on the server.

- `app/api/chat/route.ts` handles exactly **one Anthropic turn per request**. When the
  model returns `tool_use` blocks the server just returns them; `hooks/use-agent-loop.ts`
  executes the tools locally and POSTs back with `tool_result` blocks. The server holds
  **no session state** between turns.
- `lib/ai-tools.ts` — the ~22 `TOOL_DEFINITIONS` and their executor. Most tools
  (`search_*`, `aggregate`, `relate`, `get_*`) run **against the dataset the browser
  already holds** — no extra GHL calls. The exceptions reach back through
  `lib/ghl-fetchers.ts` for data not in the initial sync: `get_contact_messages`,
  `search_conversations`, `get_contact_tasks`, `get_contact_notes`.
- UI-side tools: `render_chart` → `chat-chart.tsx`, `ask_user` → `chat-question.tsx`,
  `show_in_panel` → the conversations context panel, `create_pdf` / `export_csv` →
  direct browser downloads.
- `lib/ai-context.ts` — the Spanish system prompt. It carries hard-won behavioral rules
  (date-window consistency, never concluding from a truncated message sample, `lostReason`
  being a native field, never printing IDs). **Treat those numbered rules as regression
  fixes, not prose** — each one exists because the model got it wrong. Don't trim them
  for brevity.
- `lib/ai-index.ts` — `buildChatIndex()` precomputes the by-contact lookup maps
  (`oppsByContact`, `pautasByContact`, `pautaNameByContact`, …), cached on the contacts
  array reference so it survives within a single agent run.
- `datasetSummary` is built once on the client and pinned for **prompt caching**; keep
  it stable across turns in a session or the cache key breaks.

### Pauta (paid-advertising) classification

`lib/pauta.ts` is the **single source of truth** for what counts as "de pauta", shared by
the marketing charts and the AI tools. Do not re-inline this logic anywhere.

- `isDePauta(opp, pautaContacts)` — a deliberate **union**: the contact is linked to a
  Pauta custom-object record **OR** the opportunity itself carries a paid-traffic
  source/medium (`isPaidTraffic`). Neither signal alone is complete — Pauta records come
  from a Make scenario and don't always exist, and not every paid lead keeps its UTM — so
  each covers the other's gaps.
- `resolveCampaignName()` — an ordered fallback chain, since sub-accounts name the field
  differently ("Nombre pauta", "Nombre de la pauta", …) and some accounts have no
  attribution URL at all.
- Totals legitimately differ between grouping modes; that's by design, not a bug.

### PDF report export

Both dashboards export a branded PDF via `components/dashboard/export-report-button.tsx`.

- `lib/report.ts` composes a `ReportInput` (KPIs + `ReportSection[]`) from the dashboard's
  **already-computed aggregates** — deterministic code, not the model.
- `app/api/analyze-report/route.ts` then makes one Haiku pass that writes an executive
  summary plus one analysis per section. Sections are analyzed **by default**; `ai: false`
  opts out. Token budget is sized to the section count (~13 marketing / ~8 ventas) — if you
  add sections, check it still fits.
- `lib/pdf/*` renders the spec with pdfmake: `build-pdf.ts` (doc definition — **LETTER
  landscape**, 712pt usable width), `charts.ts` (hand-drawn canvas charts), `blocks.ts`
  (tables/KPIs), `branding.ts` (palette, `sanitizeBrand`).
- The same `create_pdf` spec/renderer backs the AI assistant's PDF tool, so both outputs
  share one format. Changing `lib/pdf/*` affects both.
- **Brand rule**: `sanitizeBrand()` strips "GoHighLevel"/"GHL" from all rendered text —
  the platform is presented as "Lezgo Suite CRM". The AI prompts carry the same rule.
- pdfmake **cannot render in a bare Node harness** — verify PDF changes by building and
  driving the real app.

### Key design decisions

- **No mock-data fallback**: when the GHL API is unavailable or errors, the UI renders against empty arrays (`data?.contacts ?? []` patterns in `app/page.tsx`). The former `lib/mock-data.ts` and its stand-ins have been removed.
- **All GHL API calls are server-only**: `lib/ghl-client.ts` is never imported from client components — only from API routes. This keeps the token out of the browser bundle. Client code reaches GHL data through `lib/ghl-fetchers.ts`, which calls those routes.
- **`/opportunities/search` uses `location_id` (snake_case)** while most other endpoints use `locationId` (camelCase). The `useSnakeCaseLocationId` flag in `ghlFetch` handles this quirk.
- **Filtering is entirely client-side**, in two stages, both computed in
  `dashboard-app.tsx` and passed to each dashboard as props. The filter bar is hidden on
  the AI assistant tab, which always sees the full dataset.
  1. **Fecha** — `lib/date-range.ts` (`DateFilter`, `resolveDateRange`,
     `filterByDateRange`) recorta cada dataset por su propia fecha, independientemente.
  2. **Atributos** — `lib/dashboard-filters.ts`: Status, Asesor, Origen de lead y Tipo
     de pauta. Ver "Los filtros de atributo" abajo.

  `components/dashboard/filter-bar.tsx` es la única barra sticky y compone las dos:
  `date-range-filter.tsx` aporta solo sus controles (su `<section>` se movió a la barra)
  y `multi-select-filter.tsx` es el popover genérico usado por los cuatro.

### Los filtros de atributo

`lib/dashboard-filters.ts` es la **única fuente de verdad** de los cuatro criterios. No
re-inlinees ninguna de estas reglas en un componente.

- **El modelo es una cascada por contacto.** Los filtros se evalúan una sola vez sobre
  oportunidades; de las supervivientes sale un conjunto de contactos que recorta citas,
  tareas, pautas y mensajes. Sin esto, la mitad del panel respondería al filtro y la
  otra mitad no.
- **Status usa `isWonOpp()`, no el campo crudo de GHL.** Varias sub-cuentas nunca ponen
  `status: "won"` y registran la venta moviendo la etapa a "Negocio Ganado". Con el campo
  crudo, filtrar "Ganado" devolvería cero junto a un KPI que muestra decenas.
- **Un contacto sin oportunidades se evalúa sobre sus propios campos**
  (`orphanContactPasses`). Tres de los cuatro criterios existen a nivel contacto:
  `assignedTo` es suyo, "Origen de Lead" es originalmente suyo (`lib/sync.ts` lo copia a
  la oportunidad, no al revés) y la primera pauta es contact-level por construcción. Sin
  esa rama, tocar cualquier filtro borraría a todo contacto sin oportunidad y "Leads sin
  oportunidad" daría siempre 0 — una respuesta falsa, no un cero real. **Status es la
  excepción**: quien nunca tuvo una oportunidad no puede estar "Ganado", y ahí el cero sí
  es real.
- **Un registro puede caer en la ventana con su contacto fuera** (`outOfWindowContactPasses`).
  El escenario de Make de Balvanera creó el 3 de agosto ocho pautas para contactos entrados
  en julio: la pauta cae en la ventana, el contacto y su oportunidad no. Las dos fuentes de
  `allowedContactIds` — dueños de oportunidades supervivientes y `data.contacts` — están
  ambas recortadas por fecha, así que lo perdían y el registro se caía en `byContact()`
  **aunque cumpliera el criterio**. Síntoma: la gráfica "Pautas por canal" pasaba de 21 a 13
  formularios con CUALQUIER filtro activo, incluso uno que seleccionara todas las opciones
  de su menú. Ese contacto se juzga por sus oportunidades del **historial completo**
  (`ctx.opportunitiesByContact`), y si nunca tuvo, a nivel contacto. **No entra a
  `contacts`**: eso movería "Leads sin oportunidad", que se mide contra la ventana. Y un
  contacto **con** oportunidad en la ventana que el filtro rechazó no se readmite por esta
  puerta — sus oportunidades ya decidieron.
- **Origen de lead es el campo personalizado crudo**, no `platformLabel()`. Se busca por
  substring (*origen* + *lead*) porque el nombre varía por sub-cuenta, con fallback al
  campo del contacto. Los valores salen sin normalizar: en Yconia conviven "Lead César" y
  "Leads César". Normalizarlos es una decisión de negocio, no de código.
- **Tipo de pauta es el de la PRIMERA pauta del contacto**, espejo deliberado de
  `buildPautaNameByContact` en `lib/pauta.ts`. Se construye sobre el historial completo,
  no sobre el filtrado por fecha.
- **Sin filtros activos, `applyDashboardFilters` devuelve los MISMOS arreglos por
  referencia**, para que los memos aguas abajo no se invaliden y el panel se comporte
  exactamente como antes de que la barra existiera.
- Las opciones de los menús se derivan de las oportunidades filtradas **solo por fecha**.
  Recalcularlas sobre el resultado ya filtrado haría que elegir "Ganado" borrara del menú
  a los demás status, sin forma de volver.
- Los filtros activos viajan al PDF como `filtersLabel` (`describeFilters`), aparte de
  `periodLabel`: un reporte recortado a un asesor que no lo declara miente, y el prompt
  de `analyze-report` lo necesita para no leer un subconjunto como si fuera el total.
- **`calls` is always empty** in live data — GHL doesn't expose a public calls endpoint in the standard API. **`tasks` is populated** via the location-wide `/locations/:id/tasks/search` endpoint (`searchLocationTasks`), fetched concurrently with the other datasets.
- **Drill-downs resolve joins against the *unfiltered* set.** Dashboards take both
  `opportunities` (date-filtered, for display) and `allOpportunities` (everything, as a
  lookup table) — likewise `allContacts` / `allPautas` / `allAppointments`. An opportunity
  can be created outside the window that puts its contact on screen, so joining against the
  filtered slice silently drops real rows. Keep that pairing when adding a drawer.

### Internal type system

`lib/types.ts` defines the canonical internal types (`Contact`, `Opportunity`, `Pauta`, `Appointment`, `Call`, `Task`, `Message`, `Pipeline`). The API route transforms raw GHL shapes into these before returning JSON. Always work against the internal types in components — never import from `lib/ghl-client.ts` on the client side.

## GHL API Gotchas

> Full schema reference: `/Users/isaiasrios/Downloads/GHL-API-Schemas.md`

- **Version header required** on all requests: `Version: 2021-07-28` (legacy) or `2023-02-21` (current).
- **customFields shape differs between read and write**:
  - Write (create/update): `{ id, key, field_value }`
  - Read (contacts): `{ id, value }`
  - Read (opportunities): `{ id, fieldValue }`
- **Tags on contacts**: sending `tags` in update/upsert **overwrites all existing tags**. Use `/contacts/:id/tags` (POST/DELETE) for incremental changes.
- **Opportunity status** valid values: `open`, `won`, `lost`, `abandoned`, `all` (`all` is search-filter only).
- **`lostReasonId`** is only relevant when status is `"lost"`.
- **`/opportunities/search`** uses snake_case params (`location_id`, `pipeline_id`, etc.) — already handled by `useSnakeCaseLocationId` flag in `ghlFetch`.
- **Conversation `type`** is numeric in some endpoints: `1=Phone`, `2=Email`, `3=FB Messenger`, `4=Review`, `5=Group SMS`.
- **Required scopes**: `contacts.readonly/write`, `opportunities.readonly/write`, `conversations.readonly/write`.

## GHL MCP Server

An HTTP MCP server (`ghl-mcp`, configured in `.mcp.json`) connects directly to GoHighLevel's hosted MCP endpoint (`https://services.leadconnectorhq.com/mcp/`). It authenticates with the same `GHL_API_TOKEN` and `GHL_LOCATION_ID` env vars used by `lib/ghl-client.ts`.

- **Purpose**: lets Claude Code query/mutate live GHL data directly during development (inspecting real contacts, opportunities, pipelines, custom fields, conversations) without writing throwaway scripts. It is **not** part of the app's runtime data flow — the app always goes through `app/api/dashboard/route.ts` → `lib/ghl-client.ts`. Never wire MCP calls into application code.
- **Use it to**: verify real data shapes, discover pipeline/custom-field IDs, confirm API behavior, and validate transforms against production data before coding them in `route.ts`.
- **Tools** (prefixed `mcp__ghl-mcp__`), grouped:
  - `contacts_*` — get-contact, get-contacts, create/update/upsert-contact, add-tags, remove-tags, get-all-tasks
  - `opportunities_*` — get-opportunity, search-opportunity, get-pipelines, update-opportunity
  - `conversations_*` — search-conversation, get-messages, send-a-new-message
  - `locations_*` — get-location, get-custom-fields
  - `calendars_*` — get-calendar-events, get-appointment-notes
  - `payments_*` — list-transactions, get-order-by-id
  - `blogs_*`, `emails_*`, `social-media-posting_*` — content/marketing operations
- **Caution**: write tools (create/update/upsert/send/post) mutate live production data. Default to read-only tools; only use write tools when explicitly asked.

### UI components

- `components/ui/` — shadcn/ui components (generated, do not hand-edit)
- `components/dashboard/` — domain components; each dashboard component receives already-filtered data as props
- `components/dashboard/date-range-filter.tsx` is the only global filter UI; the `DateFilter` type lives in `lib/date-range.ts`
- Charts use Recharts via the shadcn chart wrapper (`components/ui/chart.tsx`)
- `components.json` controls shadcn/ui config (alias `@/components/ui`, Tailwind CSS v3)
- Shared chart chrome lives in `dashboard-ui.tsx`: `ChartCardHeader`, `ScopePill` (scope
  label + tooltip explaining a chart's rule), and `CardTone` (won/lost card tints — the
  light/dark pairs are tuned by eye, not numerically matched; don't "normalize" them)

**Chart conventions** — apply to every new chart:
- Use `NonZeroTooltipContent` so empty series don't render noise, and wire a drill-down
  drawer (`chart-drill-drawer.tsx`) — every chart should be clickable through to its records
- No visual encoding that requires a legend to decode
- Never nest a scroll container inside a card. For narrow scrollable panels use a plain
  `overflow-y-auto` div — Radix `ScrollArea` breaks `truncate`
