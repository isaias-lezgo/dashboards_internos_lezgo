// Verificación de lib/meta-normalize.ts. Correr: pnpm verify:meta
//
// La parte pura de la integración con Meta: de `actions` solo salen dos
// contadores, la ventana se parte por mes calendario, y la jerarquía se
// normaliza en tablas planas. Un bug aquí es un costo por lead equivocado.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import {
  normalizeInsightRow,
  normalizeAds,
  monthChunks,
  historyWindow,
  mergeMetaAds,
  MAX_HISTORY_MONTHS,
} from "../lib/meta-normalize";

async function main() {
  // --- actions: solo lead y messaging; el resto se ignora; números como strings
  const row = normalizeInsightRow({
    ad_id: "120247808685340416",
    date_start: "2026-09-01",
    spend: "123.45",
    impressions: "1000",
    reach: "800",
    clicks: "40",
    inline_link_clicks: "35",
    actions: [
      { action_type: "lead", value: "3" },
      { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "5" },
      { action_type: "link_click", value: "35" },
      { action_type: "post_engagement", value: "90" },
    ],
  });
  assert.deepEqual(row, {
    adId: "120247808685340416",
    date: "2026-09-01",
    spend: 123.45,
    impressions: 1000,
    reach: 800,
    clicks: 40,
    linkClicks: 35,
    leadsForm: 3,
    leadsMsg: 5,
  });

  // --- campos ausentes → 0, nunca NaN
  const bare = normalizeInsightRow({ ad_id: "1", date_start: "2026-09-02" });
  assert.equal(bare.spend, 0);
  assert.equal(bare.leadsForm, 0);
  assert.equal(bare.leadsMsg, 0);
  assert.equal(bare.linkClicks, 0);

  // --- jerarquía: tablas planas, sin duplicar padres, con accountId en la campaña
  const h = normalizeAds("act_1", [
    { id: "a1", name: "Ad 1", effective_status: "ACTIVE", adset: { id: "s1", name: "Set 1" }, campaign: { id: "c1", name: "Camp 1", objective: "OUTCOME_LEADS" } },
    { id: "a2", name: "Ad 2", effective_status: "PAUSED", adset: { id: "s1", name: "Set 1" }, campaign: { id: "c1", name: "Camp 1", objective: "OUTCOME_LEADS" } },
    { id: "a3", name: "Ad 3", adset: { id: "s2", name: "Set 2" }, campaign: { id: "c2", name: "Camp 2" } },
  ]);
  assert.deepEqual(h.campaigns, [
    { id: "c1", name: "Camp 1", objective: "OUTCOME_LEADS", accountId: "act_1" },
    { id: "c2", name: "Camp 2", objective: undefined, accountId: "act_1" },
  ]);
  assert.deepEqual(h.adsets, [
    { id: "s1", name: "Set 1", campaignId: "c1" },
    { id: "s2", name: "Set 2", campaignId: "c2" },
  ]);
  assert.deepEqual(h.ads, [
    { id: "a1", name: "Ad 1", adsetId: "s1", status: "ACTIVE" },
    { id: "a2", name: "Ad 2", adsetId: "s1", status: "PAUSED" },
    { id: "a3", name: "Ad 3", adsetId: "s2", status: undefined },
  ]);
  // --- un ad sin adset/campaign (borrados) se conserva con padres vacíos
  const orphan = normalizeAds("act_1", [{ id: "a9", name: "Huérfano" }]);
  assert.deepEqual(orphan.ads, [{ id: "a9", name: "Huérfano", adsetId: "", status: undefined }]);
  assert.deepEqual(orphan.adsets, []);

  // --- chunks por mes calendario, con bordes
  assert.deepEqual(monthChunks("2026-07-15", "2026-09-13"), [
    { since: "2026-07-15", until: "2026-07-31" },
    { since: "2026-08-01", until: "2026-08-31" },
    { since: "2026-09-01", until: "2026-09-13" },
  ]);
  assert.deepEqual(monthChunks("2026-09-01", "2026-09-01"), [{ since: "2026-09-01", until: "2026-09-01" }]);
  assert.deepEqual(monthChunks("2026-02-01", "2026-03-01"), [
    { since: "2026-02-01", until: "2026-02-28" },
    { since: "2026-03-01", until: "2026-03-01" },
  ]);
  assert.deepEqual(monthChunks("2026-09-13", "2026-09-01"), [], "ventana invertida = nada");

  // --- ventana de historia: desde el primer día del mes de la opp más vieja con adId
  const w = historyWindow(
    [
      { createdAt: "2025-11-20T10:00:00.000Z", adId: undefined },
      { createdAt: "2026-01-17T10:00:00.000Z", adId: "1" },
      { createdAt: "2026-03-02T10:00:00.000Z", adId: "2" },
    ],
    "2026-09-13"
  );
  assert.deepEqual(w, { since: "2026-01-01", until: "2026-09-13" });
  // --- tope de 24 meses
  const old = historyWindow([{ createdAt: "2020-01-01T00:00:00.000Z", adId: "1" }], "2026-09-13");
  assert.equal(old.since, "2024-09-01", `tope de ${MAX_HISTORY_MONTHS} meses`);
  // --- sin oportunidades con adId: solo el mes actual
  assert.deepEqual(historyWindow([], "2026-09-13"), { since: "2026-09-01", until: "2026-09-13" });

  // --- merge: concatena, marca fallidas, conserva la ventana
  const merged = mergeMetaAds(
    [
      { account: { id: "act_1", name: "Uno", currency: "MXN", timezone: "America/Mexico_City" }, hierarchy: h, daily: [row] },
      { account: { id: "act_2", name: "Dos", currency: "MXN", timezone: "America/Mexico_City" }, hierarchy: orphan, daily: [bare] },
    ],
    [{ id: "act_3", reason: "permission" }],
    { since: "2026-01-01", until: "2026-09-13" }
  );
  assert.equal(merged.accounts.length, 2);
  assert.equal(merged.campaigns.length, 2);
  assert.equal(merged.ads.length, 4);
  assert.equal(merged.daily.length, 2);
  assert.deepEqual(merged.failedAccounts, [{ id: "act_3", reason: "permission" }]);
  assert.deepEqual(merged.window, { since: "2026-01-01", until: "2026-09-13" });

  console.log("✅ verify:meta OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
