// Verification for lib/drill-export.ts. Run: pnpm verify:drill-export
//
// El punto de este script: el panel decide QUÉ registros caen en la ventana de
// fechas usando la zona horaria de quien mira (`resolveDateRange` recorta con
// startOfDay/endOfDay locales), y el drawer los dibuja con `toLocaleDateString`.
// La exportación CSV es la única superficie que imprimía el ISO crudo de GHL,
// que viene en UTC. En México eso corre la fecha seis horas: una pauta creada el
// 6 de septiembre a las 23:36 locales — seleccionada por un filtro "1 sep a 6
// sep", y mostrada como "6 sep" en el propio drawer — salía del CSV como
// `2026-09-07T05:36:25.817Z`. El caso real: 43 pautas de Condesa (tipo
// Formulario, agencia IW) de las que varias se leían como del día 7, fuera del
// rango pedido. Nada falla; sólo el archivo miente.
//
// Un desfase así no se ve sin fijar la zona horaria, así que este script la
// fija y comprueba primero que la fijación sirvió.
process.env.TZ = "America/Mexico_City";

import assert from "node:assert/strict";
import { buildDrillExport } from "../lib/drill-export";
import type { DrillState } from "../components/dashboard/chart-drill-drawer";
import type { Contact, Opportunity, Pauta } from "../lib/types";

// --- la zona horaria de la prueba se aplicó de verdad
assert.equal(
  new Date("2026-09-07T05:36:25.817Z").getHours(),
  23,
  "TZ=America/Mexico_City no se aplicó: el resto de las aserciones no probaría nada",
);

const drill = (over: Partial<DrillState>): DrillState =>
  ({ title: "Pautas por canal", opportunities: [], ...over }) as DrillState;

const csvRows = (csv: string) => csv.split("\r\n");
const cell = (csv: string, row: number, col: number) => csvRows(csv)[row].split(",")[col];

// --- el caso real: la pauta de la noche del 6 se exporta como del 6, no del 7.
const pauta = {
  id: "p1",
  tipo: "Formulario",
  nombrePauta: "QUERÉTARO -CONJUNTO B",
  contactId: "c1",
  createdAt: "2026-09-07T05:36:25.817Z",
} as unknown as Pauta;

const contact = { id: "c1", name: "Maria Olvera", phone: "525551953128" } as unknown as Contact;

const pautaExport = buildDrillExport(drill({ pautaItems: [{ pauta, contact }] }), [])!;
assert.ok(pautaExport, "una pauta debe producir exportación");
assert.equal(
  cell(pautaExport.csvContent, 1, 5),
  "2026-09-06 23:36",
  "la pauta creada 23:36 del 6 local debe exportarse como del 6, no como 2026-09-07T05:36Z",
);
assert.ok(
  !pautaExport.csvContent.includes("Z"),
  "ningún sello UTC crudo debe sobrevivir en el CSV",
);

// --- los otros dos modos con fecha comparten la misma regla
const contactoConFecha = {
  id: "c2",
  name: "Marcos De la Cruz",
  createdAt: "2026-09-07T05:05:19.681Z",
} as unknown as Contact;
const contactExport = buildDrillExport(drill({ contactItems: [contactoConFecha] }), [])!;
assert.equal(
  csvRows(contactExport.csvContent)[1].split(",").at(-1),
  "2026-09-06 23:05",
  "el modo contactos usa la misma fecha local",
);

const opp = {
  id: "o1",
  name: "Oportunidad",
  contactId: "c1",
  status: "open",
  value: 0,
  createdAt: "2026-09-07T04:56:47.379Z",
} as unknown as Opportunity;
const oppExport = buildDrillExport(drill({ opportunities: [opp] }), [contact])!;
assert.equal(
  csvRows(oppExport.csvContent)[1].split(",").at(-1),
  "2026-09-06 22:56",
  "el modo oportunidades usa la misma fecha local",
);

// --- una fecha ausente o ilegible no debe inventar una ni romper la fila
const sinFecha = { ...pauta, createdAt: undefined } as unknown as Pauta;
assert.equal(
  cell(buildDrillExport(drill({ pautaItems: [{ pauta: sinFecha, contact }] }), [])!.csvContent, 1, 5),
  "",
  "sin fecha, la celda va vacía",
);
const basura = { ...pauta, createdAt: "no es una fecha" } as unknown as Pauta;
assert.equal(
  cell(buildDrillExport(drill({ pautaItems: [{ pauta: basura, contact }] }), [])!.csvContent, 1, 5),
  "no es una fecha",
  "un valor no fechable se pasa tal cual en vez de convertirse en Invalid Date",
);

// --- el nombre del archivo también lleva el día LOCAL. Con el día UTC, cada
// tarde a partir de las 18:00 en México el archivo se llamaba con el día de mañana.
const hoy = new Date();
const esperado = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
assert.ok(
  pautaExport.filename.endsWith(`${esperado}.csv`),
  `el archivo debe llevar el día local (${esperado}), no el UTC: ${pautaExport.filename}`,
);

// --- lo que ya funcionaba sigue igual: sin filas no hay exportación, y el modo
// se elige en el mismo orden que el drawer.
assert.equal(buildDrillExport(drill({}), []), null, "sin registros no hay exportación");
assert.ok(
  buildDrillExport(drill({ members: ["Ana"], opportunities: [opp] }), [])!.filename.startsWith("vendedores-"),
  "members gana sobre los demás modos",
);

console.log("✅ lib/drill-export.ts — all assertions passed");
