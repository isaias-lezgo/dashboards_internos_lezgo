// Verificación de lib/meta-attribution.ts. Correr: pnpm verify:meta-attribution
//
// Un error aquí es un número equivocado en pantalla: un CPL calculado sobre
// leads que no eran de ese anuncio, o un gasto que se cuenta dos veces. Por eso
// las aserciones fijan la llave (ad id), la cohorte por día LOCAL y las
// divisiones sin denominador.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import type { MetaAdsData, Opportunity } from "../lib/types";
import {
  oppAdId,
  buildMetaIndex,
  classifyLead,
  localDay,
  buildCostSummary,
  buildCampaignPerformance,
  buildMetaReport,
  defaultCurrency,
} from "../lib/meta-attribution";

function opp(over: Partial<Opportunity> & { id: string }): Opportunity {
  return {
    name: over.id,
    pipelineId: "p",
    pipelineStageId: "s",
    status: "open",
    createdAt: "2026-08-10T15:00:00.000Z",
    contactId: `c-${over.id}`,
    value: 0,
    stage: "Nuevo",
    pipelineName: "Ventas",
    ...over,
  } as Opportunity;
}

const meta: MetaAdsData = {
  accounts: [
    { id: "act_1", name: "Condesa", currency: "MXN", timezone: "America/Mexico_City" },
    { id: "act_2", name: "USD", currency: "USD", timezone: "America/Mexico_City" },
  ],
  campaigns: [
    { id: "camp-a", name: "IW - CC - FF - Demografía", accountId: "act_1" },
    { id: "camp-b", name: "IW - CC - FF - Buyer", accountId: "act_1" },
    { id: "camp-usd", name: "Test USD", accountId: "act_2" },
  ],
  adsets: [
    { id: "set-a", name: "Set A", campaignId: "camp-a" },
    { id: "set-b", name: "Set B", campaignId: "camp-b" },
    { id: "set-usd", name: "Set USD", campaignId: "camp-usd" },
  ],
  ads: [
    { id: "120001", name: "AD 01", adsetId: "set-a" },
    { id: "120002", name: "AD 02", adsetId: "set-a" },
    { id: "120003", name: "AD 03", adsetId: "set-b" },
    { id: "120009", name: "AD USD", adsetId: "set-usd" },
  ],
  daily: [
    { adId: "120001", date: "2026-08-10", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 4, leadsMsg: 0 },
    { adId: "120002", date: "2026-08-11", spend: 50, impressions: 500, reach: 450, clicks: 10, linkClicks: 8, leadsForm: 0, leadsMsg: 2 },
    { adId: "120003", date: "2026-08-20", spend: 300, impressions: 3000, reach: 2000, clicks: 90, linkClicks: 80, leadsForm: 0, leadsMsg: 0 },
    { adId: "120001", date: "2026-09-01", spend: 999, impressions: 1, reach: 1, clicks: 0, linkClicks: 0, leadsForm: 0, leadsMsg: 0 },
    { adId: "120009", date: "2026-08-12", spend: 10, impressions: 100, reach: 90, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 },
  ],
  window: { since: "2026-08-01", until: "2026-09-14" },
  failedAccounts: [],
};

async function main() {
  // --- oppAdId: nativo manda; custom field es fallback; se normaliza a dígitos
  assert.equal(oppAdId(opp({ id: "1", adId: "120001" })), "120001");
  assert.equal(oppAdId(opp({ id: "2", adId: " 120001 " })), "120001");
  assert.equal(oppAdId(opp({ id: "3", customFieldsResolved: { "ID de Pauta": "120002" } })), "120002");
  assert.equal(oppAdId(opp({ id: "4", customFieldsResolved: { "ID Pauta": "120002" } })), "120002");
  assert.equal(oppAdId(opp({ id: "5", adId: "120001", customFieldsResolved: { "ID Pauta": "120002" } })), "120001", "la attribution nativa manda");
  assert.equal(oppAdId(opp({ id: "6", customFieldsResolved: { "URL Pauta": "https://fb.me/x" } })), null, "URL Pauta no es ad id");
  assert.equal(oppAdId(opp({ id: "7", adId: "" })), null);
  assert.equal(oppAdId(opp({ id: "8", adId: "abc" })), null, "sin dígitos no hay id");

  // --- índice
  const index = buildMetaIndex(meta);
  assert.equal(index.byAd.get("120001")?.campaign?.id, "camp-a");
  assert.equal(index.byAd.get("120001")?.account?.currency, "MXN");
  assert.equal(index.byAd.get("120003")?.adset?.id, "set-b");
  assert.equal(index.dailyByAd.get("120001")?.length, 2);
  assert.equal(index.byAd.has("999"), false);

  // --- classifyLead: cuatro niveles; csv_import gana incluso con ad id
  const pautaContacts = new Set(["c-p"]);
  const ctx = { index, pautaContacts };
  assert.equal(classifyLead(opp({ id: "e", adId: "120001" }), ctx), "exact");
  assert.equal(classifyLead(opp({ id: "u", adId: "777777", source: "facebook" }), ctx), "unknownAd");
  assert.equal(classifyLead(opp({ id: "p", contactId: "c-p" }), ctx), "noAdId", "de pauta por el objeto Pauta, sin id");
  assert.equal(classifyLead(opp({ id: "n", source: "referido" }), ctx), "notPauta");
  assert.equal(
    classifyLead(opp({ id: "csv", adId: "120001", attributions: [{ medium: "csv_import" }] }), ctx),
    "notPauta",
    "importado por CSV nunca entra al costo"
  );

  // --- localDay: 23:36 del 6 en UTC-6 es el 7 en UTC; el día local manda
  assert.equal(localDay("2026-08-07T05:36:00.000Z"), "2026-08-06");
  assert.equal(localDay("2026-08-07T06:00:00.000Z"), "2026-08-07");

  // --- buildCostSummary sobre agosto
  const range = { since: "2026-08-01", until: "2026-08-31" };
  const opps = [
    opp({ id: "a1", adId: "120001", createdAt: "2026-08-10T16:00:00.000Z", status: "won" }),
    opp({ id: "a2", adId: "120001", createdAt: "2026-08-10T17:00:00.000Z" }),
    opp({ id: "a3", adId: "120002", createdAt: "2026-08-11T17:00:00.000Z", stage: "Negocio Ganado" }),
    opp({ id: "a4", adId: "120003", createdAt: "2026-09-01T05:59:00.000Z" }), // 31 ago 23:59 local → dentro
    opp({ id: "sep", adId: "120001", createdAt: "2026-09-01T06:01:00.000Z" }), // 1 sep local → fuera
    opp({ id: "unk", adId: "555555", source: "facebook", createdAt: "2026-08-15T12:00:00.000Z" }),
    opp({ id: "noid", contactId: "c-p", createdAt: "2026-08-15T12:00:00.000Z" }),
    opp({ id: "org", source: "referido", createdAt: "2026-08-15T12:00:00.000Z" }),
  ];
  const s = buildCostSummary({ opportunities: opps, meta, index, range, pautaContacts });
  assert.equal(s.mixedCurrency, true, "act_2 es USD");
  assert.deepEqual(s.spendByCurrency, { MXN: 450, USD: 10 });
  assert.equal(s.spend, null, "con moneda mixta no hay total consolidado");
  assert.equal(s.cpl, null);
  assert.equal(s.leadsMeta, 6);
  assert.equal(s.leadsCrm, 4, "a1 a2 a3 a4; sep queda fuera por día local");
  assert.equal(s.won, 2, "status won + etapa Negocio Ganado (isWonOpp)");
  assert.equal(s.unknownAdLeads, 1);
  assert.equal(s.noAdIdLeads, 1);

  // --- solo MXN: costos consolidados
  const mxn: MetaAdsData = { ...meta, daily: meta.daily.filter((d) => d.adId !== "120009") };
  const s2 = buildCostSummary({ opportunities: opps, meta: mxn, index: buildMetaIndex(mxn), range, pautaContacts });
  assert.equal(s2.mixedCurrency, false);
  assert.equal(s2.currency, "MXN");
  assert.equal(s2.spend, 450);
  assert.equal(s2.cpl, 112.5);
  assert.equal(s2.cpa, 225);

  // --- sin leads en la ventana → null, nunca 0 ni Infinity
  const s3 = buildCostSummary({ opportunities: [], meta: mxn, index: buildMetaIndex(mxn), range, pautaContacts });
  assert.equal(s3.spend, 450);
  assert.equal(s3.leadsCrm, 0);
  assert.equal(s3.cpl, null);
  assert.equal(s3.cpa, null);

  // --- range null = todo
  const s4 = buildCostSummary({ opportunities: opps, meta: mxn, index: buildMetaIndex(mxn), range: null, pautaContacts });
  assert.equal(s4.spend, 1449);
  assert.equal(s4.leadsCrm, 5);

  // --- por campaña
  const rows = buildCampaignPerformance({ opportunities: opps, meta: mxn, index: buildMetaIndex(mxn), range, pautaContacts });
  const a = rows.find((r) => r.campaignId === "camp-a")!;
  const b = rows.find((r) => r.campaignId === "camp-b")!;
  assert.equal(a.spend, 150);
  assert.equal(a.impressions, 1500);
  assert.equal(a.clicks, 60);
  assert.equal(a.cpm, 100);
  assert.equal(a.ctr, 0.04);
  assert.equal(a.leadsMeta, 6);
  assert.equal(a.leadsCrm, 3);
  assert.equal(a.won, 2);
  assert.equal(a.cpl, 50);
  assert.equal(a.cpa, 75);
  assert.equal(b.spend, 300);
  assert.equal(b.leadsCrm, 1);
  assert.equal(b.won, 0);
  assert.equal(b.cpa, null);
  assert.ok(rows.findIndex((r) => r.campaignId === "camp-b") < rows.findIndex((r) => r.campaignId === "camp-a"), "ordenado por gasto desc");
  assert.equal(rows.some((r) => r.campaignId === "camp-usd"), false, "sin filas en la ventana no aparece");

  // ── buildMetaReport ────────────────────────────────────────────────────────
  const mxnIdx = buildMetaIndex(mxn);
  const base = { opportunities: opps, meta: mxn, index: mxnIdx, range, pautaContacts };

  // --- none: una fila total, igual que buildCostSummary
  const total = buildMetaReport({ ...base, groupBy: "none" });
  assert.equal(total.length, 1);
  assert.equal(total[0].key, "total");
  assert.equal(total[0].spend, 450);
  assert.equal(total[0].leadsCrm, 4);
  assert.equal(total[0].currency, "MXN");
  assert.equal(total[0].cpl, 112.5);

  // --- campaign: idéntico al alias
  const byCamp = buildMetaReport({ ...base, groupBy: "campaign" });
  assert.deepEqual(byCamp.map((r) => [r.key, r.spend, r.leadsCrm]), rows.map((r) => [r.campaignId, r.spend, r.leadsCrm]));

  // --- month: cronológico; la cohorte cruza el límite de mes por DÍA LOCAL
  const byMonth = buildMetaReport({ ...base, groupBy: "month", range: null });
  assert.deepEqual(byMonth.map((r) => r.key), ["2026-08", "2026-09"]);
  assert.equal(byMonth[0].spend, 450);
  assert.equal(byMonth[0].leadsCrm, 4, "a4 (31 ago 23:59 local) cae en agosto");
  assert.equal(byMonth[1].spend, 999);
  assert.equal(byMonth[1].leadsCrm, 1, "sep (1 sep 00:01 local) cae en septiembre");
  assert.equal(byMonth[1].label, "2026-09");

  // --- adset y ad
  const byAdset = buildMetaReport({ ...base, groupBy: "adset" });
  assert.deepEqual(byAdset.map((r) => [r.key, r.spend]), [["set-b", 300], ["set-a", 150]]);
  const byAd = buildMetaReport({ ...base, groupBy: "ad" });
  assert.deepEqual(byAd.map((r) => r.key), ["120003", "120001", "120002"]);
  assert.equal(byAd.find((r) => r.key === "120001")?.leadsCrm, 2);
  assert.equal(byAd.find((r) => r.key === "120001")?.accountId, "act_1");

  // --- filtro por campaña (substring, sin acentos ni mayúsculas)
  const onlyB = buildMetaReport({ ...base, groupBy: "ad", campaign: "buyer" });
  assert.deepEqual(onlyB.map((r) => r.key), ["120003"]);
  const onlyBMonth = buildMetaReport({ ...base, groupBy: "month", campaign: "DEMOGRAFIA" });
  assert.equal(onlyBMonth.length, 1);
  assert.equal(onlyBMonth[0].spend, 150, "el filtro de campaña acota también los totales por mes");

  // --- includeIds: solo con la bandera, distintos, con tope
  const noIds = buildMetaReport({ ...base, groupBy: "campaign" });
  assert.equal(noIds[0].oppIds, undefined);
  const withIds = buildMetaReport({ ...base, groupBy: "campaign", includeIds: true });
  const campA = withIds.find((r) => r.key === "camp-a")!;
  assert.deepEqual([...campA.oppIds!].sort(), ["a1", "a2", "a3"]);
  assert.deepEqual([...campA.contactIds!].sort(), ["c-a1", "c-a2", "c-a3"]);
  const many = Array.from({ length: 80 }, (_, i) =>
    opp({ id: `m${i}`, adId: "120001", contactId: "c-shared", createdAt: "2026-08-12T12:00:00.000Z" })
  );
  const cappedRow = buildMetaReport({ ...base, opportunities: many, groupBy: "ad", includeIds: true }).find((r) => r.key === "120001")!;
  assert.equal(cappedRow.leadsCrm, 80, "el conteo no se topa");
  assert.equal(cappedRow.oppIds!.length, 50, "los ids sí (cap 50)");
  assert.deepEqual(cappedRow.contactIds, ["c-shared"], "contactIds distintos");

  // --- moneda mixta: la fila total lleva "?" y sin costos; por campaña cada una con la suya
  const mixedIdx = buildMetaIndex(meta);
  const mixedTotal = buildMetaReport({ opportunities: opps, meta, index: mixedIdx, range, pautaContacts, groupBy: "none" });
  assert.equal(mixedTotal[0].currency, "?");
  assert.equal(mixedTotal[0].spend, 460, "el gasto se suma igual; la UI sabe por currency que no es comparable");
  assert.equal(mixedTotal[0].cpl, null);
  assert.equal(mixedTotal[0].cpm, null);
  const mixedCamp = buildMetaReport({ opportunities: opps, meta, index: mixedIdx, range, pautaContacts, groupBy: "campaign" });
  assert.equal(mixedCamp.find((r) => r.key === "camp-usd")?.currency, "USD");

  // --- defaultCurrency y un ad fuera de la jerarquía NO ensucia la moneda
  // `mxn` solo recorta las filas diarias: sus CUENTAS siguen siendo dos (MXN y
  // USD), así que la moneda por defecto solo existe con una cuenta.
  const mxnOnly: MetaAdsData = { ...mxn, accounts: [meta.accounts[0]] };
  assert.equal(defaultCurrency(mxn), null, "dos cuentas de monedas distintas: sin moneda por defecto");
  assert.equal(defaultCurrency(mxnOnly), "MXN");
  assert.equal(defaultCurrency(meta), null);
  const orphanDaily: MetaAdsData = {
    ...mxnOnly,
    daily: [...mxn.daily, { adId: "999999", date: "2026-08-15", spend: 5, impressions: 10, reach: 9, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 }],
  };
  const orphanSummary = buildCostSummary({ opportunities: opps, meta: orphanDaily, index: buildMetaIndex(orphanDaily), range, pautaContacts });
  assert.equal(orphanSummary.mixedCurrency, false, "un ad borrado (sin jerarquía) hereda la única moneda de la cuenta");
  assert.equal(orphanSummary.spend, 455);
  const orphanTotal = buildMetaReport({ opportunities: opps, meta: orphanDaily, index: buildMetaIndex(orphanDaily), range, pautaContacts, groupBy: "none" });
  assert.equal(orphanTotal[0].currency, "MXN");

  console.log("✅ verify:meta-attribution OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
