import { NextResponse } from "next/server";
import { forbiddenTab, requireClient, scopeHasTab, unauthorized } from "@/lib/session";
import { withClient } from "@/lib/ghl-context";
import {
  updateContactCustomFields,
  updateOpportunityCustomFields,
  createCustomFieldDef,
  updateCustomFieldDef,
  getCustomFields,
} from "@/lib/ghl-client";
import { mergePicklistOptions, dedupeOptions } from "@/lib/custom-field-merge";

export const runtime = "nodejs";

// LISTA BLANCA. Una acción fuera de aquí es inalcanzable. Sin borrado.
export const WRITE_ACTIONS = [
  "set_contact_fields",
  "set_opportunity_fields",
  "create_custom_field",
  "update_custom_field",
] as const;
type WriteAction = (typeof WRITE_ACTIONS)[number];

interface Body {
  action: string;
  payload: Record<string, unknown>;
}

export async function POST(req: Request) {
  const client = await requireClient();
  if (!client) return unauthorized();
  // Solo el asistente escribe en GHL; un alcance sin su pestaña no escribe.
  if (!(await scopeHasTab("conversations"))) return forbiddenTab();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
  }
  if (!(WRITE_ACTIONS as readonly string[]).includes(body.action)) {
    return NextResponse.json({ error: `Acción no permitida: ${body.action}` }, { status: 400 });
  }
  const action = body.action as WriteAction;
  const payload = body.payload ?? {};

  return withClient(client, async () => {
    // Mapa nombre->def para resolver id, tipo y opciones al escribir valores.
    const defsRaw = await getCustomFields();
    const byName = new Map(defsRaw.customFields.map((d) => [d.name, d]));

    if (action === "set_contact_fields" || action === "set_opportunity_fields") {
      const updates = Array.isArray((payload as Record<string, unknown>).updates)
        ? ((payload as Record<string, unknown>).updates as Array<Record<string, unknown>>)
        : [];
      const idKey = action === "set_contact_fields" ? "contactId" : "opportunityId";
      const writeOne =
        action === "set_contact_fields"
          ? updateContactCustomFields
          : updateOpportunityCustomFields;

      const results = await Promise.allSettled(
        updates.map(async (u) => {
          const recordId = String(u[idKey] ?? "");
          const rawFields = (u.fields ?? {}) as Record<string, string | string[]>;
          const fields = Object.entries(rawFields).map(([name, value]) => {
            const def = byName.get(name);
            if (!def) throw new Error(`Campo "${name}" no existe`);
            return { id: def.id, field_value: value };
          });
          await writeOne(recordId, fields);
          return recordId;
        }),
      );
      const failures = results
        .map((r, i) =>
          r.status === "rejected"
            ? {
                id: String(updates[i]?.[idKey] ?? ""),
                name: updates[i]?.name as string | undefined,
                error: r.reason instanceof Error ? r.reason.message : String(r.reason),
              }
            : null,
        )
        .filter((f): f is { id: string; name: string | undefined; error: string } => f !== null);
      return NextResponse.json({
        ok: results.filter((r) => r.status === "fulfilled").length,
        failed: failures.length,
        failures,
      });
    }

    if (action === "create_custom_field") {
      const p = payload as Record<string, unknown>;
      try {
        const field = await createCustomFieldDef({
          name: String(p.name),
          dataType: String(p.dataType),
          model: p.objectKey === "opportunity" ? "opportunity" : "contact",
          // Dedup: GHL acepta opciones duplicadas tal cual al crear.
          picklistOptions: Array.isArray(p.options)
            ? dedupeOptions(p.options.map(String))
            : undefined,
        });
        return NextResponse.json({ ok: 1, failed: 0, failures: [], field });
      } catch (e) {
        return NextResponse.json({
          ok: 0,
          failed: 1,
          failures: [{ id: "", error: e instanceof Error ? e.message : String(e) }],
        });
      }
    }

    // update_custom_field: renombra y/o agrega opciones (fusionando, sin borrar).
    const p = payload as Record<string, unknown>;
    const fieldId = String(p.fieldId ?? "");
    const def = defsRaw.customFields.find((d) => d.id === fieldId);
    if (!def)
      return NextResponse.json({
        ok: 0,
        failed: 1,
        failures: [{ id: fieldId, error: "Campo no encontrado" }],
      });

    const upd: { name?: string; picklistOptions?: string[] } = {};
    if (typeof p.name === "string" && p.name.trim()) upd.name = p.name.trim();
    if (Array.isArray(p.addOptions) && p.addOptions.length) {
      const merged = mergePicklistOptions(def.picklistOptions ?? [], p.addOptions.map(String));
      if ("error" in merged)
        return NextResponse.json({
          ok: 0,
          failed: 1,
          failures: [{ id: fieldId, error: merged.error }],
        });
      upd.picklistOptions = merged.merged;
    }
    if (!upd.name && !upd.picklistOptions)
      return NextResponse.json({
        ok: 0,
        failed: 1,
        failures: [{ id: fieldId, error: "Nada que actualizar" }],
      });
    try {
      const field = await updateCustomFieldDef(fieldId, upd);
      return NextResponse.json({ ok: 1, failed: 0, failures: [], field });
    } catch (e) {
      return NextResponse.json({
        ok: 0,
        failed: 1,
        failures: [{ id: fieldId, error: e instanceof Error ? e.message : String(e) }],
      });
    }
  });
}
