# Portar el caché de sincronización a otro dashboard

Spec para un agente que trabaja en **otro repo** (VAEO, Dashboards clientes) y tiene que
montar el mismo caché que ya corre en `dashboards-internos-lezgo`.

No copies el código de aquel repo: sus tipos, su roster y sus rutas son otros. Copia el
**diseño y las invariantes**. Cada una existe porque algo falló primero.

## El problema que resuelve

Un sync completo contra GHL tarda **34-60 s** (medido dos veces el mismo día, sobre los
mismos datos: GHL varía casi al doble). Con esto, la carga normal baja a **0.8-2.4 s**.

La idea completa: la ruta que hoy llama a GHL deja de hacerlo en el camino normal. Lee
una fila de Postgres con el payload ya armado, la manda, y **si el dato está viejo
dispara el refresco después de responder**. El usuario nunca espera al refresco.

```
GET /api/<tu-ruta-de-datos>
    ↓  resuelve el proyecto/tenant (lo que ya uses para saber a qué cuenta GHL pegar)
    ↓  readSync(proyecto)  → fila de project_sync
    ├─ hay fila → manda el payload YA; si pasó de 15 min, after(() => refrescar)
    └─ no hay   → sync en vivo con pantalla de carga, y lo guarda
```

## Infraestructura

1. **Un Neon propio para este proyecto.** No reuses el de otro despliegue: la tabla se
   indexa por id de proyecto, y dos despliegues con un id repetido se pisan el payload
   mutuamente sin avisar. Provisiona desde el Marketplace de Vercel, en el proyecto de
   Vercel de este repo; la integración inyecta `DATABASE_URL` y `DATABASE_URL_UNPOOLED`.
2. **Región: Neon en `us-east-1`, funciones de Vercel en `iad1`.** Si no coinciden, cada
   lectura del payload paga el viaje entre continentes y se come lo que el caché gana.
3. **Fluid Compute encendido** (Settings → Functions). Es lo que sube `maxDuration` a
   300 s; el plan no — Hobby con Fluid lo permite. Sin Fluid el techo es 60 s, y un sync
   real de 60.3 s ya lo rebasó. El síntoma de tenerlo apagado es sutil: el "Actualizado
   hace X" de un proyecto deja de avanzar, porque el refresco corre *después* de que la
   respuesta salió y se corta en silencio.
4. `pnpm add @neondatabase/serverless` (o el gestor que use ese repo — **no mezcles**
   pnpm y npm, el lockfile desincronizado revienta el build de Vercel).

## Las piezas

### 1. `lib/db.ts` — la costura

Único archivo que sabe que la base es Neon. Exporta `isDbConfigured()` y `getSql()`.

`getSql()` es **perezoso** (crea el cliente en la primera llamada, no al importar el
módulo): importar este archivo sin `DATABASE_URL` — un script de verificación, un paso
de build — no debe tronar.

### 2. La tabla

```sql
CREATE TABLE IF NOT EXISTS project_sync (
  project_id      text PRIMARY KEY,
  payload         bytea       NOT NULL,
  synced_at       timestamptz NOT NULL,
  sync_started_at timestamptz,
  last_error      text
)
```

En un script idempotente (`scripts/db-migrate.ts`, `pnpm db:migrate`). Sin framework de
migraciones: una tabla no lo justifica.

**El DDL va por `DATABASE_URL_UNPOOLED`**: pgbouncer en modo transaction estorba a los
cambios de esquema.

Si el repo es CommonJS (sin `"type": "module"` en package.json), `tsx` compila a CJS y
**el `await` de nivel superior falla** — envuelve todo en `main()` y llama
`main().catch(...)`.

**`bytea` + gzip, no `jsonb`**: nunca consultamos dentro del payload, lo mandamos
entero. Medido: 27.7 MB → 2.49 MB, 11x.

Si tu app es de un solo tenant, `project_id` es una constante (`"default"`). No quites
la columna: cuesta nada y deja la puerta abierta.

### 3. `lib/sync-store.ts` — cuatro funciones

- `readSync(proyecto)` → `{ payload, syncedAt } | null`
- `writeSync(proyecto, payload)` → upsert; **limpia el candado él solo**
- `claimSync(proyecto)` → `boolean`, toma el candado atómicamente
- `releaseSync(proyecto, error?)` → suelta el candado **sin tocar el payload**
- `isStale(syncedAt)` → puro, ventana de 15 min

Detalles que no son opcionales:

- **Reciben el objeto del proyecto, nunca un string suelto.** Leer la fila equivocada
  renderiza el dashboard de A con datos de B. Que la firma exija un proyecto ya resuelto
  por tu capa de sesión hace ese error difícil de cometer.
- **`claimSync` decide dentro del `WHERE` del UPDATE**, no en TypeScript. Un
  read-then-write deja una ventana donde dos peticiones ven el candado libre y ambas
  sincronizan.
- **El candado se auto-sana a los 10 minutos** (`sync_started_at < now() - interval`).
  Una función que muere a medio sync no puede congelar el proyecto para siempre.
- **`releaseSync` no toca el payload.** Un refresco fallido debe dejar el último caché
  bueno donde estaba: un dashboard de hace una hora le gana a ningún dashboard.
- **`claimSync` siembra un payload vacío** cuando toma el candado de un proyecto nunca
  sincronizado. Si ese sync falla, queda una fila de cero bytes y `gunzip` tronaría —
  así que `readSync` trata `length === 0` como "no hay caché", no como "corrupto".
- **`synced_at` sale del payload, no de `now()`**: registra cuándo se trajo el dato de
  GHL, que es lo que significa "actualizado hace X".
- `isStale` con edad negativa (reloj chueco, `synced_at` en el futuro) devuelve
  `false` — resincronizar en cada visita sería peor que confiar en la fila.

### 4. Extraer la orquestación del sync

Antes de tocar la ruta, saca la lógica del sync del route handler a `lib/sync.ts`, con
una firma como `syncProject(proyecto, send?)` donde `send` es opcional (el refresco en
segundo plano no tiene a quién mandarle progreso).

**Esto es el paso que la gente se salta.** Si no lo haces, terminas con dos copias del
sync —la de la ruta y la del refresco— y se desincronizan al primer cambio.

### 5. La ruta

- Lee el caché salvo que venga `?fresh=1`.
- Camino caliente: **un solo frame**, sin progreso, sin GHL.
- Si está viejo: `after(() => refrescar())` de `next/server`. Sin `after`, la función se
  destruye al cerrar la respuesta y el refresco simplemente nunca ocurre.
- Camino frío (nunca sincronizado, `?fresh=1`, o la base no responde): el sync en vivo
  de siempre, y guarda el resultado.
- Resuelve el proyecto/sesión **en el scope de la petición**: `cookies()` no está
  disponible ni dentro del callback del stream ni dentro de `after()`.
- Si el repo usa `AsyncLocalStorage` para las credenciales, entra al contexto **dentro**
  del `start()` del `ReadableStream`, no alrededor del handler: el stream sigue
  produciendo frames después de que el handler regresó.

**La base no es una dependencia.** Todo fallo de Postgres se registra y cae al sync en
vivo: `readCache` y `saveQuietly` envuelven en try/catch y siguen. Meter el caché no
puede crear una forma nueva de que el dashboard no cargue. Pruébalo apuntando
`DATABASE_URL` a un host inválido y confirmando que la app sigue funcionando.

### 6. La UI

El header muestra **"Actualizado hace X"** en tiempo relativo, no la hora del reloj: un
caché sin antigüedad visible miente por omisión. El botón **Actualizar** manda
`?fresh=1`.

## Verificación

- Un script de aserciones (`node:assert/strict` vía `tsx`) sobre `sync-store`: roundtrip
  gzip, aislamiento por proyecto, y que el candado no se deje tomar dos veces. Que las
  aserciones puras corran siempre y el roundtrip contra Postgres solo si hay
  `DATABASE_URL`. Usa ids sintéticos imposibles en el roster real y bórralos al terminar.
- `npx tsc --noEmit`. Si ese repo tiene `ignoreBuildErrors` en `next.config`, un build
  verde no prueba nada.
- Mide de verdad: carga fría contra carga cacheada, en producción, no en local.

## Qué NO hacer

- No guardes historia. **El caché es desechable**: se sobrescribe entero cada vez y
  guarda solo el presente. Si se borra la tabla, se rellena sola desde GHL. Esa
  propiedad es lo que lo mantiene en una tabla en vez de un esquema, y lo que evita
  acumular datos personales históricos.
- No caches rutas de detalle que se piden al abrir un drawer. Van a GHL en vivo y ahí
  está bien.
- No metas un ORM ni un framework de migraciones por una tabla.
