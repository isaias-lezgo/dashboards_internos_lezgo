// Verification for lib/pauta.ts. Run: pnpm verify:pauta
//
// The point of this script: isPaidTraffic decides whether an opportunity counts as
// "de pauta", and it does so by matching a vocabulary of platform names against the
// opportunity's own source/medium. Those are FREE-TEXT fields — GHL will happily put
// a whole URL in `source` — so a matching rule that is too loose silently invents
// paid traffic that does not exist, and a rule that is too tight silently loses real
// campaigns. Neither failure raises anything; both just make a KPI wrong.
//
// The Callpicker cases below are not hypothetical. They are three real `source`
// values from Condesa Cimatario: call-recording URLs whose hex digest happens to
// contain the letters "fb", which the old substring rule read as "Facebook". Across
// the six projects that mistake invented 79 opportunities "de pauta" with no pauta
// behind them.
import assert from "node:assert/strict";
import {
  isPaidTraffic,
  isDePauta,
  campaignHeadline,
  type HasKey,
} from "../lib/pauta";
import type { Opportunity } from "../lib/types";

function opp(source?: string, adType?: string): Opportunity {
  return { id: "o1", name: "o", contactId: "c1", source, adType } as unknown as Opportunity;
}

// --- real paid traffic still counts. These are actual values observed in the roster.
for (const src of ["facebook", "Facebook", "instagram", "TikTok", "google", "Meta"]) {
  assert.equal(isPaidTraffic(opp(src)), true, `source "${src}" debe contar como pauta`);
}
for (const med of ["Paid Social", "paid_social", "paidsocial", "cpc", "CPM", "paid_search", "google_ads"]) {
  assert.equal(isPaidTraffic(opp(undefined, med)), true, `adType "${med}" debe contar como pauta`);
}

// --- a platform name is still found when it sits among other tokens
assert.equal(isPaidTraffic(opp("facebook_ads")), true, "facebook_ads sigue siendo Facebook");
assert.equal(isPaidTraffic(opp("m.facebook.com")), true, "un host de Facebook sigue siendo Facebook");
assert.equal(isPaidTraffic(opp("fb.me/2xK9d")), true, "una liga fb.me sigue siendo Facebook");
assert.equal(isPaidTraffic(opp(undefined, "Paid  Social")), true, "el espacio doble no debe romper la frase");

// --- REGRESIÓN: los tres valores reales de Condesa. El digest trae "fb" adentro.
const CALLPICKER = [
  "https://api.callpicker.com/call_details/getRecordAudio/CP.CU.268.7b293bf/be1496a52db6fe904d692160b179fadfba2dd2ab",
  "https://api.callpicker.com/call_details/getRecordAudio/CP.CU.268.7b293bf/0695d95867ef4003076fad2fb9840e3e911e4a36",
  "https://api.callpicker.com/call_details/getRecordAudio/CP.CU.268.7b293bf/a8cdeed902ab67ce5addfadcd11af657fb21c69e",
];
for (const url of CALLPICKER) {
  assert.equal(
    isPaidTraffic(opp(url)),
    false,
    `una grabación de Callpicker no es pauta; su hash sólo CONTIENE "fb":\n    ${url}`,
  );
}

// --- la misma clase de error, escrita a mano: un token corto adentro de una palabra
assert.equal(isPaidTraffic(opp("metadata-import")), false, '"metadata" no es Meta');
assert.equal(isPaidTraffic(opp("Portal inmobiliario")), false, "un origen cualquiera no es pauta");
assert.equal(isPaidTraffic(opp(undefined, "CRM UI")), false, "CRM UI no es un medio pagado");
assert.equal(isPaidTraffic(opp(undefined, "CORREGIDORA - CONJUNTO A")), false, "un nombre de conjunto no es un medio");
assert.equal(isPaidTraffic(opp("")), false, "sin origen no hay pauta");

// --- isDePauta es la UNIÓN: basta con que el contacto tenga registro de Pauta
const conPauta: HasKey = { has: (k) => k === "c1" };
const sinPauta: HasKey = { has: () => false };
assert.equal(isDePauta(opp("direct"), conPauta), true, "contacto con pauta cuenta aunque el origen no sea pagado");
assert.equal(isDePauta(opp("direct"), sinPauta), false, "sin pauta y sin origen pagado no cuenta");
assert.equal(isDePauta(opp("facebook"), sinPauta), true, "origen pagado cuenta aunque no haya registro de pauta");
assert.equal(
  isDePauta(opp(CALLPICKER[0]), sinPauta),
  false,
  "una grabación de Callpicker sin registro de pauta no debe contar por ningún lado",
);

// --- campaignHeadline: junta las creatividades de una campaña sin tocar los
// nombres de formulario, que también separan con guiones.
assert.equal(
  campaignHeadline("Depa Desde $1,900,000 en Qro - https://fb.me/xyz - 120210000000"),
  "Depa Desde $1,900,000 en Qro",
);
assert.equal(
  campaignHeadline("IW - CC - FF - Corregidora - Enero 2026"),
  "IW - CC - FF - Corregidora - Enero 2026",
  "un nombre de formulario no termina en id: debe quedar intacto",
);

console.log("✅ lib/pauta.ts — all assertions passed");
