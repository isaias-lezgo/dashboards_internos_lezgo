# Caché de sincronización en Postgres

**Fecha:** 2026-08-11
**Estado:** aprobado, pendiente de implementar

## Problema

Abrir un proyecto cuesta entre 9 y 37 segundos, medido contra los seis proyectos el
2026-08-11:

| Proyecto | Sync | Payload | Contactos | Oportunidades |
|---|---:|---:|---:|---:|
| Yconia | 33.9s | 27.6 MB | 7,522 | 6,840 |
| Condesa Cimatario | 36.6s | 12.8 MB | 2,476 | 2,489 |
| Lezgo Suite | 33.4s | 7.6 MB | 4,959 | 359 |
| Grand Center | 22.5s | 1.5 MB | 330 | 330 |
| Plaza Bosques / Meseta | 14.2s | 10.8 MB | 2,485 | 2,514 |
| Balvanera | 8.6s | 0.6 MB | 168 | 160 |

Ese costo se paga en cada apertura, cada refresh y cada cambio de proyecto, por cada
persona del equipo. El tiempo se va casi todo en GHL: paginación más el limitador de
concurrencia y rate por location (`lib/ghl-limiter.ts`).

**Objetivo:** que abrir un proyecto no espere nunca a la API de GHL.

### Qué mejora y qué no

El caché elimina la parte de GHL, no el tamaño del dato. Los 27.6 MB de Yconia siguen
viajando al navegador y hay que parsearlos ahí, porque las gráficas y el asistente
operan sobre el dataset completo en el cliente. Sumando para el peor caso:

| Etapa | Hoy | Con caché |
|---|---:|---:|
| Traer de GHL | 34-60s | — |
| Leer de la base | — | ~0.3-0.5s |
| Mandar al navegador (2.49 MB gzip en el cable) | incluido arriba | ~0.5s |
| `JSON.parse` + construir índices | ~0.5s | ~0.5s |
| **Total** | **34-60s** | **~1.5-2s** |

De decenas de segundos a ~2. Bajar de ahí es otro proyecto: exige cambiar qué recibe
el navegador, no dónde se guarda.

### Medido contra la base real (2026-08-11)

Probado con el payload real de Yconia contra la instancia de Neon ya creada
(PostgreSQL 17.10, `us-east-1`):

| Medición | Resultado |
|---|---|
| Compresión del payload | 27.7 MB → **2.49 MB** (11.1x), 203 ms |
| Escritura a Neon | 1,448 ms |
| Lectura de Neon | 1,294-1,568 ms **desde Querétaro** |
| Descompresión | 25-41 ms |
| En disco, esa fila | 2,720 kB → los seis proyectos ≈ **16 MB** de 0.5 GB del tier gratuito |
| Integridad del roundtrip | bytes idénticos, acentos y emojis incluidos |
| Arranque en frío (escala a cero) | 430 ms |

La lectura de ~1.5s se midió desde una laptop en México contra `us-east-1`; una
función de Vercel en la misma región debería bajarla a unas décimas. **Hay que medirla
de nuevo ya desplegada en vez de asumirlo** — si resultara ser el costo dominante, la
salida es mover el payload a almacenamiento de objetos dejando Postgres para el
historial futuro.

**La región importa:** la base quedó en `us-east-1`, así que las funciones de Vercel
tienen que estar en `iad1`. Si quedan en continentes distintos, cada lectura paga el
viaje y se come buena parte de lo ganado.

## No-objetivos

Explícitamente fuera de alcance, por decisión del usuario:

- **Historia.** Nada de bitácora de cambios de etapa ni fotos diarias. Se evaluó y se
  pospuso. La tabla de este diseño se **sobrescribe**: solo existe el presente.
- **Reducir los 27 MB que recibe el navegador.** El caché ataca la parte de GHL. Las
  gráficas y el asistente siguen operando sobre el dataset completo en el cliente, así
  que el payload no cambia de tamaño. Es una mejora aparte.
- **`/api/dashboard-messages`.** Los mensajes de conversaciones se cargan por su propia
  ruta y su propio stream. Se pueden cachear igual más adelante, con el mismo patrón.

## Modelo

Una sola tabla. El caché es **desechable**: si se borra, se vuelve a llenar desde GHL y
no se pierde nada. Esa propiedad es lo que mantiene el diseño chico.

```sql
CREATE TABLE IF NOT EXISTS project_sync (
  project_id      text PRIMARY KEY,
  payload         bytea       NOT NULL,  -- JSON del dashboard, gzip
  synced_at       timestamptz NOT NULL,
  sync_started_at timestamptz,           -- el candado; NULL = nadie sincronizando
  last_error      text
);
```

**`bytea` con gzip, no `jsonb`.** Nunca consultamos dentro del payload —se manda
íntegro al navegador—, así que `jsonb` solo costaría parseo al escribir y al leer. Los
27.6 MB de Yconia comprimen a ~2-3 MB. Los seis proyectos caben en menos de 20 MB, muy
por debajo del tier gratuito de Neon (0.5 GB).

### Por qué Postgres y no almacenamiento de objetos

Para esta forma exacta de dato —un blob por proyecto, leído entero, jamás consultado
por dentro— Vercel Blob encaja mejor: sin cold start, sin base64, más barato. Se eligió
Postgres igual, **por valor de opción**: el historial está pospuesto, no descartado, y
cuando vuelva Postgres es su casa y Blob no sirve. Montar dos almacenes después es peor
que aceptar hoy la fricción de uno.

Esa fricción, para que no sorprenda:

- **Escala a cero.** En el tier gratuito Neon apaga el cómputo tras ~5 min sin uso y
  despertar cuesta ~0.5s. La primera carga de la mañana lo paga. Se desactiva en plan
  pago.
- **El driver HTTP devuelve `bytea` en base64**, lo que infla el blob ~33% en tránsito
  y obliga a decodificar. Sobre 2.5 MB no es dramático, pero es real y hay que medirlo
  al implementar, no asumirlo.

`lib/db.ts` es la costura precisamente para que esta decisión sea reversible tocando un
archivo.

**El candado.** Dos personas abriendo Yconia al mismo tiempo no deben disparar dos
sincronizaciones. La reclamación es un UPDATE condicional, atómico:

```sql
UPDATE project_sync
   SET sync_started_at = now()
 WHERE project_id = $1
   AND (sync_started_at IS NULL OR sync_started_at < now() - interval '10 minutes')
RETURNING project_id;
```

Si no devuelve fila, alguien más ya está sincronizando y esta petición no hace nada. El
`< now() - interval '10 minutes'` es lo que hace al candado **auto-sanable**: una
función que muere a mitad del sync no deja el proyecto congelado para siempre.

## Flujo

```
GET /api/dashboard
    ↓  requireClient()            → proyecto + alcance (sin cambios)
    ↓  readSync(client)           → fila de project_sync
    │
    ├─ hay fila  → manda el payload YA + { syncedAt }
    │              y si tiene más de 15 min: after(() => refrescar)
    │
    └─ no hay    → sincroniza en vivo con la pantalla de carga de siempre,
       (frío)      y escribe el resultado. Pasa una vez por proyecto.
```

- **Nadie espera a GHL** salvo en el caché frío: proyecto recién agregado al roster o
  base vacía.
- El refresco corre en `after()` (Next 16, `next/server`), **después** de que la
  respuesta terminó. En Vercel eso mantiene viva la función; sin `after()` el proceso
  muere al cerrarse el stream y el refresco nunca ocurriría.
- `?fresh=1` fuerza un sync en vivo saltándose el caché. Es lo que dispara el botón
  **"Actualizar"**: la escotilla para cuando alguien acaba de mover algo en el CRM.

**Umbral: 15 minutos.** Vive en una constante, no en un env var — cambiarlo es un
commit, igual que los alcances.

**Si Neon está caído, el dashboard sigue funcionando.** Cualquier error de la base se
registra y se cae al sync en vivo. La base es un acelerador, nunca una dependencia:
introducirla no debe crear una forma nueva de que el dashboard no cargue.

## Estructura

El handler de `app/api/dashboard/route.ts` tiene ~400 líneas de orquestación de sync
inline. Para que el refresco en segundo plano pueda reusarlo, esa orquestación tiene
que salir a una función. Es el refactor que esta feature necesita, y de paso corrige un
archivo que ya creció de más.

| Archivo | Responsabilidad |
|---|---|
| `lib/db.ts` **(nuevo)** | El cliente de Neon. **La costura**: nada aguas abajo sabe que la base es Neon, igual que nada sabe que el roster viene de un env var. Cambiar de proveedor toca solo este archivo. |
| `lib/sync-store.ts` **(nuevo)** | `readSync`, `writeSync`, `claimSync`, `releaseSync`. La compresión vive aquí. Es el único módulo que conoce la tabla. |
| `lib/sync.ts` **(nuevo)** | `syncProject(onProgress?)`: la orquestación extraída del route. Corre dentro de `withClient()` y devuelve el payload. |
| `app/api/dashboard/route.ts` | Adelgaza: resuelve el cliente, lee el store, sirve, y decide si refresca. |
| `scripts/db-migrate.ts` **(nuevo)** | `CREATE TABLE IF NOT EXISTS`, idempotente. `pnpm db:migrate`. Sin framework de migraciones, coherente con el resto del repo. |

**Aislamiento entre proyectos.** `readSync`/`writeSync` reciben un `ClientConfig`, no un
string suelto: un bug que lea la fila equivocada sería exactamente la fuga entre
proyectos que toda la arquitectura evita (la misma clase de error que la regla de
`AsyncLocalStorage`). La escritura toma el id de `currentClient()`, nunca de un
parámetro que pudiera venir de otro lado.

## Contrato con el navegador

El stream NDJSON no cambia de forma: en una lectura caliente llega un solo frame
`data`. Se le agrega un campo:

```ts
{ type: "data", ..., syncedAt: "2026-08-11T19:32:43.408Z" }
```

- El header del dashboard muestra **"actualizado hace X"** junto al botón Actualizar.
  Sin esa marca visible, el caché miente por omisión: alguien podría decidir con datos
  de hace rato sin saberlo.
- Cuando el refresco en segundo plano termina, el usuario **no** ve un cambio mágico de
  cifras bajo el cursor —eso desorienta—. La marca queda como está hasta el siguiente
  `refresh()` o la siguiente carga.
- La pantalla de carga solo aparece en el caché frío y en `?fresh=1`. Con lectura
  caliente la respuesta llega en un frame; el hook debe evitar parpadearla, así que
  espera ~300 ms antes de mostrarla.

## Configuración

- **`DATABASE_URL`** — la cadena de conexión de Neon. La integración de Vercel la
  inyecta sola; en `.env.local` va a mano. Server-side only, como todo lo demás.
- Dependencia nueva: **`@neondatabase/serverless`**, instalada con `pnpm add`
  (nunca `npm install` — desincroniza `pnpm-lock.yaml` y rompe el build de Vercel).
- **`export const maxDuration = 300`** en la ruta del dashboard. El sync de Yconia tarda
  34s y el tope por defecto es mucho menor.

  **Requiere plan Pro en Vercel — no es opcional.** La primera medición dio 33.9s para
  Yconia; una segunda, media hora después, dio **60.3s** con los mismos datos. El
  tiempo de sync varía casi al doble según cómo responda GHL, y 60.3s ya **rebasa** el
  techo de 60s de Hobby. El modo de falla habría sido silencioso: el refresco en
  segundo plano cortado a la mitad *después* de que la respuesta ya salió, sin que
  nadie se entere. Con 300s hay margen de sobra incluso mientras Yconia crece.

  El tier **gratuito de Neon es suficiente**: lo único que compra el de paga es quitar el
  escalado a cero, ~0.5s en la primera carga del día, ruido frente a una mejora de 34s a
  2s.

## Verificación

Siguiendo la convención del repo (`node:assert/strict` vía `tsx`, sin framework de
tests; el paquete es CommonJS, así que el trabajo asíncrono va dentro de un `main()`):

**`scripts/verify-sync-store.ts`** (nuevo, `pnpm verify:sync-store`), sobre las partes
puras, sin base de datos:

- `isStale(syncedAt, now)` respeta el umbral de 15 minutos en ambos bordes.
- El roundtrip de compresión devuelve exactamente el objeto original, incluidos acentos
  y emojis (los nombres de contacto los tienen).
- La lógica del candado: un `sync_started_at` reciente bloquea, uno de hace más de 10
  minutos se puede reclamar, `NULL` se puede reclamar.

**`npx tsc --noEmit`** — obligatorio: `next build` ignora los errores de TypeScript.

**Manejar la app real**, que es lo único que prueba el camino SQL:

1. `pnpm db:migrate` sobre una base limpia → la tabla existe.
2. Abrir Yconia con la tabla vacía → pantalla de carga, ~34s, y queda una fila.
3. Recargar → **aparece sin pantalla de carga**, y el header dice "actualizado hace
   menos de un minuto". Éste es el resultado que justifica todo el trabajo.
4. Esperar 15 min, recargar → aparece igual de rápido con lo viejo, y `synced_at`
   avanza unos segundos después (el refresco de `after()` corrió).
5. Botón **Actualizar** → sync en vivo, `synced_at` al momento.
6. Dos pestañas abriendo el mismo proyecto vencido a la vez → **una sola** sincronización
   (el candado), verificable en los logs.
7. Con `DATABASE_URL` apuntando a un host inválido → el dashboard **sigue cargando** en
   vivo, con un error registrado en el log del servidor.
8. Abrir dos proyectos distintos y confirmar que cada uno trae sus propios números: el
   caché no cruza proyectos.

## Fuera de alcance (YAGNI)

- Framework de migraciones. Una tabla no lo amerita.
- Invalidación por webhook de GHL. El umbral de 15 minutos más el botón Actualizar
  cubren el caso; los webhooks son un sistema aparte con su propia superficie de fallo.
- Precalentar el caché de todos los proyectos con un cron. Sin historia que registrar,
  sincronizar lo que nadie está mirando es gasto puro de API.
