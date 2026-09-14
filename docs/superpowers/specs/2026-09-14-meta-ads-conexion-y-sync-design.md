# Meta Ads ①: conexión única, cuentas por proyecto, dataset en el sync y cruce por ad id

Fecha: 2026-09-14
Estado: diseño aprobado para implementar
Origen: **port de la entrega ① de DRT**
(`DASHBOARDS_GRUPO_DRT/docs/superpowers/specs/2026-09-13-meta-ads-conexion-y-sync-design.md`,
fusionada en `bb92c40`). Ese documento guarda las razones que aquí **no cambian** —
por qué Meta es un paso del sync y no una ruta aparte, por qué la conexión es un
botón y no un token en env, por qué el cruce va por ad id y no por nombre, por qué
cada sync re-trae la ventana completa, cifrado, `state`, nonce, códigos de error de
Graph. Este spec no las repite: dice **qué se copia literal, qué se adapta y por
qué**, y define lo nuevo. Cuando algo no esté aquí, la referencia es DRT.

Entrega siguiente (spec propio): ② la fila de KPIs y la tabla "Gasto y costo por
campaña" en Marketing, con drill-down y PDF. Esta entrega **no dibuja gráficas**:
deja el dataset en el payload, el cruce puro y la píldora de conexión.

---

## Lo que difiere de DRT, y decide el diseño

| | DRT | LEZGO |
|---|---|---|
| Despliegue | Un cliente = una empresa de Meta | **Interno**: seis proyectos de terceros, tres alcances (`all`, `domus`, `iw`) |
| Conexión con Meta | Una por cliente, fila `(client_id, product)` | **Una por despliegue**: un admin conecta una vez con la empresa de Lezgo |
| Cuenta publicitaria | `selected_accounts` en la misma fila | **Por proyecto**, tabla aparte; una cuenta puede servir a dos proyectos |
| Quién administra | Quien tenga la contraseña | **Solo el alcance `all`**; `domus` e `iw` ven el gasto, no tocan la conexión |
| Avisos de sync | `warnings[]` + banner ámbar | No existen. **`metaAdsStatus` en el payload**, lo lee la píldora |
| Cruce | Desarrollos, etapas `05. Visita`, `byName` vía objeto Pauta | **Sin desarrollos ni etapas** (cada sub-cuenta nombra las suyas); sin `byName` |

### Reconocimiento de datos (medido contra el caché de los seis proyectos, 2026-09-14)

| Proyecto | Opps | con `adId` | con `campaignName` |
|---|---|---|---|
| lezgo-suite | 401 | 249 (62 %) | 0 |
| condesa | 2 803 | 1 767 (63 %) | 1 674 |
| plaza-bosques | 2 695 | 1 550 (58 %) | 494 |
| grand-center | 466 | 252 (54 %) | 198 |
| balvanera | 345 | 139 (40 %) | 38 |
| yconia | 7 077 | 2 711 (38 %) | 493 |

- `adId` es el id real del anuncio de Meta (`1202519…`), llave exacta como en DRT.
- `campaignName` (utm_campaign) cubre **menos** que `adId` en los seis. Un fallback por
  nombre no aportaría cobertura y sí ambigüedad: se omite.
- El objeto Pauta de LEZGO trae `nombre_del_contacto, registro, telfono_del_contacto`
  (+ `reingreso`, `plaza_…`): **no trae nombre de anuncio**, así que el nivel `byName`
  de DRT no tiene de dónde salir.
- Plaza Bosques y Meseta comparten ad ids con sufijo `…0437`: **una cuenta publicitaria
  puede alimentar a más de un proyecto**. El modelo debe permitirlo.
- Existe el modo `groupBy: "id"` en `marketing-dashboard.tsx` con columna "ID de
  Pauta": el custom field con ese nombre existe al menos en un proyecto. `oppAdId()`
  conserva el fallback al custom field `/^id\s*(de\s*)?pauta$/i` de DRT.

---

## Qué se copia literal

Puros, sin ninguna importación de DRT. Se copian con `git show bb92c40:<ruta>` o
desde el working tree de DRT, y el diff contra el original debe ser vacío salvo por
lo que aquí se marca:

| Archivo | Nota |
|---|---|
| `lib/meta-oauth.ts` | Literal. `MetaState.clientId` se **renombra a `scopeId`** (ver "OAuth"). Importa `safeEqual` de `lib/auth`, que existe. |
| `lib/meta-normalize.ts` | Literal. |
| `lib/meta-client.ts` | Literal. Importa `MetaAccountInfo` del store: ese tipo se conserva con el mismo nombre. |
| `MetaAdsData`, `MetaDailyRow`, `MetaAccount`, `MetaCampaign`, `MetaAdset`, `MetaAd` en `lib/types.ts` | Literal. |
| `scripts/verify-meta-oauth.ts` | Literal salvo `clientId` → `scopeId`. |
| `scripts/verify-meta.ts` | Literal. |

---

## Modelo de datos

Dos tablas nuevas en `scripts/db-migrate.ts` (idempotente, conexión unpooled, como
`project_sync`):

```sql
CREATE TABLE IF NOT EXISTS meta_connection (
  product             text        PRIMARY KEY,  -- 'ads' | 'whatsapp'
  token_encrypted     bytea       NOT NULL,
  token_kind          text        NOT NULL,     -- 'system_user' | 'user'
  token_expires_at    timestamptz,              -- NULL para system_user
  business_id         text,
  connected_by        text,                     -- nombre Meta de quien conectó
  available_accounts  jsonb       NOT NULL,     -- [{id,name,currency,timezone,status}]
  connected_at        timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS meta_project_accounts (
  project_id   text        NOT NULL,
  product      text        NOT NULL,
  account_ids  jsonb       NOT NULL,            -- ['act_…', …]; vacío = sin Meta
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (project_id, product)
);
```

- `meta_connection` **no tiene `client_id`**: es del despliegue. La PK es `product`,
  así que WhatsApp entra después como otra fila.
- `meta_project_accounts` reemplaza al `selected_accounts` de DRT. No tiene FK a
  `meta_connection`: si se desconecta y reconecta con la misma empresa, las
  asignaciones sobreviven; si la empresa nueva no ve una cuenta asignada, el sync la
  reporta como fallida (ver "Sync") y la píldora lo dice. Es mejor que borrar
  asignaciones en silencio.
- **Ninguna de las dos es desechable.** Misma advertencia que DRT, ahora por partida
  doble: la fila de conexión hay que reconectarla y las asignaciones hay que
  volver a elegirlas. El DELETE de la conexión **no** borra `meta_project_accounts`.

### `lib/meta-connection-store.ts` — adaptado

Conserva los tipos `MetaAccountInfo`, `MetaConnection`, `MetaConnectionWithToken`
de DRT, menos `selectedAccounts`. Funciones:

- `readMetaConnection(product)` / `readMetaConnectionWithToken(product)` /
  `writeMetaConnection(product, input)` / `deleteMetaConnection(product)` — sin
  `ClientConfig`: la conexión no es de un proyecto. La separación
  `readMetaConnection` (nunca el token) vs `…WithToken` (solo el sync) se conserva
  tal cual, y la regla "blob que no descifra → `token: null`, no `null` de fila".
- `readProjectAccounts(client, product): Promise<string[]>` /
  `writeProjectAccounts(client, product, ids): Promise<boolean>` — **reciben
  `ClientConfig`**, nunca un string, por la misma razón que `sync-store`: leer la
  fila equivocada pintaría el gasto de A en el panel de B. `write` valida `ids ⊆
  available_accounts` de la conexión viva y devuelve `false` si no; una lista
  vacía **sí es válida** (= quitarle Meta al proyecto).
- Sin `DATABASE_URL`: lecturas `null`/`[]`, escrituras no-op con log.

`scripts/verify-meta-connection-store.ts` se adapta: aserciones puras siempre; con
`DATABASE_URL`, roundtrip de las dos tablas con ids sintéticos `__verify_*` (ID_RE
prohíbe guiones bajos, así que no chocan con el roster) y **aislamiento**: escribir
las cuentas de `__verify_a` no toca las de `__verify_b`; asignar un `act_` que no
está en `available_accounts` devuelve `false`.

---

## OAuth y rutas — `app/api/meta/*`

El flujo es el de DRT (`/connect` → diálogo → `/callback` → `/?meta=…`) con estos
cambios:

- **Compuerta: alcance `all`.** `connect`, `callback`, `DELETE /connection` y
  `POST /accounts` empiezan con `currentScope()` y exigen `scope.id === "all"`; lo
  demás es 403 `{ error: "forbidden" }`. `GET /connection` la lee cualquier sesión
  válida (la píldora se dibuja para todos) y devuelve `canManage`. `POST /accounts`
  además llama `requireClient()` porque asigna cuentas **al proyecto de la sesión**.
- **`state` lleva `scopeId`**, no `clientId`. El callback exige `state.scopeId ===
  "all"` y que coincida con el alcance de la sesión — el mismo papel que jugaba
  `clientId` en DRT: que un `state` bien firmado pero ajeno no guarde nada. La
  cookie de nonce `meta_oauth` (Path `/api/meta/callback`, un solo uso) se conserva
  íntegra.
- **Vuelta a `/`**: en LEZGO `/` rinde el picker si no hay `dash_project`. El admin
  conecta desde un proyecto abierto, así que la cookie está y vuelve al panel. Si
  por lo que sea no está, cae al picker con `?meta=connected` en la URL; la píldora
  no se monta ahí y el parámetro se ignora. No se agrega `returnTo` con rutas.
- Previews de Vercel: 409 `preview`, como DRT. `META_PUBLIC_ORIGIN =
  https://dashboards.lezgosuite.com` fija el `redirect_uri` en producción. **Ya
  cargadas en Vercel** las cuatro variables (2026-09-14); falta registrar
  `https://dashboards.lezgosuite.com/api/meta/callback` en la app de Meta (hecho).

| Ruta | Compuerta | Hace |
|---|---|---|
| `GET /connect` | `all` | `state{scopeId,product,nonce}` + cookie nonce → redirige al diálogo |
| `GET /callback` | `all` | verifica state+nonce, `code` → token, `debugToken`, `/me`, `/me/adaccounts`, `writeMetaConnection`, redirige `/?meta=connected` o `?meta=error&reason=…` |
| `GET /connection` | sesión válida + `requireClient()` | `{ connected, canManage, connectedBy, connectedAt, tokenKind, tokenExpiresAt, accounts: available[] con `selected` según **este** proyecto }` — nunca el token |
| `POST /accounts` | `all` + `requireClient()` | `{ ids }` → `writeProjectAccounts(client, "ads", ids)`; 400 si `false` |
| `DELETE /connection` | `all` | `deleteMetaConnection("ads")`; no toca asignaciones ni revoca en Meta |

Ninguna toca GHL: no pasan por `withClient()`.

---

## Sync

`lib/sync.ts` gana el paso `meta` de DRT, después del transform de `opportunities`
(la ventana de historia sale de la opp más antigua con ad id, tope 24 meses), con
esta lectura en vez de la de DRT:

```
conn     = readMetaConnectionWithToken("ads")
accounts = readProjectAccounts(client, "ads")
```

| Situación | Paso `meta` | `metaAds` | `metaAdsStatus` |
|---|---|---|---|
| Sin `DATABASE_URL`, sin fila de conexión, **o `accounts` vacío** | no se emite | `null` | `{ state: "none" }` |
| Fila existe pero el blob no descifra | `error` | `null` → rescate | `{ state: "error", reason: "token_unreadable" }` |
| Todo bien | `done`, `count = ads` | dataset | `{ state: "ok" }` |
| Alguna cuenta asignada falla (sin permiso, no existe ya) | `partial` | dataset sin ella | `{ state: "partial", failedAccounts: [{id, reason}] }` |
| Token revocado (`190`) | `error` | `null` → rescate | `{ state: "error", reason: "token_revoked" }` |
| Meta caído / otro error | `error` | `null` → rescate | `{ state: "error", reason: "failed" }` |

- "Sin cuentas asignadas" es el caso normal de un proyecto sin Meta y **no es un
  error**: la píldora ofrece "Asignar cuenta" al alcance `all` y nada a los demás.
- **Rescate del último bueno**: `preserveMetaAds()` de DRT se porta a
  `app/api/dashboard/route.ts` cambiando la condición de `warnings` a
  `metaAdsStatus.state === "error"`. Aplica en el camino frío y en
  `refreshInBackground`. Conserva también el `metaAdsStatus` nuevo: el gasto que se
  ve es de hace un rato **y** la píldora dice que no se actualizó.
- El token se descifra dentro de `syncProject` y no sale a ningún frame ni log.
- `StepKey` gana `"meta"`; `INITIAL_STEPS` e `IDLE_STEPS` lo incluyen como
  `pending`. La pantalla de carga de LEZGO no lista filas — solo cuenta pasos para
  el riel — así que un paso que **no se emite** debe **no contar**: el riel se
  dimensiona con los pasos que hayan salido de `pending` más los que ya llegaron,
  no con el total de llaves. Detalle del plan; el criterio es que un proyecto sin
  Meta no vea un riel que nunca llega al 100 %.

`DashboardPayload`:

```ts
metaAds?: MetaAdsData | null
metaAdsStatus?: MetaAdsStatus   // { state: "none" | "ok" | "partial" | "error"; reason?: …; failedAccounts?: … }
```

Ambos opcionales para que un frame `data` de un deploy anterior siga parseando. El
campo existente `meta: { totalContacts, … }` **no se toca**; de ahí el nombre
`metaAds`, no `meta`.

---

## El cruce — `lib/meta-attribution.ts` (puro, reescrito delgado)

Sin `panel-scope`, `desarrollo-funnel` ni `task-backlog`. Exporta:

- `oppAdId(opp)` — de DRT tal cual: `opp.adId` normalizado (solo dígitos), fallback
  al custom field `/^id\s*(de\s*)?pauta$/i`.
- `buildMetaIndex(metaAds)` — `byAd: adId → { ad, adset, campaign, account }` y
  `dailyByAd`. Sin `byName`. Memoizado en el panel por referencia de `metaAds`.
- `classifyLead(opp, ctx)` → `"exact" | "unknownAd" | "noAdId" | "notPauta"`.
  `notPauta` = `!isDePauta(opp, pautaContacts)` **o** `attributions[].medium ===
  "csv_import"` (gana incluso con ad id, como en DRT). `unknownAd` = tiene ad id y
  no está en el índice: cuenta de otra empresa, no asignada, o ad borrado — la
  señal para "Asignar cuenta". Solo `exact` entra al costo.
- `localDay(iso, tz = "America/Mexico_City")` — para comparar `createdAt` con
  `daily.date`. LEZGO ya sella fechas en hora local (`drill-export`); el cruce usa
  la misma convención.
- `buildCostSummary({ opportunities, daily, index, range, pautaContacts })` para la
  ventana del filtro global:
  - `spend` = Σ `daily.spend` en la ventana; `leadsMeta` = Σ `leadsForm + leadsMsg`.
  - `leadsCrm` = opps **creadas** en la ventana (día local) con `classifyLead ===
    "exact"`; `won` = las de esas con `isWonOpp()` (`lib/opportunity-status.ts`,
    no el campo crudo: varias sub-cuentas registran la venta por etapa).
  - `cpl = spend / leadsCrm`, `cpa = spend / won`; **`null` sin denominador**, nunca
    `$0` ni `∞`.
  - `unknownAdLeads`, `noAdIdLeads` — conteos aparte; son hallazgos, no residuo.
  - `mixedCurrency: true` si las cuentas de los ads involucrados difieren en
    `currency`; entonces `spend` va por moneda y `cpl`/`cpa` son `null`.
- `buildCampaignPerformance(...)` → filas por campaña de Meta: gasto · impresiones
  · clics · CPM · CTR · leads Meta · leads CRM · ganadas · CPL · CPA. Es lo que ②
  monta; se construye aquí para que ② no lo duplique.

**Lo que no hace**: no reparte gasto, no convierte moneda, no atribuye por nombre,
no toca `lib/pauta.ts`. `isDePauta` sigue siendo "es de pauta"; esto es "cuánto
costó".

`scripts/verify-meta-attribution.ts`: `oppAdId` (nativo, custom field, ambos
distintos → nativo, espacios, vacío), `classifyLead` los cuatro niveles y
`csv_import` ganando al ad id, cohorte por día local contra `date` (el caso de las
23:36 de `verify:drill-export`), `null` en vez de división por cero, `unknownAd`,
moneda mixta, `isWonOpp` por etapa.

---

## La píldora — `components/dashboard/meta-connection.tsx`

En el header de `dashboard-app.tsx`, junto a "Actualizar", visible en las tres
pestañas. Lee `GET /api/meta/connection` al montar y al volver con `?meta=…`, y
`data.metaAdsStatus` del payload para el estado del último sync. `DashboardApp` no
recibe props (`app/page.tsx` lo monta pelado), así que **`canManage` viene en la
respuesta de `/connection`**, no por props.

| Estado | Todos ven | Solo `all` puede |
|---|---|---|
| Sin conexión | nada (píldora oculta) | botón **Conectar con Meta** → `/api/meta/connect`; deshabilitado con motivo si `preview` / `not_configured` / `no_db` |
| Conectada, proyecto sin cuenta | píldora gris "Meta · sin cuenta" | **Asignar cuenta** → diálogo con checkboxes sobre `available`, guarda con `POST /accounts`, dispara `refresh()` |
| Conectada, con cuenta(s) | píldora "Meta · N cuentas" | menú: **Cambiar cuentas** · **Reconectar** · **Desconectar** (confirmación; explica que no revoca en Meta ni borra asignaciones) |
| `metaAdsStatus.partial` | ámbar "Meta · cuenta X no respondió" | ídem |
| `metaAdsStatus.error` `token_revoked` / `token_unreadable` | rojo "Meta desconectado" | **Reconectar** como acción primaria |
| `?meta=connected` | toast "Meta conectado · N cuentas disponibles" + `refresh()` | |
| `?meta=error&reason=…` | toast con el motivo | |

Los `domus`/`iw` ven la píldora solo como estado: sin menú, sin botón. Amber solo
en `partial`, hover y focus (DESIGN.md: ámbar marca dónde va la atención).

---

## Acceso de la app (verificado con el MCP de Meta Developers, 2026-09-14)

App `1432292882099074` "Paneles Lezgo Suite", live, dominio base `lezgosuite.com`,
redirect `https://dashboards.lezgosuite.com/api/meta/callback` registrado. Config de
Login for Business `1047096268324910`: variación General, token de **usuario del
sistema**, portafolio de negocio de Lezgo conectado.

- **La app no ha pasado App Review** (`UNSUBMITTED`): `ads_read`,
  `business_management` y *Marketing API Access Tier* están en acceso **Standard**.
  Standard = las permisiones solo se conceden a usuarios **con rol en la app o en el
  portafolio que la reclamó**. Quien conecta en LEZGO es admin de la app, así que el
  modelo de conexión única **funciona sin review** — y es la razón por la que un
  "Conectar" por proyecto, con el admin del BM de una agencia, no funcionaría hoy.
  DRT, por lo mismo, nunca completó una conexión (`meta_connection` vacía): **el
  flujo OAuth de esta app está sin probar de punta a punta; LEZGO será el primero.**
- **Marketing API Access Tier en "Limited"** (default): rate limit agresivo por
  cuenta publicitaria. Sube a **Full** solo al acumular 500 llamadas exitosas en 15
  días con <15 % de error; el sync lo alcanza en pocos días. Mientras tanto el
  throttling (`17`, `613`, `80004`) se ve como paso `meta` lento o `partial` con
  reintentos, **no** como panel roto. El plan no debe "arreglar" eso la primera
  semana. `verify:meta` ya fija los reintentos.

---

## Variables de entorno

Las de DRT, ya cargadas en Vercel (producción, preview, development) y en
`.env.local`:

```
META_APP_ID            # 1432292882099074 — app publicada "Paneles Lezgo Suite"
META_APP_SECRET
META_LOGIN_CONFIG_ID   # 1047096268324910 — ads_read + business_management
META_PUBLIC_ORIGIN     # https://dashboards.lezgosuite.com — solo producción
```

Son de Lezgo: **no** van en `DASHBOARD_CLIENTS`. Sin las tres primeras la píldora
dice "Meta no configurado" y el sync se comporta como sin conexión. Localhost no
completa el OAuth (la app publicada rechaza `http://localhost`): se conecta desde
producción y el dev local lee la misma fila de Neon.

---

## Errores y estados

Regla general de DRT, vigente: **meter Meta no puede crear una forma nueva de que
el panel no cargue.** Todo fallo de Meta o de las tablas nuevas se registra y el
sync de GHL sigue. Probar apuntando `DATABASE_URL` a un host inválido: el panel
carga, sin Meta, sin píldora.

Riesgo asumido con el modelo de conexión única: si una cuenta publicitaria vive en
un Business Manager que la empresa conectada no ve, ese proyecto queda `partial`
con esa cuenta nombrada hasta que se comparta en el BM. Reconectar con **otra**
empresa sobrescribe la conexión de todos los proyectos — el diálogo de Reconectar
lo advierte.

---

## Verificación

- `pnpm verify:meta-oauth`, `verify:meta`, `verify:meta-connection-store`,
  `verify:meta-attribution` (los cuatro registrados en `package.json` y CLAUDE.md).
- `pnpm verify:sync-store`, `verify:scopes`, `verify:auth` siguen verdes.
- `npx tsc --noEmit` en cero al final de cada tarea.
- Contra realidad: `pnpm db:migrate`; deploy; conectar desde producción con el
  alcance `all`; asignar `act_` a Condesa; `?fresh=1`; **cuadrar el gasto de un mes
  de una campaña de Condesa con el Administrador de anuncios** antes de confiar en
  cualquier costo. Abrir Condesa con la contraseña de `iw`: la píldora se ve, sin
  menú; `POST /api/meta/accounts` responde 403.

---

## Fuera de alcance

- Gráficas, KPIs, PDF y asistente (entrega ②).
- Conectar desde previews o localhost.
- Conversión de moneda; reparto de gasto.
- Revocar en Meta desde el panel; escribir nada en Meta.
- WhatsApp (misma app, `product = "whatsapp"`, spec propio).
