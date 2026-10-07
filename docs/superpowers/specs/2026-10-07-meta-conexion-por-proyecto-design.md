# Meta Ads: una conexión por proyecto

Fecha: 2026-10-07. Reemplaza la sección "Una conexión por despliegue, cuentas por proyecto"
del spec ① (`2026-09-14-meta-ads-conexion-y-sync-design.md`). Todo lo demás de ① y ②
(dataset en el sync, cruce por ad id, inversión, asistente) no cambia.

## Por qué

Con una sola conexión (el usuario del sistema del portafolio de Lezgo), cada cuenta
publicitaria de un cliente había que compartirla al portafolio de Lezgo como socio,
asignarla al usuario del sistema en Business Manager y luego reconectar. Ese trámite por
cliente es lo que se elimina: cada proyecto se conecta con el Facebook de quien ya
tiene acceso a la cuenta de ese cliente.

## Quién conecta (decisión)

**Una persona de Lezgo** que ya entra a la cuenta publicitaria del cliente con su propio
Facebook, desde una sesión del alcance `all`. **No el cliente ni su agencia.**

Motivo, verificado el 2026-10-07 con el MCP de Meta sobre la app `1432292882099074`:
`ads_read`, `ads_management` y `business_management` están en acceso **Standard** (el
envío a App Review existe pero está `UNSUBMITTED`). Con acceso Standard, Meta solo
entrega datos a usuarios **con rol en la app**. Por eso, quien conecta debe ser
admin, developer o tester de la app; a una persona nueva de Lezgo se le agrega el rol
una sola vez. Para que un cliente conecte con su propio Facebook hace falta Advanced
Access vía App Review, y eso queda fuera de este spec. El código no cambiaría para esa
fase.

## Modelo de datos

Tabla nueva, **no desechable** (igual que `meta_connection`):

```sql
CREATE TABLE IF NOT EXISTS meta_project_connection (
  project_id          text        NOT NULL,
  product             text        NOT NULL,
  token_encrypted     bytea       NOT NULL,
  token_kind          text        NOT NULL,   -- 'system_user' | 'user'
  token_expires_at    timestamptz,
  connected_by        text,
  available_accounts  jsonb       NOT NULL,   -- lo que ese token ve
  account_ids         jsonb       NOT NULL DEFAULT '[]'::jsonb, -- lo que el proyecto mira
  connected_at        timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  PRIMARY KEY (project_id, product)
)
```

- La conexión y la selección de cuentas van en **una fila**: ahora siempre pertenecen al
  mismo proyecto, y validar `account_ids ⊆ available_accounts` contra la propia fila
  es más simple que cruzar dos tablas.
- `business_id` se elimina porque nunca se llenó.
- **Migración sin pérdida** (`pnpm db:migrate`, idempotente): si existe la fila de
  `meta_connection` para `ads`, por cada fila de `meta_project_accounts` con `account_ids`
  no vacío se inserta en `meta_project_connection` una copia del token y las cuentas
  disponibles junto con las `account_ids` del proyecto (`ON CONFLICT DO NOTHING`, nunca
  pisa una conexión por proyecto ya hecha). Hoy eso es Lezgo Suite, que sigue
  funcionando sin reconectar.
- `meta_connection` y `meta_project_accounts` **no se borran**. Ningún código las lee
  después del cambio, y quedan como respaldo hasta que alguien decida tirarlas a mano.

## Store (`lib/meta-connection-store.ts`)

Todas las funciones reciben el `ClientConfig`, nunca un id suelto (misma regla que hoy):

- `readMetaConnection(client, product)`: estado sin token, incluye `accountIds`.
- `readMetaConnectionWithToken(client, product)`: solo el sync la usa. `token: null`
  si el blob no descifra.
- `writeMetaConnection(client, product, input)`: upsert. En una reconexión **conserva
  `account_ids`**. Si una cuenta ya no está disponible, el sync la marca `not_available`,
  como hoy. En una conexión nueva, si el token ve **exactamente una** cuenta, queda
  seleccionada sola. Con más de una, `account_ids = []` y la persona elige.
- `writeProjectAccounts(client, product, ids)`: `false` si no hay conexión de ese
  proyecto o si algún id no está en su `available_accounts`. Vacío es válido.
- `deleteMetaConnection(client, product)`: borra la fila de ese proyecto y nada más.
  Como la selección vive en la misma fila, también se pierde. Es aceptable porque
  reconectar con una sola cuenta la vuelve a seleccionar sola, y con varias se eligen
  de nuevo. La UI ya pide confirmación.

Sin `DATABASE_URL` se comporta como hoy: lecturas `null`, escrituras no-op registradas.

## Flujo OAuth

- `MetaState` gana `projectId`. `/api/meta/connect` exige `requireMetaAdmin()` **y**
  `requireClient()`, y firma `{ scopeId, projectId, product: "ads", returnTo: "/" }`.
- `/api/meta/callback` exige además `state.projectId === client.id` (el proyecto de
  `dash_project` en ese momento). Un OAuth iniciado en Condesa, con la persona cambiando
  a Yconia en otra pestaña antes de volver, falla con `state_invalid` y no guarda nada.
  `verifyState` rechaza un state sin `projectId`.
- Se guarda con `writeMetaConnection(client, "ads", …)`. Las demás razones de error
  (`denied`, `token_exchange`, `token_invalid`, `no_accounts`, `db`) quedan igual.
- `GET /api/meta/connection`: lee la fila del proyecto de la sesión. `DELETE`: borra
  solo esa. `POST /api/meta/accounts`: igual que hoy, contra la fila del proyecto.
- Administrar sigue siendo solo del alcance `all` (`lib/meta-admin.ts`). `domus`/`iw` ven
  el estado sin menú. Se actualiza el comentario del archivo: la razón ya no es
  "reconectar la sobrescribe para todos", sino que conectar ata el Facebook de una
  persona de Lezgo al proyecto.

## UI (`components/dashboard/meta-connection.tsx`)

Misma píldora, con textos por proyecto: "Conectar con Meta" conecta **este** proyecto,
la confirmación de desconectar dice que afecta solo a este proyecto y muestra
`connectedBy` ("Conectado por X"). Se quita cualquier texto que hable de compartir
cuentas al portafolio.

## Sync (`lib/sync.ts`)

Una sola lectura: `readMetaConnectionWithToken(client, "ads")` trae token, cuentas
disponibles y `accountIds`. El resto del paso `meta` no cambia: sin fila o sin cuentas
el paso no se emite y queda `{ state: "none" }`, `token_unreadable`, `token_revoked`,
`not_available`, `preserveMetaAds`, y la base no es una dependencia.

## Riesgo a probar en producción: el tipo de token

La config de Login for Business actual (`META_LOGIN_CONFIG_ID` = `1047096268324910`)
emite tokens de **usuario del sistema**. Si en el diálogo la persona de Lezgo elige el
portafolio del cliente, Meta crea el usuario del sistema en ese portafolio. No está
verificado que Meta lo permita con acceso Standard cuando el portafolio del cliente no
tiene relación con la app.

- **Prueba:** conectar un segundo proyecto (p. ej. Condesa) en producción.
- **Si regresa sin cuentas o con error:** plan B. Se crea en el panel de la app una
  segunda config de Login for Business con **token de usuario** (`ads_read`) y se cambia
  `META_LOGIN_CONFIG_ID` en Vercel. El token ve todo lo que esa persona ve con su
  Facebook y vive unos 60 días. El código ya guarda `token_kind` y `token_expires_at`.
  Este spec agrega a la píldora el aviso "Caduca en N días · Reconectar" cuando falten
  14 días o menos, y el estado de error ya existente cuando caduque (error 190).
- Plan B no requiere cambios de código más allá de ese aviso, que se implementa
  desde el principio.

## Verificación

- `pnpm verify:meta-connection-store` reescrito (ids sintéticos `__verify_*`):
  aislamiento entre proyectos (A conecta y B lee `null`; borrar A no toca B), validación
  de cuentas contra la fila del propio proyecto, reconexión conserva `account_ids`,
  autoselección con una sola cuenta, roundtrip de cifrado y secreto rotado → `token: null`.
- `pnpm verify:meta-oauth`: `projectId` viaja firmado y un state sin él se rechaza.
- La copia de la migración vive en el store como `backfillProjectConnections(product)`
  (la llama `db:migrate` con `"ads"`), y el verify la prueba con un producto sintético.
  Copia solo a proyectos con asignación no vacía y no pisa una fila existente.
- `npx tsc --noEmit`.
- Prueba real: Lezgo Suite sigue mostrando su gasto después de migrar sin reconectar, y
  conectar Condesa desde producción (esto resuelve el riesgo de arriba).
- CLAUDE.md: se reescribe la viñeta "Una conexión por despliegue" y se quita la
  instrucción de compartir cuentas al portafolio de Lezgo.

## Fuera de alcance

- Que clientes o agencias conecten con su Facebook (App Review / Advanced Access).
- Reutilizar la conexión de una persona en varios proyectos sin repetir el OAuth.
- Borrar `meta_connection` / `meta_project_accounts`.
