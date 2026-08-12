// Tool definitions shared between the /api/chat system prompt and the
// in-browser executor. Tools run client-side against the already-loaded
// dashboard data — no extra GHL calls, no server-side session state.

import type {
  Contact,
  Opportunity,
  Pauta,
  Appointment,
  Message,
  Task,
  Call,
  CustomFieldDef,
} from "@/lib/types";
import { getChatIndex, type ChatIndex } from "@/lib/ai-index";
import { isDePauta, resolveCampaignName } from "@/lib/pauta";
import { buildCsv } from "@/lib/csv";

export interface ChatDataset {
  contacts: Contact[];
  opportunities: Opportunity[];
  pautas: Pauta[];
  appointments: Appointment[];
  messages: Message[];
  tasks: Task[];
  calls: Call[];
  customFieldDefs: CustomFieldDef[];
}

// ─── Chart spec (render_chart tool) ─────────────────────────────────────────────

export interface ChartSeriesPoint {
  label: string;
  value: number;
  /** Records behind this group, for the drill-down drawer. Omit for non-drillable groups (e.g. pure time trends). */
  contactIds?: string[];
}

export interface ChartSpec {
  type: "bar" | "line" | "pie";
  title: string;
  /** Axis/tooltip label, e.g. "Leads" or "Valor (MXN)". */
  valueLabel?: string;
  series: ChartSeriesPoint[];
}

/**
 * Hard cap on contactIds kept per chart group for the drill-down, to bound
 * token cost. The system prompt also instructs the model to send at most this
 * many; this slice is the safety net if it sends more.
 */
export const MAX_CHART_CONTACT_IDS = 50;

/**
 * Safely turn an unknown render_chart tool input into a ChartSpec.
 * Returns null when the shape is unusable so the UI can skip rendering.
 * Truncates each group's contactIds to MAX_CHART_CONTACT_IDS.
 */
export function parseChartSpec(input: unknown): ChartSpec | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const type = o.type;
  if (type !== "bar" && type !== "line" && type !== "pie") return null;
  if (!Array.isArray(o.series)) return null;

  const series: ChartSeriesPoint[] = [];
  for (const raw of o.series) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label : "";
    const value =
      typeof r.value === "number" && Number.isFinite(r.value)
        ? r.value
        : Number(r.value);
    if (!label || !Number.isFinite(value)) continue;
    const contactIds = Array.isArray(r.contactIds)
      ? r.contactIds.map((x) => String(x)).slice(0, MAX_CHART_CONTACT_IDS)
      : undefined;
    series.push({ label, value, contactIds });
  }
  if (series.length === 0) return null;

  return {
    type,
    title: typeof o.title === "string" ? o.title : "",
    valueLabel: typeof o.valueLabel === "string" ? o.valueLabel : undefined,
    series,
  };
}

// ─── Tool schemas (sent to Claude) ────────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: "list_field_definitions",
    description:
      "Lista las definiciones de custom fields editables (de contactos y oportunidades): id, nombre, tipo de dato y opciones válidas. LLAMA ESTO ANTES de escribir un valor o de crear/editar un campo, para usar el id correcto y valores de picklist exactos. Los tipos con opciones (SINGLE_OPTIONS, MULTIPLE_OPTIONS, RADIO, CHECKBOX) solo aceptan valores de su lista.",
    input_schema: {
      type: "object",
      properties: {
        objectKey: {
          type: "string",
          enum: ["contact", "opportunity", "all"],
          description: "Filtra por objeto. 'all' devuelve ambos.",
        },
      },
      required: ["objectKey"],
    },
  },
  {
    name: "list_fields",
    description:
      "Lists the available entities (contacts, opportunities, pautas, appointments, messages) and their queryable fields. Always call this first if you're unsure what fields exist on pautas (custom-object properties vary per location).",
    input_schema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          enum: ["contacts", "opportunities", "pautas", "appointments", "messages", "all"],
          description: "Entity to inspect. Use 'all' to get an overview.",
        },
      },
      required: ["entity"],
    },
  },
  {
    name: "list_values",
    description:
      "Returns the distinct values of a field (with counts) for an entity. USE THIS BEFORE filtering by source/campaign/adType/assignedTo/stage/tipo when you're not 100% sure of the exact value — values can differ in casing or wording between contacts and opportunities. Cheap (just a group-by).",
    input_schema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          enum: ["contacts", "opportunities", "pautas", "appointments"],
        },
        field: {
          type: "string",
          description:
            "Field name to enumerate. Common: source, campaign, adId, attributionUrl, adType, attributionMedium (the real platform: whatsapp/facebook/instagram/tiktok), assignedTo, stage, pipelineName, status, tipo, tags. NOTE: campaign is empty for most leads (esp. WhatsApp/Meta paid) — use adId/attributionUrl to see the real ad/campaign identities. For a custom field (contacts/opportunities), pass 'cf:<Field Name>' (e.g. 'cf:Origen de Lead', 'cf:Servicio Técnico') — multi-option fields fan out per option value. Run this FIRST before filtering by a custom field so you use its exact option values.",
        },
        limit: { type: "number", description: "Max distinct values to return (default 40)." },
      },
      required: ["entity", "field"],
    },
  },
  {
    name: "search_contacts",
    description:
      "Search contacts by name/email/phone substring, tags, source, campaign, adId, attributionUrl (Ad URL), adType, attributionMedium (platform: whatsapp/facebook/instagram/tiktok), assigned advisor, company, or location. Also accepts a contactIds array to resolve a specific set of IDs to names. campaign is usually empty (esp. WhatsApp/Meta paid) — use adId/attributionUrl for the real ad/campaign identity. Filter values are matched case-insensitively. Returns compact rows. Use get_contact for full details.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring match on name, email, or phone (case-insensitive)." },
        contactIds: { type: "array", items: { type: "string" }, description: "Only return contacts whose id is in this list. Use this to resolve a set of contactIds (from appointments, pautas, etc.) into human-readable names — NEVER print raw IDs; call this tool instead." },
        tags: { type: "array", items: { type: "string" }, description: "Filter to contacts having ALL of these tags (case-insensitive)." },
        source: { type: "string", description: "Source match, case-insensitive (e.g. 'meta', 'Paid Social')." },
        campaign: { type: "string", description: "Campaign substring match, case-insensitive. NOTE: the native campaign field is empty for most leads (esp. WhatsApp/Meta paid) — the real ad identity lives in adId/attributionUrl. When the user asks 'por campaña', also break down by adId and attributionUrl." },
        adId: { type: "string", description: "Ad ID match, case-insensitive exact. The Meta/Google ad the lead came from — the de-facto campaign identifier when `campaign` is empty. Discover values with list_values field='adId'." },
        attributionUrl: { type: "string", description: "Attribution / Ad URL substring match, case-insensitive. The landing/ad URL the lead came from — human-readable campaign identity when `campaign` is empty. Discover values with list_values field='attributionUrl'." },
        adType: { type: "string", description: "AdType match, case-insensitive (e.g. 'Paid Social', 'Social media') — paid vs organic, NOT the platform." },
        attributionMedium: { type: "string", description: "Platform/channel the lead came from, case-insensitive exact (e.g. 'whatsapp', 'facebook', 'instagram', 'tiktok'). THIS is the platform — use it for 'por qué plataforma' questions, not tags. Discover exact values with list_values field='attributionMedium'." },
        assignedTo: { type: "string", description: "Advisor name, case-insensitive exact." },
        companyName: { type: "string", description: "Company name substring match, case-insensitive." },
        city: { type: "string", description: "City substring match, case-insensitive." },
        state: { type: "string", description: "State substring match, case-insensitive." },
        country: { type: "string", description: "Country substring match, case-insensitive." },
        dnd: { type: "boolean", description: "Filter by Do Not Disturb status (true = DND on, false = DND off)." },
        customFields: {
          type: "object",
          additionalProperties: true,
          description:
            "Filter by custom fields, keyed by the field's display name: { \"Field Name\": \"value\" } or { \"Field Name\": [\"a\",\"b\"] }. Each field must match (AND); a list of values matches if ANY do (OR). Matching is exact per option value, case-insensitive — multi-option fields match when the option is present. To match records where the field is EMPTY/unset, pass \"(sin valor)\" as the value (the same label list_values returns) — no need to fetch records one by one. Discover exact values with list_values field='cf:<Field Name>'.",
        },
        createdAfter: { type: "string", description: "ISO date — only contacts created on/after this date." },
        createdBefore: { type: "string", description: "ISO date — only contacts created on/before this date." },
        limit: { type: "number", description: "Max rows to return (default 25, max 100)." },
      },
    },
  },
  {
    name: "get_contact",
    description: "Full record for one contact (all fields).",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "get_contact_related",
    description:
      "Fetches related records for one contact from the pre-loaded dashboard data: opportunities, pautas, appointments, messages. NOTE: the `messages` field here is drawn from a recent sample (top conversations per advisor) and may be empty or incomplete for a specific contact. For the actual conversation of a specific contact, ALWAYS prefer `get_contact_messages` which queries GHL live.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Contact id." },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["opportunities", "pautas", "appointments", "messages"] },
          description: "Which kinds to include. Defaults to all.",
        },
        messageLimit: { type: "number", description: "Max messages to return from the in-memory sample (default 20, newest first). For the real conversation, use get_contact_messages." },
      },
      required: ["id"],
    },
  },
  {
    name: "get_contact_messages",
    description:
      "Fetches the live conversation messages for ONE contact directly from Lezgo Suite CRM (bypasses the in-memory sample). Use this whenever the user asks what was said, what messages exist, or to summarize a conversation for a specific contact — even if `get_contact_related` returned 0 messages. Returns up to ~100 messages, newest first.",
    input_schema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "Contact id to fetch the conversation for." },
        limit: { type: "number", description: "Max messages to return (default 50, max 100)." },
      },
      required: ["contactId"],
    },
  },
  {
    name: "search_opportunities",
    description:
      "Search/filter opportunities. Filter values for source/campaign/adId/attributionUrl/adType/assignedTo/stage/pipeline/priority are matched case-insensitively. campaign is usually empty (esp. WhatsApp/Meta paid) — use adId/attributionUrl for the real ad/campaign identity, or the `dePauta` filter for the paid-advertising universe. Each row includes `dePauta` (is it paid advertising?) and `campaignResolved` (best-effort campaign name). Returns compact rows. Use get_opportunity for full details.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring match on opportunity name." },
        contactIds: { type: "array", items: { type: "string" }, description: "Only return opps whose contactId is in this list. Use this to cross-join from appointments/pautas/messages → opportunities via contactId." },
        dePauta: { type: "boolean", description: "Filter to paid-advertising opportunities (\"de pauta\"). true = only opps whose contact is linked to a Pauta record OR that carry a paid-traffic source/medium signal; false = only opps that are NOT de pauta. This is the SAME definition the Marketing dashboard's 'por pauta' charts use. Prefer this over source/campaign guesses when the user asks about pauta / tráfico pagado / anuncios." },
        pipeline: { type: "string", description: "Exact pipeline name." },
        stage: { type: "string", description: "Exact stage name." },
        status: { type: "string", enum: ["open", "won", "lost", "abandoned"] },
        source: { type: "string" },
        campaign: { type: "string", description: "Campaign substring match, case-insensitive. NOTE: usually empty (esp. WhatsApp/Meta paid) — the real ad identity lives in adId/attributionUrl. When the user asks 'por campaña', also break down by adId and attributionUrl." },
        adId: { type: "string", description: "Ad ID match, case-insensitive exact. The de-facto campaign identifier when `campaign` is empty. Discover values with list_values field='adId'." },
        attributionUrl: { type: "string", description: "Attribution / Ad URL substring match, case-insensitive. Human-readable campaign identity when `campaign` is empty. Discover values with list_values field='attributionUrl'." },
        attributionMedium: { type: "string", description: "Platform/channel the opportunity's lead came from, case-insensitive exact (e.g. 'whatsapp', 'facebook', 'instagram', 'tiktok'). Use it for platform questions, not tags." },
        assignedTo: { type: "string" },
        priority: { type: "string", description: "Priority filter, case-insensitive (e.g. 'high', 'medium', 'low')." },
        archived: { type: "boolean", description: "Filter by archived status. Omit to include all." },
        minValue: { type: "number" },
        maxValue: { type: "number" },
        minProbability: { type: "number", description: "Minimum probability (0–100)." },
        maxProbability: { type: "number", description: "Maximum probability (0–100)." },
        customFields: {
          type: "object",
          additionalProperties: true,
          description:
            "Filter by custom fields, keyed by the field's display name: { \"Field Name\": \"value\" } or { \"Field Name\": [\"a\",\"b\"] }. Each field must match (AND); a list of values matches if ANY do (OR). Matching is exact per option value, case-insensitive. To match opportunities where the field is EMPTY/unset, pass \"(sin valor)\" as the value (the same label list_values returns) — do this in ONE call instead of fetching each opportunity with get_opportunity. Discover exact values with list_values field='cf:<Field Name>'.",
        },
        createdAfter: { type: "string", description: "ISO date — only opps created on/after this date." },
        createdBefore: { type: "string", description: "ISO date — only opps created on/before this date." },
        closedAfter: { type: "string", description: "ISO date — only opps closed on/after this date." },
        closedBefore: { type: "string", description: "ISO date — only opps closed on/before this date." },
        limit: { type: "number", description: "Max rows to return (default 25, max 100)." },
      },
    },
  },
  {
    name: "get_opportunity",
    description: "Full record for one opportunity.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "search_pautas",
    description: "Search pautas (custom objects). Returns compact rows. Use get_pauta for full custom properties.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring match on nombrePauta or tipo." },
        tipo: { type: "string", description: "Exact tipo match." },
        contactId: { type: "string", description: "Only pautas linked to this contact." },
        createdAfter: { type: "string", description: "ISO date — only pautas created on/after this date." },
        createdBefore: { type: "string", description: "ISO date — only pautas created on/before this date." },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "get_pauta",
    description: "Full record for one pauta including all custom properties.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_appointments",
    description: "List appointments (full history, past and upcoming). Returns compact rows.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Exact status match (e.g. 'confirmed', 'showed', 'no_show')." },
        assignedTo: { type: "string" },
        contactId: { type: "string" },
        startAfter: { type: "string", description: "ISO date — appointments starting on/after." },
        startBefore: { type: "string", description: "ISO date — appointments starting on/before." },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "aggregate",
    description:
      "Deterministic counts/sums/averages. USE THIS for any numeric question — do not eyeball counts from search results. Filter values for source/campaign/adType/assignedTo/stage/pipeline/tipo/status are matched case-insensitively. Returns { groups: [{ key, count, sum?, avg?, contactIds? }], total }. To build a DRILLABLE chart, set includeContactIds: true and feed each group's key→label, count→value, contactIds straight into render_chart — this is ONE call; do NOT follow up with per-group search_contacts.",
    input_schema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          enum: ["contacts", "opportunities", "pautas", "appointments", "tasks"],
        },
        groupBy: {
          type: "string",
          description:
            "Field to group by. Common: 'source', 'campaign', 'adId', 'attributionUrl', 'adType', 'attributionMedium' (the real platform — whatsapp/facebook/instagram/tiktok; use THIS for 'leads por plataforma', not tags), 'assignedTo', 'status', 'stage', 'pipelineName', 'priority', 'archived', 'companyName', 'city', 'state', 'country', 'tipo', 'tags' (tags fans out per tag). Opportunities also support 'dePauta' (true/false — paid-advertising universe) and 'campaignResolved' (best-effort campaign name via the fallback chain — PREFER this over raw 'campaign' for 'por campaña' breakdowns of pauta). Tasks: 'status' (pending/completed), 'assignedTo', 'assignedToName'. CAMPAIGN questions: raw 'campaign' is empty for most leads (esp. WhatsApp/Meta paid), so a groupBy:'campaign' typically returns only '(sin valor)' — use 'campaignResolved' instead, or ALSO group by 'adId' and 'attributionUrl' which hold the real ad/campaign identity. To group by a custom field (contacts/opportunities) use 'cf:<Field Name>' (e.g. 'cf:Servicio Técnico', 'cf:Origen de Lead') — multi-option fields fan out per option value. Use 'none' for a single total.",
        },
        metric: {
          type: "string",
          enum: ["count", "sum", "avg"],
          description: "'sum' and 'avg' apply to opportunity.value only.",
        },
        filters: {
          type: "object",
          description:
            "Optional filters: same keys as search_* tools. Contacts: source, campaign, adId, attributionUrl, adType, attributionMedium, assignedTo, tags, companyName, city, state, country, dnd, customFields, createdAfter, createdBefore, contactIds (array). Opportunities: dePauta (boolean — paid-advertising universe), status, source, campaign, adId, attributionUrl, attributionMedium, assignedTo, stage, pipeline, priority, archived, minValue, maxValue, minProbability, maxProbability, customFields, createdAfter, createdBefore, closedAfter, closedBefore, contactIds (array — use to cross-join from appointments/pautas). Pautas: tipo, contactId, createdAfter, createdBefore. Appointments: status, assignedTo, startAfter, startBefore. Tasks: status (pending/completed), assignedTo, contactId, contactIds, dueAfter, dueBefore, overdue (boolean). customFields is an object { \"Field Name\": \"value\" | [\"a\",\"b\"] } matched exactly per option (case-insensitive); pass \"(sin valor)\" to match records where the field is empty/unset.",
          additionalProperties: true,
        },
        includeContactIds: {
          type: "boolean",
          description:
            "When true, each group also includes a `contactIds` array (distinct, capped at 50) with the contacts behind it. Set this for drillable charts so you can pass the ids straight into render_chart in ONE call — avoid following up with per-group search_contacts. Leave off (default false) for pure numeric questions to keep the response small.",
        },
        limit: { type: "number", description: "Max groups to return (default 50)." },
      },
      required: ["entity", "groupBy", "metric"],
    },
  },
  {
    name: "export_csv",
    description:
      "Exports a filtered dataset to a CSV file that the user can download. Call this when the user asks to export, download, or save data to a file. Always run a search_* or aggregate call first to confirm what data exists, then call export_csv with the same entity and filters. NEVER pass rows directly — only pass entity + filters.",
    input_schema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          enum: ["contacts", "opportunities", "appointments", "pautas", "tasks"],
          description: "The entity to export.",
        },
        filters: {
          type: "object",
          description:
            "Optional filters — same keys as the corresponding search_* tool. Contacts: source, campaign, adId, attributionUrl, adType, attributionMedium, assignedTo, tags, companyName, city, state, country, dnd, customFields, createdAfter, createdBefore, contactIds. Opportunities: dePauta (boolean — paid-advertising universe), status, source, campaign, adId, attributionUrl, attributionMedium, assignedTo, stage, pipeline, priority, archived, minValue, maxValue, minProbability, maxProbability, customFields, createdAfter, createdBefore, closedAfter, closedBefore, contactIds. Pautas: tipo, contactId, createdAfter, createdBefore. Appointments: status, assignedTo, startAfter, startBefore. customFields is an object { \"Field Name\": \"value\" | [\"a\",\"b\"] } matched exactly per option (case-insensitive); pass \"(sin valor)\" to match records where the field is empty/unset.",
          additionalProperties: true,
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional subset of column names to include. Defaults to all standard columns for the entity.",
        },
        filename: {
          type: "string",
          description:
            "Suggested base filename without extension (e.g. 'contactos-meta-mayo'). Defaults to '{entity}-{YYYY-MM-DD}'.",
        },
      },
      required: ["entity"],
    },
  },
  {
    name: "search_conversations",
    description:
      "Fetches conversation message threads for a list of contacts from Lezgo Suite CRM. Always derive contactIds first using list_appointments, search_contacts, search_opportunities, or other tools — never ask the user for IDs. May take several seconds for large batches. Returns up to `messageLimit` messages per contact (newest first), content truncated to 500 chars. Each thread reports `messageCount` (messages returned) and `hasMore` (true when older messages exist beyond this slice). When `hasMore` is true you have only seen a partial, recent sample — do NOT infer a loss reason, churn cause, or root cause from it; pull the full history with get_contact_messages for that contact first. For a single contact's conversation, use get_contact_messages instead.",
    input_schema: {
      type: "object",
      properties: {
        contactIds: {
          type: "array",
          items: { type: "string" },
          description:
            "List of contact IDs to fetch conversation threads for. Derive these from other tool calls such as list_appointments, search_contacts, or search_opportunities.",
        },
        limit: {
          type: "number",
          description: "Max number of contacts to process (default 30, max 50).",
        },
        messageLimit: {
          type: "number",
          description: "Max messages to return per thread (default 100).",
        },
      },
      required: ["contactIds"],
    },
  },
  {
    name: "search_tasks",
    description:
      "Search and filter tasks from the indexed dataset. Returns title, status (pending/completed), dueDate, assignedToName, contactId. Use for bulk queries: pending tasks, overdue follow-ups, tasks per advisor, task completion rate. For a single contact's freshest tasks, use get_contact_tasks (live GHL).",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "completed"], description: "Filter by task status." },
        assignedTo: { type: "string", description: "Filter by assignee name (case-insensitive substring match on assignedToName)." },
        contactId: { type: "string", description: "Filter to tasks of a single contact." },
        contactIds: { type: "array", items: { type: "string" }, description: "Filter to tasks belonging to any of these contacts." },
        dueAfter: { type: "string", description: "ISO date — tasks with dueDate on or after this date." },
        dueBefore: { type: "string", description: "ISO date — tasks with dueDate on or before this date." },
        overdue: { type: "boolean", description: "When true, return only pending tasks whose dueDate is in the past." },
        limit: { type: "number", description: "Max tasks to return (default 50)." },
      },
      required: [],
    },
  },
  {
    name: "get_contact_tasks",
    description:
      "Fetches the latest tasks for a single contact directly from Lezgo Suite CRM (live, always fresh). Returns task title, due date, status (completed/pending), and assigned user. Use for a single contact's full task history. For bulk queries across many contacts, use search_tasks or aggregate(entity:'tasks') instead. Always resolve the contactId first with search_contacts if you only have a name.",
    input_schema: {
      type: "object",
      properties: {
        contactId: {
          type: "string",
          description: "Contact ID to fetch tasks for.",
        },
      },
      required: ["contactId"],
    },
  },
  {
    name: "get_contact_notes",
    description:
      "Fetches all advisor-written notes for a contact from Lezgo Suite CRM. Notes are internal observations — NOT chat messages. Use when the user asks what was noted, observed, or documented about a contact, or to cross-reference notes against the conversation.",
    input_schema: {
      type: "object",
      properties: {
        contactId: {
          type: "string",
          description: "Contact ID to fetch notes for.",
        },
      },
      required: ["contactId"],
    },
  },
  {
    name: "relate",
    description:
      "Cross-entity join through the shared contact — THE one tool for any question that links appointments, pautas, opportunities, or contacts to each other (e.g. '¿cuánto valen las citas de mayo?', '¿qué ventas ganadas vinieron de la pauta X?'). It filters the `from` set, hops to the SAME contacts' `to` records, applies `to` filters, and aggregates — all in ONE call. NEVER hand-roll this by extracting contactIds and calling aggregate/search yourself; that is slow and expensive. Returns { groups, total, matchedContacts, contactIds? }. matchedContacts = distinct contacts that have BOTH a `from` and a `to` record.",
    input_schema: {
      type: "object",
      properties: {
        from: {
          type: "object",
          description: "Anchor set. { entity, filters? }.",
          properties: {
            entity: {
              type: "string",
              enum: ["contacts", "opportunities", "pautas", "appointments", "tasks"],
            },
            filters: {
              type: "object",
              additionalProperties: true,
              description:
                "Same filter keys as search_<entity>/aggregate. Appointments: status, assignedTo, startAfter, startBefore. Pautas: tipo, contactId, createdAfter, createdBefore. Opportunities: dePauta (boolean — paid-advertising universe), status, source, campaign, adId, attributionUrl, attributionMedium, assignedTo, stage, pipeline, priority, archived, minValue, maxValue, minProbability, maxProbability, customFields, createdAfter, createdBefore, closedAfter, closedBefore. Contacts: source, campaign, adId, attributionUrl, adType, attributionMedium, assignedTo, tags, companyName, city, state, country, dnd, customFields, createdAfter, createdBefore. Tasks: status, assignedTo, contactIds, dueAfter, dueBefore, overdue. customFields (contacts/opportunities) is an object { \"Field Name\": \"value\" | [\"a\",\"b\"] }; pass \"(sin valor)\" to match records where the field is empty/unset.",
            },
          },
          required: ["entity"],
        },
        to: {
          type: "object",
          description: "Related set, reached via the shared contact. { entity, filters? }.",
          properties: {
            entity: {
              type: "string",
              enum: ["contacts", "opportunities", "pautas", "appointments", "tasks"],
            },
            filters: {
              type: "object",
              additionalProperties: true,
              description: "Same filter keys as search_<entity>/aggregate (see from.filters), including customFields for contacts/opportunities.",
            },
          },
          required: ["entity"],
        },
        metric: {
          type: "string",
          enum: ["count", "sum", "avg"],
          description: "Aggregation over the `to` set. 'sum'/'avg' apply to opportunity.value only. Use 'count' otherwise.",
        },
        groupBy: {
          type: "string",
          description:
            "Optional field on the `to` entity to group by (e.g. 'status', 'stage', 'source', 'assignedTo', or 'cf:<Field Name>' for a custom field). Omit (or 'none') for a single total.",
        },
        includeContactIds: {
          type: "boolean",
          description:
            "When true, also returns the matched contactIds (capped at `limit`) so you can chain show_in_panel or a live per-contact fetch (get_contact_tasks/get_contact_notes/get_contact_messages). Default false — leave off for pure numeric questions to keep the response small.",
        },
        limit: {
          type: "number",
          description: "Max groups and max contactIds returned (default 50).",
        },
      },
      required: ["from", "to", "metric"],
    },
  },
  {
    name: "show_in_panel",
    description:
      "Displays a curated set of contacts in the left context panel so the user can see and click them. CRITICAL: call this as your FINAL step whenever your answer is about a specific set of contacts (e.g. 'leads con actividad hoy', 'contactos sin responder', 'clientes de Meta'). Pass ONLY the contactIds you are actually reporting in your answer — NOT every contact you inspected while researching. The panel must match your conclusion: if you tell the user about 4 leads, pass those 4 ids, not the 20 you scanned. The panel resolves names, opportunity value, and lets the user open each contact. This tool does not return data — it only updates the UI.",
    input_schema: {
      type: "object",
      properties: {
        contactIds: {
          type: "array",
          items: { type: "string" },
          description:
            "The exact contact IDs your answer is about. These are shown, in this order, in the panel.",
        },
        title: {
          type: "string",
          description:
            "Short heading describing the set, in Spanish (e.g. 'Leads con actividad hoy', 'Sin responder +24h · Meta'). Shown at the top of the panel.",
        },
      },
      required: ["contactIds"],
    },
  },
  {
    name: "render_chart",
    description:
      "Renders a visual chart inline in the chat. Use it ONLY when the user asks for a chart, or when it genuinely adds value — a comparison across several groups or a trend over time. Do NOT chart single numbers, short lists, or one-contact profiles. Call it as your FINAL step. CRITICAL: every `value` MUST come from a prior `aggregate` or `relate` call — NEVER invent or eyeball numbers. To make the chart drillable, include `contactIds` on each group with the contacts behind that bar/slice — get them in ONE call from `aggregate({ ..., includeContactIds: true })` (preferred — the groups already carry contactIds) or `relate({ ..., includeContactIds: true })`, NOT from per-group `search_*` calls; include AT MOST 50 per group (the system truncates to 50 and tells the user the drill-down is limited). Groups without contactIds render but are not clickable. Always also give a one-line text summary alongside the chart.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["bar", "line", "pie"],
          description:
            "bar = counts/sums by group; line = a trend over ordered time buckets; pie = share of a total.",
        },
        title: {
          type: "string",
          description: "Short heading in Spanish shown above the chart (e.g. 'Leads por fuente').",
        },
        valueLabel: {
          type: "string",
          description: "What the numbers represent, e.g. 'Leads', 'Oportunidades', 'Valor (MXN)'. Shown in the tooltip.",
        },
        series: {
          type: "array",
          description: "The data points. One entry per bar/slice/point.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Group name (e.g. 'Meta', 'Semana 22', 'Primera Cita')." },
              value: { type: "number", description: "The real number from aggregate/relate for this group." },
              contactIds: {
                type: "array",
                items: { type: "string" },
                description: "The contacts behind this group, for drill-down (max 50). Omit when not contact-backed.",
              },
            },
            required: ["label", "value"],
          },
        },
      },
      required: ["type", "title", "series"],
    },
  },
  {
    name: "create_pdf",
    description:
      "Genera un documento PDF descargable con el branding de Lezgo Suite (portada, encabezado y pie automáticos). Úsalo cuando el usuario pida un reporte, documento o PDF descargable. COMPÓN el documento SOLO con datos que YA obtuviste en esta conversación — NO hagas llamadas extra solo para el PDF. Reutiliza los `series` de tus `aggregate`/`relate` previos en los bloques `chart` (misma forma que render_chart). NUNCA escribas 'GoHighLevel' ni 'GHL' (se reescriben a 'Lezgo Suite CRM'). El branding (colores, portada, header/footer) es automático: tú solo envías contenido. Es tu paso FINAL; después confirma al usuario el nombre del archivo.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Título de la portada (requerido)." },
        accent: { type: "string", description: "Línea naranja adicional en la portada (ej. 'Mayo 2026')." },
        client: { type: "string", description: "Nombre del cliente/empresa; aparece en la caja naranja de portada." },
        subtitle: { type: "string", description: "Descripción breve de la portada." },
        cover: { type: "boolean", description: "Incluir portada. Default true. Usa false para un documento interno corto." },
        blocks: {
          type: "array",
          description:
            "Contenido del documento, en orden. Cada bloque se discrimina por `t`: heading {t,text}, subheading {t,text}, text {t,text} (acepta **negrita**), bullets {t,items[]}, kpis {t,items:[{label,value}]}, table {t,headers[],rows[][]}, callout {t,style:'info|warn|ok|error',text}, chart (ver abajo).",
          items: {
            type: "object",
            properties: {
              t: {
                type: "string",
                enum: ["heading", "subheading", "text", "bullets", "kpis", "table", "callout", "chart"],
              },
              text: { type: "string", description: "Para heading/subheading/text/callout." },
              items: {
                type: "array",
                description: "bullets: array de strings. kpis: array de {label,value} (strings).",
              },
              style: { type: "string", enum: ["info", "warn", "ok", "error"], description: "Solo callout." },
              headers: { type: "array", items: { type: "string" }, description: "Solo table." },
              rows: { type: "array", description: "Solo table: array de filas; cada fila es array de strings." },
              type: { type: "string", enum: ["bar", "pie", "line"], description: "Solo chart." },
              title: { type: "string", description: "Solo chart: título de la gráfica." },
              valueLabel: { type: "string", description: "Solo chart: qué representan los números." },
              orientation: { type: "string", enum: ["h", "v"], description: "Solo chart bar: 'h' = barras horizontales." },
              stacked: { type: "boolean", description: "Solo chart bar/line multi-serie: apilar. Default agrupado." },
              categories: { type: "array", items: { type: "string" }, description: "Solo chart multi-serie: etiquetas del eje X." },
              series: {
                type: "array",
                description:
                  "chart simple: [{label,value}] (igual que render_chart). chart multi-serie (con categories): [{name, values:[number]}] alineado por índice a categories.",
              },
            },
            required: ["t"],
          },
        },
      },
      required: ["title", "blocks"],
    },
  },
  {
    name: "list_uploaded_files",
    description:
      "Lists the tabular files (CSV/Excel) the user has attached in this conversation, with their fileId, filename, row count and column schema. Call this first when the user refers to 'el archivo', 'el Excel', 'el CSV' or 'los datos que subí' and you need the fileId to query it. Images and PDFs are already visible in the message and are NOT listed here.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "query_uploaded_table",
    description:
      "Queries the FULL rows of one attached tabular file (not just the sample shown in the message). Use for any question about the file's own content: filtering, counting, summing, averaging, grouping, or listing rows. Get the fileId from list_uploaded_files or from the attachment summary in the message.",
    input_schema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The file to query (from list_uploaded_files)." },
        filter: {
          type: "object",
          additionalProperties: true,
          description:
            "Optional exact-match filters, keyed by column name: { \"Estado\": \"Activo\" }. Case-insensitive equality on the string form of each cell. Multiple keys are AND'd.",
        },
        groupBy: { type: "string", description: "Optional column to group by. Omit for a single total." },
        metric: { type: "string", enum: ["count", "sum", "avg"], description: "Aggregation. Default count. sum/avg require metricColumn." },
        metricColumn: { type: "string", description: "Numeric column for sum/avg." },
        columns: { type: "array", items: { type: "string" }, description: "Optional projection for the returned sample rows." },
        limit: { type: "number", description: "Max sample rows / groups to return (default 25, max 100)." },
      },
      required: ["fileId"],
    },
  },
  {
    name: "join_uploaded_table",
    description:
      "Cross-references a column of an attached tabular file against the CRM's contacts or opportunities, in ONE call. Use for questions like 'de estos emails del Excel, cuáles ya son contactos' or 'estos teléfonos, cuáles no están en el CRM'. Returns matched/unmatched counts and a capped sample. Resolve names via search_contacts if you need to display them.",
    input_schema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The attached file (from list_uploaded_files)." },
        tableColumn: { type: "string", description: "Column in the file to match on (e.g. 'email', 'telefono')." },
        entity: { type: "string", enum: ["contacts", "opportunities"], description: "CRM entity to match against." },
        entityField: {
          type: "string",
          description:
            "Field on the CRM entity to match. Contacts: 'email' | 'phone' | 'name' | 'id'. Opportunities: 'name' | 'contactId' | 'id'.",
        },
        mode: { type: "string", enum: ["matched", "unmatched", "both"], description: "Which table rows to report. Default 'both'." },
        limit: { type: "number", description: "Max sample rows per bucket (default 25, max 100)." },
      },
      required: ["fileId", "tableColumn", "entity", "entityField"],
    },
  },
  {
    name: "ask_user",
    description:
      "Hace UNA pregunta de opción múltiple al usuario y PAUSA hasta que responda. Úsalo SOLO cuando un término sea genuinamente ambiguo entre rutas de datos distintas que darían respuestas materialmente diferentes y el contexto no lo aclare (ver la sección 'Cuándo preguntar' del prompt). Llama esta herramienta SOLA (sin otras herramientas en el mismo turno). NO la uses para ambigüedades triviales ni si el usuario ya especificó la ruta — en esos casos elige el valor por defecto y dilo en una línea.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "La pregunta, en español, breve y concreta.",
        },
        context: {
          type: "string",
          description:
            "Opcional. Una sola línea de 'por qué pregunto' que se muestra bajo la pregunta para orientar al usuario.",
        },
        multiSelect: {
          type: "boolean",
          description:
            "Si es true, el usuario puede elegir varias opciones (chips + botón Confirmar). Default false (elige una sola).",
        },
        options: {
          type: "array",
          description: "Las opciones a mostrar. 2 a 4 idealmente.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Texto del botón/chip (en español)." },
              value: {
                type: "string",
                description:
                  "Opcional. Valor que se te reporta de vuelta. Si se omite, se usa el label.",
              },
              hint: { type: "string", description: "Opcional. Subtítulo de una línea." },
            },
            required: ["label"],
          },
        },
      },
      required: ["question", "options"],
    },
  },
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

// Herramientas de ESCRITURA — solo se envían al modelo con el modo edición
// activo, y CADA UNA pasa por la puerta de confirmación en use-agent-loop.ts.
// WRITE_TOOLS se DERIVA de este arreglo: agregar una tool aquí la registra
// automáticamente en la puerta (No-negociable 2 — no se puede desincronizar).
export const WRITE_TOOL_DEFINITIONS = [
  {
    name: "set_contact_fields",
    description:
      "Cambia valores de custom fields en uno o varios contactos (hasta 50). Un elemento por contacto; cada 'fields' mapea nombre de campo -> valor. Para campos con opciones usa un valor exacto de la lista (ver list_field_definitions). Requiere confirmación del usuario.",
    input_schema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              contactId: { type: "string" },
              fields: {
                type: "object",
                description: "nombre de campo -> valor (string o lista para multi-opción)",
              },
            },
            required: ["contactId", "fields"],
          },
        },
      },
      required: ["updates"],
    },
  },
  {
    name: "set_opportunity_fields",
    description:
      "Cambia valores de custom fields en una o varias oportunidades (hasta 50). Igual que set_contact_fields pero con opportunityId. Requiere confirmación del usuario.",
    input_schema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              opportunityId: { type: "string" },
              fields: { type: "object" },
            },
            required: ["opportunityId", "fields"],
          },
        },
      },
      required: ["updates"],
    },
  },
  {
    name: "create_custom_field",
    description:
      "Crea una definición de custom field nueva en el objeto contact u opportunity. Para tipos con opciones (SINGLE_OPTIONS, MULTIPLE_OPTIONS, RADIO) incluye 'options'. Requiere confirmación del usuario.",
    input_schema: {
      type: "object",
      properties: {
        objectKey: { type: "string", enum: ["contact", "opportunity"] },
        name: { type: "string" },
        dataType: {
          type: "string",
          enum: ["TEXT", "LARGE_TEXT", "NUMERICAL", "SINGLE_OPTIONS", "MULTIPLE_OPTIONS", "DATE", "RADIO", "CHECKBOX"],
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Solo para tipos con opciones.",
        },
      },
      required: ["objectKey", "name", "dataType"],
    },
  },
  {
    name: "update_custom_field",
    description:
      "Edita una definición de campo existente: renómbrala (name) y/o AGREGA opciones (addOptions). NO puede quitar ni borrar opciones. Requiere confirmación del usuario.",
    input_schema: {
      type: "object",
      properties: {
        fieldId: { type: "string" },
        name: { type: "string", description: "Nuevo nombre (opcional)." },
        addOptions: {
          type: "array",
          items: { type: "string" },
          description: "Opciones a agregar (opcional).",
        },
      },
      required: ["fieldId"],
    },
  },
] as const;

export const WRITE_TOOLS = new Set<string>(WRITE_TOOL_DEFINITIONS.map((t) => t.name));

// ─── Executor ─────────────────────────────────────────────────────────────────

type ToolInput = Record<string, unknown>;
type ToolOutput = unknown;

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function clampLimit(n: unknown, def = DEFAULT_LIMIT): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : def;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(v)));
}

// Parse an ISO date filter bound to a millisecond timestamp. A date-only string
// ("2026-05-31") is interpreted in local time; upper ("before") bounds are pushed
// to the end of that day so a date-only `*Before` includes records from anywhere
// on that day instead of cutting off at local midnight. Strings carrying a time
// component are parsed as-is.
function dateBound(s: string, end: boolean): number {
  const trimmed = s.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (m) {
    const [, y, mo, d] = m;
    return end
      ? new Date(+y, +mo - 1, +d, 23, 59, 59, 999).getTime()
      : new Date(+y, +mo - 1, +d, 0, 0, 0, 0).getTime();
  }
  return new Date(trimmed).getTime();
}

const startBound = (s: string): number => dateBound(s, false);
const endBound = (s: string): number => dateBound(s, true);

function lc(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function includesAll<T>(haystack: T[], needles: T[]): boolean {
  return needles.every((n) => haystack.includes(n));
}

function ieq(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function isub(haystack: unknown, needle: unknown): boolean {
  if (haystack === undefined || haystack === null || needle === undefined || needle === null) return false;
  return String(haystack).toLowerCase().includes(String(needle).toLowerCase());
}

function includesAllCI(haystack: string[], needles: string[]): boolean {
  const lower = haystack.map((h) => h.toLowerCase());
  return needles.every((n) => lower.includes(n.toLowerCase()));
}

// ─── custom-field helpers ──────────────────────────────────────────────────────
// `customFieldsResolved` is a name→value map. Single-value fields are stored as
// a string; multi-option / checkbox fields keep their array shape. These helpers
// normalize both so contacts and opportunities can be filtered, grouped, and
// enumerated by any custom field — accessed via the `customFields` filter and the
// `cf:<Field Name>` (alias `customField:<Field Name>`) group/field convention.

type CustomFieldsResolved = Record<string, string | string[]> | undefined;

// Case-insensitive lookup of a custom-field value by display name.
function cfLookup(resolved: CustomFieldsResolved, name: string): string | string[] | undefined {
  if (!resolved) return undefined;
  if (name in resolved) return resolved[name];
  const target = name.trim().toLowerCase();
  for (const k of Object.keys(resolved)) {
    if (k.toLowerCase() === target) return resolved[k];
  }
  return undefined;
}

// Normalize a resolved custom-field value to a flat array of trimmed strings.
function cfValues(resolved: CustomFieldsResolved, name: string): string[] {
  const v = cfLookup(resolved, name);
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s)).filter((s) => s.trim() !== "");
}

// If `field`/`groupBy` is "cf:Name" or "customField:Name", return the field name.
function customFieldName(spec: string): string | null {
  const m = /^(?:cf|customField):(.+)$/.exec(spec);
  return m ? m[1].trim() : null;
}

// Sentinel values that mean "this custom field has no value". `list_values` and
// `aggregate` groupBy both emit "(sin valor)" as the empty bucket, so honoring it
// here lets the model filter empty fields in one call instead of fanning out to
// per-record get_opportunity / get_contact lookups.
const EMPTY_CF_SENTINELS = new Set(["(sin valor)", ""]);

// Apply a `customFields` filter object: { "Field Name": "value" | ["a","b"] }.
// Each field entry must match (AND); within a field, any listed value matches
// (OR). Matching is exact per option value, case-insensitive. The sentinel
// "(sin valor)" matches records where the field is empty/unset, so empty and
// real values can be OR'd together (e.g. ["(sin valor)", "Estándar"]).
function matchesCustomFields(resolved: CustomFieldsResolved, filter: unknown): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return true;
  for (const [name, want] of Object.entries(filter as Record<string, unknown>)) {
    if (want === undefined || want === null) continue;
    const needles = (Array.isArray(want) ? want : [want]).map((n) => String(n).trim().toLowerCase());
    if (needles.length === 0) continue;
    const have = cfValues(resolved, name).map((v) => v.toLowerCase());
    if (have.length === 0) {
      // Field is empty — matches only if the filter explicitly asks for empty.
      if (!needles.some((n) => EMPTY_CF_SENTINELS.has(n))) return false;
      continue;
    }
    // Field has values — match any requested real value (sentinels never match a
    // real value, so they're harmless inside an OR list).
    if (!needles.some((n) => have.includes(n))) return false;
  }
  return true;
}

function compactContact(c: Contact) {
  return {
    id: c.id,
    name: c.name,
    email: c.email || undefined,
    phone: c.phone || undefined,
    companyName: c.companyName || undefined,
    city: c.city || undefined,
    state: c.state || undefined,
    country: c.country || undefined,
    tags: c.tags?.length ? c.tags : undefined,
    source: c.source,
    campaign: c.campaign || undefined,
    adType: c.adType || undefined,
    attributionMedium: c.attributionMedium || undefined,
    assignedTo: c.assignedTo,
    dnd: c.dnd || undefined,
    lastActivity: c.lastActivity || undefined,
    createdAt: c.createdAt,
  };
}

function compactOpp(o: Opportunity, index: ChatIndex) {
  return {
    id: o.id,
    name: o.name,
    contactId: o.contactId,
    pipeline: o.pipelineName,
    stage: o.stage,
    status: o.status,
    value: o.value,
    currency: o.currency || undefined,
    probability: o.probability ?? undefined,
    priority: o.priority || undefined,
    closedAt: o.closedAt || undefined,
    archived: o.archived || undefined,
    source: o.source || undefined,
    campaign: o.campaign || undefined,
    // Whether this opp counts as paid-advertising ("de pauta"): contact linked to
    // a Pauta record OR paid-traffic source signal. Same rule as the dashboard.
    dePauta: isDePauta(o, index.pautasByContact),
    // Campaign name resolved through the full fallback chain (campaignName →
    // "Nombre pauta" custom field → utmContent → first Pauta record).
    campaignResolved: campaignTitle(resolveCampaignName(o, index.pautaNameByContact)),
    adType: o.adType || undefined,
    attributionMedium: o.attributionMedium || undefined,
    assignedTo: o.assignedTo,
    lostReason: o.lostReason || undefined,
    notes: o.notes ? (o.notes.length > 200 ? o.notes.slice(0, 200) + "…" : o.notes) : undefined,
    lastActivity: o.lastActivity || undefined,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt || undefined,
  };
}

function oppRollup(
  contactId: string | undefined,
  index: ChatIndex
): { oppCount: number; oppValueSum: number } {
  if (!contactId) return { oppCount: 0, oppValueSum: 0 };
  const opps = index.oppsByContact.get(contactId) ?? [];
  let sum = 0;
  for (const o of opps) sum += typeof o.value === "number" ? o.value : 0;
  return { oppCount: opps.length, oppValueSum: sum };
}

// Strip " - URL - NUMERIC_ID" suffix from nombrePauta (e.g. "TITLE - https://... - 120241019662550611")
// so the AI sees only the campaign title in compact results and aggregate keys.
function campaignTitle(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const idx = s.indexOf(" - http");
  return idx !== -1 ? s.slice(0, idx).trim() : s;
}

function compactPauta(p: Pauta, index: ChatIndex) {
  return {
    id: p.id,
    tipo: p.tipo,
    nombre: campaignTitle(p.nombrePauta),
    contactId: p.contactId,
    createdAt: p.createdAt,
    ...oppRollup(p.contactId, index),
  };
}

function compactAppt(a: Appointment, index: ChatIndex) {
  return {
    id: a.id,
    contactId: a.contactId,
    assignedTo: a.assignedTo,
    title: a.title,
    startTime: a.startTime,
    status: a.status,
    location: a.location,
    ...oppRollup(a.contactId, index),
  };
}

function compactMessage(m: Message) {
  return {
    id: m.id,
    contactId: m.contactId,
    direction: m.direction,
    source: m.source,
    content: m.content ? (m.content.length > 280 ? m.content.slice(0, 280) + "…" : m.content) : undefined,
    createdAt: m.createdAt,
  };
}

export function executeTool(
  name: string,
  input: ToolInput,
  data: ChatDataset
): ToolOutput {
  switch (name) {
    case "list_field_definitions":
      return listFieldDefinitions(input, data);
    case "list_fields":
      return listFields(input, data);
    case "list_values":
      return listValues(input, data);
    case "search_tasks":
      return searchTasks(input, data);
    case "search_contacts":
      return searchContacts(input, data);
    case "get_contact":
      return getContact(input, data);
    case "get_contact_related":
      return getContactRelated(input, data, getChatIndex(data));
    case "search_opportunities":
      return searchOpportunities(input, data);
    case "get_opportunity":
      return getOpportunity(input, data);
    case "search_pautas":
      return searchPautas(input, data, getChatIndex(data));
    case "get_pauta":
      return getPauta(input, data);
    case "list_appointments":
      return listAppointments(input, data, getChatIndex(data));
    case "aggregate":
      return aggregate(input, data);
    case "relate":
      return relate(input, data, getChatIndex(data));
    case "show_in_panel": {
      // UI-only directive. The real panel update happens client-side in the
      // chat component's onToolExecuted handler (it reads contactIds from the
      // tool input). Here we just acknowledge so the model knows it succeeded.
      const ids = Array.isArray(input.contactIds) ? (input.contactIds as string[]) : [];
      return { ok: true, shown: ids.length };
    }
    case "render_chart": {
      // UI-only directive. The chart is rendered client-side from the tool_use
      // block in conversations-chat.tsx. Here we just acknowledge.
      const series = Array.isArray((input as Record<string, unknown>).series)
        ? ((input as Record<string, unknown>).series as unknown[])
        : [];
      return { ok: true, points: series.length };
    }
    case "ask_user":
      // UI-only / loop-intercepted. The agent loop pauses on this tool and never
      // calls the executor in practice; this ack only exists so an unexpected
      // execution path still yields a valid tool_result.
      return { ok: true, pending: true };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── CSV export ───────────────────────────────────────────────────────────────

export interface ExportCsvResult {
  csvContent: string;
  filename: string;
  rowCount: number;
}

const CSV_COLUMNS: Record<string, string[]> = {
  contacts: [
    "name", "email", "phone", "companyName", "city", "state", "country",
    "source", "campaign", "adType", "attributionMedium", "assignedTo", "tags", "dnd", "createdAt",
  ],
  opportunities: [
    "name", "contactId", "pipeline", "stage", "status", "value", "currency",
    "probability", "priority", "source", "campaign", "adType", "attributionMedium", "assignedTo",
    "closedAt", "lostReason", "createdAt",
  ],
  appointments: ["contactId", "assignedTo", "title", "status", "location", "startTime"],
  pautas: ["id", "tipo", "nombrePauta", "contactId", "createdAt"],
  tasks: ["id", "title", "status", "dueDate", "assignedToName", "contactId", "contactName", "createdAt"],
};

export function executeExportCsv(input: ToolInput, data: ChatDataset): ExportCsvResult {
  const entity = String(input.entity ?? "");
  const filters = (
    input.filters && typeof input.filters === "object" ? input.filters : {}
  ) as ToolInput;
  const userColumns = Array.isArray(input.columns) ? (input.columns as string[]) : null;
  const today = new Date().toISOString().slice(0, 10);
  const baseFilename =
    typeof input.filename === "string" && input.filename.trim()
      ? input.filename.trim().replace(/\.csv$/i, "")
      : `${entity}-${today}`;
  const filename = `${baseFilename}.csv`;

  let headers: string[];
  let rows: Array<Record<string, unknown>>;

  switch (entity) {
    case "contacts": {
      const filtered = applyContactFilters(data.contacts, filters);
      headers = userColumns ?? CSV_COLUMNS.contacts;
      rows = filtered.map((c) => ({
        name: c.name,
        email: c.email ?? "",
        phone: c.phone ?? "",
        companyName: c.companyName ?? "",
        city: c.city ?? "",
        state: c.state ?? "",
        country: c.country ?? "",
        source: c.source ?? "",
        campaign: c.campaign ?? "",
        adType: c.adType ?? "",
        attributionMedium: c.attributionMedium ?? "",
        assignedTo: c.assignedTo ?? "",
        tags: (c.tags ?? []).join("|"),
        dnd: c.dnd ? "true" : "false",
        createdAt: c.createdAt,
      }));
      break;
    }
    case "opportunities": {
      const filtered = applyOppFilters(data.opportunities, filters, getChatIndex(data));
      headers = userColumns ?? CSV_COLUMNS.opportunities;
      rows = filtered.map((o) => ({
        name: o.name,
        contactId: o.contactId,
        pipeline: o.pipelineName ?? "",
        stage: o.stage ?? "",
        status: o.status,
        value: o.value,
        currency: o.currency ?? "",
        probability: o.probability ?? "",
        priority: o.priority ?? "",
        source: o.source ?? "",
        campaign: o.campaign ?? "",
        adType: o.adType ?? "",
        attributionMedium: o.attributionMedium ?? "",
        assignedTo: o.assignedTo ?? "",
        closedAt: o.closedAt ?? "",
        lostReason: o.lostReason ?? "",
        createdAt: o.createdAt,
      }));
      break;
    }
    case "appointments": {
      const filtered = applyApptFilters(data.appointments, filters);
      headers = userColumns ?? CSV_COLUMNS.appointments;
      rows = filtered.map((a) => ({
        contactId: a.contactId,
        assignedTo: a.assignedTo ?? "",
        title: a.title ?? "",
        status: a.status,
        location: a.location ?? "",
        startTime: a.startTime,
      }));
      break;
    }
    case "pautas": {
      const filtered = applyPautaFilters(data.pautas, filters);
      const propKeys = new Set<string>();
      for (const p of filtered) {
        if (p.properties) for (const k of Object.keys(p.properties)) propKeys.add(k);
      }
      const propCols = Array.from(propKeys).sort();
      headers = userColumns ?? [...CSV_COLUMNS.pautas, ...propCols];
      rows = filtered.map((p) => {
        const base: Record<string, unknown> = {
          id: p.id,
          tipo: p.tipo ?? "",
          nombrePauta: p.nombrePauta ?? "",
          contactId: p.contactId ?? "",
          createdAt: p.createdAt,
        };
        for (const k of propCols) {
          base[k] = p.properties?.[k] ?? "";
        }
        return base;
      });
      break;
    }
    case "tasks": {
      const filtered = applyTaskFilters(data.tasks, filters);
      headers = userColumns ?? CSV_COLUMNS.tasks;
      rows = filtered.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dueDate: t.dueDate ?? "",
        assignedToName: t.assignedToName ?? "",
        contactId: t.contactId,
        contactName: t.contactName ?? "",
        createdAt: t.createdAt ?? "",
      }));
      break;
    }
    default:
      return { csvContent: "", filename, rowCount: 0 };
  }

  return { csvContent: buildCsv(headers, rows), filename, rowCount: rows.length };
}

// ─── list_fields ──────────────────────────────────────────────────────────────

function listFieldDefinitions(input: ToolInput, data: ChatDataset): ToolOutput {
  const objectKey = typeof input.objectKey === "string" ? input.objectKey : "all";
  const defs = data.customFieldDefs.filter(
    (d) => objectKey === "all" || d.objectKey === objectKey,
  );
  return {
    count: defs.length,
    fields: defs.map((d) => ({
      id: d.id,
      name: d.name,
      objectKey: d.objectKey,
      dataType: d.dataType,
      options: d.picklistOptions ?? undefined,
    })),
  };
}

function listFields(input: ToolInput, data: ChatDataset) {
  const entity = String(input.entity ?? "all");

  // Collect pauta custom-field keys from observed properties
  const pautaPropKeys = new Set<string>();
  for (const p of data.pautas) {
    if (p.properties) {
      for (const k of Object.keys(p.properties)) pautaPropKeys.add(k);
    }
  }

  const all = {
    contacts: {
      fields: [
        "id", "name", "firstName", "lastName", "email", "phone", "companyName",
        "city", "state", "country", "address1", "postalCode", "timezone", "website",
        "tags", "source", "campaign", "adType", "adId", "attributionMedium", "attributionUrl", "assignedTo",
        "dateOfBirth", "lastActivity", "dateAdded", "createdAt", "dateUpdated",
        "dnd", "type", "customFields", "customFieldsResolved", "attributionSource", "attributions",
      ],
      note: "attributionMedium is the REAL platform/channel a lead came from — values like 'whatsapp', 'facebook', 'instagram', 'tiktok'. For ANY 'por qué plataforma / canal' question (Facebook vs Instagram vs TikTok vs WhatsApp), group by 'attributionMedium' — NEVER infer the platform from tags, which only cover a fraction of leads. adType distinguishes paid vs organic ('Paid Social' vs 'Social media'); combine the two for a full picture. customFieldsResolved is a name→value object with human-readable field names (e.g. {\"Origen de Lead\": \"Facebook\"}); multi-option/checkbox fields hold a string[] (e.g. {\"Origen de Lead\": [\"Facebook\",\"Instagram\"]}). To filter, pass customFields: { \"Field Name\": \"value\" } to search_contacts/aggregate; to group or enumerate, use 'cf:<Field Name>'. Run list_values field='cf:<Field Name>' first to see exact option values.",
      count: data.contacts.length,
    },
    opportunities: {
      fields: [
        "id", "name", "contactId", "pipelineId", "pipelineName", "stage", "status",
        "value", "monetaryValue", "currency", "probability",
        "source", "campaign", "campaignResolved", "dePauta", "adType", "adId", "attributionMedium", "attributionUrl", "assignedTo", "tags", "priority",
        "closedAt", "createdAt", "updatedAt", "lastActivity",
        "lostReason", "lostReasonId", "notes", "archived", "origin",
        "campaignId", "funnelId", "workflowId", "customFields", "customFieldsResolved", "attributions",
      ],
      note: "dePauta (boolean) marks paid-advertising opps — the SAME 'de pauta' rule the Marketing dashboard uses (contact linked to a Pauta record OR paid-traffic source signal); filter with dePauta:true/false and group with groupBy:'dePauta'. campaignResolved is the best-effort campaign name (campaignName → 'Nombre pauta' custom field → utmContent → first Pauta record) — prefer it over raw 'campaign' for 'por campaña' breakdowns. attributionMedium is the REAL platform/channel the opportunity's lead came from — values like 'whatsapp', 'facebook', 'instagram', 'tiktok'. For any 'por qué plataforma / canal' question, group by 'attributionMedium' — NEVER infer the platform from tags. adType distinguishes paid vs organic. customFieldsResolved is a name→value object with human-readable field names (e.g. {\"Usuarios Contratados\": \"10\", \"Servicio Técnico\": \"Estándar\"}); multi-option fields hold a string[]. To filter, pass customFields: { \"Field Name\": \"value\" } to search_opportunities/aggregate; to group or enumerate, use 'cf:<Field Name>'. Run list_values field='cf:<Field Name>' first to see exact option values.",
      count: data.opportunities.length,
    },
    pautas: {
      fields: ["id", "tipo", "nombrePauta", "contactId", "createdAt"],
      customProperties: Array.from(pautaPropKeys).sort(),
      count: data.pautas.length,
    },
    appointments: {
      fields: ["id", "contactId", "assignedTo", "title", "startTime", "endTime", "status", "notes"],
      count: data.appointments.length,
      note: "Full history, past and upcoming.",
    },
    messages: {
      fields: ["id", "contactId", "conversationId", "assignedTo", "direction", "source", "content", "createdAt"],
      count: data.messages.length,
      note: "Sample of recent conversations per advisor, not exhaustive.",
    },
  };

  if (entity === "all") return all;
  return (all as Record<string, unknown>)[entity] ?? { error: `Unknown entity: ${entity}` };
}

// ─── list_values ──────────────────────────────────────────────────────────────

function listValues(input: ToolInput, data: ChatDataset) {
  const entity = String(input.entity ?? "");
  const field = String(input.field ?? "");
  const limit = clampLimit(input.limit, 40);

  let rows: Array<Record<string, unknown>>;
  switch (entity) {
    case "contacts":
      rows = data.contacts as unknown as Array<Record<string, unknown>>;
      break;
    case "opportunities":
      rows = data.opportunities as unknown as Array<Record<string, unknown>>;
      break;
    case "pautas":
      rows = data.pautas as unknown as Array<Record<string, unknown>>;
      break;
    case "appointments":
      rows = data.appointments as unknown as Array<Record<string, unknown>>;
      break;
    default:
      return { error: `Unknown entity: ${entity}` };
  }

  const cfName = customFieldName(field);
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (cfName) {
      const vals = cfValues(r.customFieldsResolved as CustomFieldsResolved, cfName);
      if (vals.length === 0) counts.set("(sin valor)", (counts.get("(sin valor)") ?? 0) + 1);
      for (const item of vals) counts.set(item, (counts.get(item) ?? 0) + 1);
      continue;
    }
    const v = r[field];
    if (Array.isArray(v)) {
      if (v.length === 0) counts.set("(sin valor)", (counts.get("(sin valor)") ?? 0) + 1);
      for (const item of v) {
        const k = item === null || item === undefined || item === "" ? "(sin valor)" : String(item);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    } else {
      const raw2 = v === null || v === undefined || v === "" ? "(sin valor)" : String(v);
      const k = raw2.includes(" - http") ? (campaignTitle(raw2) ?? raw2) : raw2;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }

  const values = Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  return {
    field,
    entity,
    distinct: values.length,
    values: values.slice(0, limit),
    truncated: values.length > limit,
  };
}

// ─── search_contacts ──────────────────────────────────────────────────────────

function searchContacts(input: ToolInput, data: ChatDataset) {
  const q = lc(input.query);
  const contactIds = Array.isArray(input.contactIds) ? new Set(input.contactIds as string[]) : undefined;
  const tags = Array.isArray(input.tags) ? (input.tags as string[]) : undefined;
  const source = typeof input.source === "string" ? input.source : undefined;
  const campaign = typeof input.campaign === "string" ? input.campaign : undefined;
  const adId = typeof input.adId === "string" ? input.adId : undefined;
  const attributionUrl = typeof input.attributionUrl === "string" ? input.attributionUrl : undefined;
  const adType = typeof input.adType === "string" ? input.adType : undefined;
  const attributionMedium = typeof input.attributionMedium === "string" ? input.attributionMedium : undefined;
  const assignedTo = typeof input.assignedTo === "string" ? input.assignedTo : undefined;
  const companyName = typeof input.companyName === "string" ? input.companyName : undefined;
  const city = typeof input.city === "string" ? input.city : undefined;
  const state = typeof input.state === "string" ? input.state : undefined;
  const country = typeof input.country === "string" ? input.country : undefined;
  const dnd = typeof input.dnd === "boolean" ? input.dnd : undefined;
  const customFields = input.customFields && typeof input.customFields === "object" ? input.customFields : undefined;
  const after = typeof input.createdAfter === "string" ? startBound(input.createdAfter) : undefined;
  const before = typeof input.createdBefore === "string" ? endBound(input.createdBefore) : undefined;
  const limit = clampLimit(input.limit);

  const out: Contact[] = [];
  for (const c of data.contacts) {
    if (contactIds && !contactIds.has(c.id)) continue;
    if (q) {
      const hay = `${lc(c.name)} ${lc(c.email)} ${lc(c.phone)}`;
      if (!hay.includes(q)) continue;
    }
    if (tags?.length && !includesAllCI(c.tags ?? [], tags)) continue;
    if (source && !ieq(c.source, source)) continue;
    if (campaign && !isub(c.campaign, campaign)) continue;
    if (adId && !ieq(c.adId, adId)) continue;
    if (attributionUrl && !isub(c.attributionUrl, attributionUrl)) continue;
    if (adType && !ieq(c.adType, adType)) continue;
    if (attributionMedium && !ieq(c.attributionMedium, attributionMedium)) continue;
    if (assignedTo && !ieq(c.assignedTo, assignedTo)) continue;
    if (companyName && !isub(c.companyName, companyName)) continue;
    if (city && !isub(c.city, city)) continue;
    if (state && !isub(c.state, state)) continue;
    if (country && !isub(c.country, country)) continue;
    if (dnd !== undefined && Boolean(c.dnd) !== dnd) continue;
    if (customFields && !matchesCustomFields(c.customFieldsResolved, customFields)) continue;
    if (after !== undefined && +new Date(c.createdAt) < after) continue;
    if (before !== undefined && +new Date(c.createdAt) > before) continue;
    out.push(c);
    if (out.length > limit) break;
  }
  const truncated = out.length > limit;
  const rows = truncated ? out.slice(0, limit) : out;
  return {
    rows: rows.map(compactContact),
    returned: rows.length,
    truncated,
  };
}

function getContact(input: ToolInput, data: ChatDataset) {
  const id = String(input.id ?? "");
  const c = data.contacts.find((x) => x.id === id);
  return c ?? { error: `Contact not found: ${id}` };
}

// ─── get_contact_related ──────────────────────────────────────────────────────

function getContactRelated(input: ToolInput, data: ChatDataset, index: ChatIndex) {
  const id = String(input.id ?? "");
  const c = data.contacts.find((x) => x.id === id);
  if (!c) return { error: `Contact not found: ${id}` };

  const kinds = Array.isArray(input.kinds) && input.kinds.length > 0
    ? (input.kinds as string[])
    : ["opportunities", "pautas", "appointments", "messages"];
  const messageLimit = clampLimit(input.messageLimit, 20);

  const result: Record<string, unknown> = { contact: c };

  if (kinds.includes("opportunities")) {
    result.opportunities = data.opportunities
      .filter((o) => o.contactId === id)
      .map((o) => compactOpp(o, index));
  }
  if (kinds.includes("pautas")) {
    result.pautas = data.pautas
      .filter((p) => p.contactId === id)
      .map((p) => compactPauta(p, index));
  }
  if (kinds.includes("appointments")) {
    result.appointments = data.appointments
      .filter((a) => a.contactId === id)
      .map((a) => compactAppt(a, index));
  }
  if (kinds.includes("messages")) {
    const msgs = data.messages
      .filter((m) => m.contactId === id)
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, messageLimit);
    result.messages = msgs.map(compactMessage);
  }

  return result;
}

// ─── opportunities ────────────────────────────────────────────────────────────

function searchOpportunities(input: ToolInput, data: ChatDataset) {
  const index = getChatIndex(data);
  const q = lc(input.query);
  const limit = clampLimit(input.limit);

  // All structured filters (incl. dePauta + resolved-campaign) live in the shared
  // applyOppFilters; only the free-text name query is search-specific.
  const filtered = applyOppFilters(data.opportunities, input, index)
    .filter((o) => !q || lc(o.name).includes(q));
  const truncated = filtered.length > limit;
  const rows = truncated ? filtered.slice(0, limit) : filtered;
  return {
    rows: rows.map((o) => compactOpp(o, index)),
    returned: rows.length,
    truncated,
  };
}

function getOpportunity(input: ToolInput, data: ChatDataset) {
  const id = String(input.id ?? "");
  const o = data.opportunities.find((x) => x.id === id);
  return o ?? { error: `Opportunity not found: ${id}` };
}

// ─── pautas ───────────────────────────────────────────────────────────────────

function searchPautas(input: ToolInput, data: ChatDataset, index: ChatIndex) {
  const q = lc(input.query);
  const tipo = typeof input.tipo === "string" ? input.tipo : undefined;
  const contactId = typeof input.contactId === "string" ? input.contactId : undefined;
  const limit = clampLimit(input.limit);

  const out: Pauta[] = [];
  for (const p of data.pautas) {
    if (q) {
      const hay = `${lc(p.nombrePauta)} ${lc(p.tipo)}`;
      if (!hay.includes(q)) continue;
    }
    if (tipo && p.tipo !== tipo) continue;
    if (contactId && p.contactId !== contactId) continue;
    out.push(p);
    if (out.length > limit) break;
  }
  const truncated = out.length > limit;
  const rows = truncated ? out.slice(0, limit) : out;
  return {
    rows: rows.map((p) => compactPauta(p, index)),
    returned: rows.length,
    truncated,
  };
}

function getPauta(input: ToolInput, data: ChatDataset) {
  const id = String(input.id ?? "");
  const p = data.pautas.find((x) => x.id === id);
  return p ?? { error: `Pauta not found: ${id}` };
}

// ─── appointments ─────────────────────────────────────────────────────────────

function listAppointments(input: ToolInput, data: ChatDataset, index: ChatIndex) {
  const status = typeof input.status === "string" ? input.status : undefined;
  const assignedTo = typeof input.assignedTo === "string" ? input.assignedTo : undefined;
  const contactId = typeof input.contactId === "string" ? input.contactId : undefined;
  const after = typeof input.startAfter === "string" ? startBound(input.startAfter) : undefined;
  const before = typeof input.startBefore === "string" ? endBound(input.startBefore) : undefined;
  const limit = clampLimit(input.limit);

  const out: Appointment[] = [];
  for (const a of data.appointments) {
    if (status && a.status !== status) continue;
    if (assignedTo && a.assignedTo !== assignedTo) continue;
    if (contactId && a.contactId !== contactId) continue;
    if (after !== undefined || before !== undefined) {
      const t = +new Date(a.startTime);
      if (after !== undefined && t < after) continue;
      if (before !== undefined && t > before) continue;
    }
    out.push(a);
    if (out.length > limit) break;
  }
  const truncated = out.length > limit;
  const rows = truncated ? out.slice(0, limit) : out;
  return {
    rows: rows.map((a) => compactAppt(a, index)),
    returned: rows.length,
    truncated,
  };
}

// ─── aggregate ────────────────────────────────────────────────────────────────

// Resolve an entity + filters to filtered rows. Shared by `aggregate` and `relate`.
function filteredRows(
  entity: string,
  filters: ToolInput,
  data: ChatDataset
): Array<Record<string, unknown>> {
  switch (entity) {
    case "contacts":
      return applyContactFilters(data.contacts, filters) as unknown as Array<Record<string, unknown>>;
    case "opportunities": {
      const index = getChatIndex(data);
      // Enrich each opp row with the computed dePauta flag and resolved campaign so
      // aggregate/relate can groupBy: "dePauta" or "campaignResolved" directly.
      return applyOppFilters(data.opportunities, filters, index).map((o) => ({
        ...o,
        dePauta: isDePauta(o, index.pautasByContact),
        campaignResolved: campaignTitle(resolveCampaignName(o, index.pautaNameByContact)),
      })) as unknown as Array<Record<string, unknown>>;
    }
    case "pautas":
      return applyPautaFilters(data.pautas, filters) as unknown as Array<Record<string, unknown>>;
    case "appointments":
      return applyApptFilters(data.appointments, filters) as unknown as Array<Record<string, unknown>>;
    case "tasks":
      return applyTaskFilters(data.tasks, filters) as unknown as Array<Record<string, unknown>>;
    default:
      return [];
  }
}

// Group + metric over already-filtered rows. Shared by `aggregate` and `relate`.
function aggregateRows(
  rows: Array<Record<string, unknown>>,
  groupBy: string,
  metric: string,
  entity: string,
  limit: number,
  includeContactIds = false
) {
  if (groupBy === "none") {
    return {
      groups: [{
        key: "total",
        count: rows.length,
        ...metricValue(rows, metric, entity),
        ...(includeContactIds ? { contactIds: contactIdsOf(entity, rows) } : {}),
      }],
      total: rows.length,
      truncated: false,
    };
  }

  const cfName = customFieldName(groupBy);
  const buckets = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    if (cfName) {
      // group by a custom field — fan out per option value (multi-option fields)
      const vals = cfValues(r.customFieldsResolved as CustomFieldsResolved, cfName);
      if (vals.length === 0) push(buckets, "(sin valor)", r);
      else for (const v of vals) push(buckets, v, r);
      continue;
    }
    const raw = r[groupBy];
    if (groupBy === "tags" && Array.isArray(raw)) {
      // fan out per tag
      if (raw.length === 0) push(buckets, "(sin tag)", r);
      for (const t of raw) push(buckets, String(t), r);
    } else {
      const rawStr = raw === undefined || raw === null || raw === "" ? "(sin valor)" : String(raw);
      // Strip URL+ID suffix from nombrePauta-style values ("TITLE - https://... - ID")
      const key = rawStr.includes(" - http") ? (campaignTitle(rawStr) ?? rawStr) : rawStr;
      push(buckets, key, r);
    }
  }

  const groups = Array.from(buckets.entries())
    .map(([key, items]) => ({
      key,
      count: items.length,
      ...metricValue(items, metric, entity),
      ...(includeContactIds ? { contactIds: contactIdsOf(entity, items) } : {}),
    }))
    .sort((a, b) => {
      const av = metric === "count" ? a.count : (a as { sum?: number; avg?: number }).sum ?? (a as { avg?: number }).avg ?? 0;
      const bv = metric === "count" ? b.count : (b as { sum?: number; avg?: number }).sum ?? (b as { avg?: number }).avg ?? 0;
      return bv - av;
    })
    .slice(0, limit);

  return { groups, total: rows.length, truncated: buckets.size > limit };
}

function aggregate(input: ToolInput, data: ChatDataset) {
  const entity = String(input.entity ?? "");
  const groupBy = String(input.groupBy ?? "none");
  const metric = String(input.metric ?? "count");
  const filters = (input.filters && typeof input.filters === "object" ? input.filters : {}) as ToolInput;
  const limit = clampLimit(input.limit, 50);
  const includeContactIds = input.includeContactIds === true;

  if (!["contacts", "opportunities", "pautas", "appointments", "tasks"].includes(entity)) {
    return { error: `Unknown entity: ${entity}` };
  }

  const rows = filteredRows(entity, filters, data);
  return aggregateRows(rows, groupBy, metric, entity, limit, includeContactIds);
}

// ─── relate (cross-entity join through the shared contact) ──────────────────────

const RELATABLE = ["contacts", "opportunities", "pautas", "appointments", "tasks"];

function contactIdOf(entity: string, row: Record<string, unknown>): string | undefined {
  if (entity === "contacts") return typeof row.id === "string" ? row.id : undefined;
  return typeof row.contactId === "string" ? row.contactId : undefined;
}

// Distinct contactIds behind a set of rows, capped at MAX_CHART_CONTACT_IDS so an
// `aggregate({ includeContactIds: true })` response stays small enough to feed
// straight into a drillable render_chart without a follow-up search_* call.
function contactIdsOf(entity: string, rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const cid = contactIdOf(entity, r);
    if (cid) {
      seen.add(cid);
      if (seen.size >= MAX_CHART_CONTACT_IDS) break;
    }
  }
  return Array.from(seen);
}

// Gather rows of `entity` whose contact is in `contactIds`, using the index.
function rowsForContacts(
  entity: string,
  contactIds: Set<string>,
  index: ChatIndex
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  switch (entity) {
    case "contacts":
      for (const id of contactIds) {
        const c = index.contactById.get(id);
        if (c) out.push(c as unknown as Record<string, unknown>);
      }
      break;
    case "opportunities":
      for (const id of contactIds) {
        const arr = index.oppsByContact.get(id);
        if (arr) for (const o of arr) out.push(o as unknown as Record<string, unknown>);
      }
      break;
    case "pautas":
      for (const id of contactIds) {
        const arr = index.pautasByContact.get(id);
        if (arr) for (const p of arr) out.push(p as unknown as Record<string, unknown>);
      }
      break;
    case "appointments":
      for (const id of contactIds) {
        const arr = index.apptsByContact.get(id);
        if (arr) for (const a of arr) out.push(a as unknown as Record<string, unknown>);
      }
      break;
    case "tasks":
      for (const id of contactIds) {
        const arr = index.tasksByContact.get(id);
        if (arr) for (const t of arr) out.push(t as unknown as Record<string, unknown>);
      }
      break;
  }
  return out;
}

function applyEntityFilters(
  entity: string,
  rows: Array<Record<string, unknown>>,
  filters: ToolInput,
  index: ChatIndex
): Array<Record<string, unknown>> {
  switch (entity) {
    case "contacts":
      return applyContactFilters(rows as unknown as Contact[], filters) as unknown as Array<Record<string, unknown>>;
    case "opportunities":
      return applyOppFilters(rows as unknown as Opportunity[], filters, index) as unknown as Array<Record<string, unknown>>;
    case "pautas":
      return applyPautaFilters(rows as unknown as Pauta[], filters) as unknown as Array<Record<string, unknown>>;
    case "appointments":
      return applyApptFilters(rows as unknown as Appointment[], filters) as unknown as Array<Record<string, unknown>>;
    case "tasks":
      return applyTaskFilters(rows as unknown as Task[], filters) as unknown as Array<Record<string, unknown>>;
    default:
      return rows;
  }
}

function relate(input: ToolInput, data: ChatDataset, index: ChatIndex) {
  const from = (input.from && typeof input.from === "object" ? input.from : {}) as ToolInput;
  const to = (input.to && typeof input.to === "object" ? input.to : {}) as ToolInput;
  const fromEntity = String(from.entity ?? "");
  const toEntity = String(to.entity ?? "");
  const metric = String(input.metric ?? "count");
  const groupBy = String(input.groupBy ?? "none");
  const includeContactIds = input.includeContactIds === true;
  const limit = clampLimit(input.limit, 50);

  if (!RELATABLE.includes(fromEntity)) return { error: `Unknown from.entity: ${fromEntity}` };
  if (!RELATABLE.includes(toEntity)) return { error: `Unknown to.entity: ${toEntity}` };

  const fromFilters = (from.filters && typeof from.filters === "object" ? from.filters : {}) as ToolInput;
  const toFilters = (to.filters && typeof to.filters === "object" ? to.filters : {}) as ToolInput;

  // 1. anchor set
  const fromRows = filteredRows(fromEntity, fromFilters, data);

  // 2. contacts of the anchor set
  const contactIds = new Set<string>();
  for (const r of fromRows) {
    const cid = contactIdOf(fromEntity, r);
    if (cid) contactIds.add(cid);
  }

  // 3. related rows via index, then 4. apply to-filters
  const related = rowsForContacts(toEntity, contactIds, index);
  const toRows = applyEntityFilters(toEntity, related, toFilters, index);

  // 5. aggregate
  const agg = aggregateRows(toRows, groupBy, metric, toEntity, limit);

  // distinct contacts present on BOTH sides (the join count)
  const matched = new Set<string>();
  for (const r of toRows) {
    const cid = contactIdOf(toEntity, r);
    if (cid) matched.add(cid);
  }

  const result: Record<string, unknown> = { ...agg, matchedContacts: matched.size };
  if (includeContactIds) result.contactIds = Array.from(matched).slice(0, limit);
  return result;
}

function push<T>(map: Map<string, T[]>, key: string, val: T) {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

function metricValue(
  rows: Array<Record<string, unknown>>,
  metric: string,
  entity: string
): Record<string, number> {
  if (metric === "count") return {};
  if (entity !== "opportunities") return {}; // sum/avg only meaningful on value
  const values = rows.map((r) => (typeof r.value === "number" ? r.value : 0));
  const sum = values.reduce((acc, v) => acc + v, 0);
  if (metric === "sum") return { sum };
  if (metric === "avg") return { avg: values.length ? sum / values.length : 0 };
  return {};
}

// Shared filter helpers used by aggregate
function applyContactFilters(rows: Contact[], f: ToolInput): Contact[] {
  const contactIdSet = Array.isArray(f.contactIds) ? new Set(f.contactIds as string[]) : undefined;
  return rows.filter((c) => {
    if (contactIdSet && !contactIdSet.has(c.id)) return false;
    if (typeof f.source === "string" && !ieq(c.source, f.source)) return false;
    if (typeof f.campaign === "string" && !isub(c.campaign, f.campaign)) return false;
    if (typeof f.adId === "string" && !ieq(c.adId, f.adId)) return false;
    if (typeof f.attributionUrl === "string" && !isub(c.attributionUrl, f.attributionUrl)) return false;
    if (typeof f.adType === "string" && !ieq(c.adType, f.adType)) return false;
    if (typeof f.attributionMedium === "string" && !ieq(c.attributionMedium, f.attributionMedium)) return false;
    if (typeof f.assignedTo === "string" && !ieq(c.assignedTo, f.assignedTo)) return false;
    if (Array.isArray(f.tags) && !includesAllCI(c.tags ?? [], f.tags as string[])) return false;
    if (typeof f.companyName === "string" && !isub(c.companyName, f.companyName)) return false;
    if (typeof f.city === "string" && !isub(c.city, f.city)) return false;
    if (typeof f.state === "string" && !isub(c.state, f.state)) return false;
    if (typeof f.country === "string" && !isub(c.country, f.country)) return false;
    if (typeof f.dnd === "boolean" && Boolean(c.dnd) !== f.dnd) return false;
    if (f.customFields && !matchesCustomFields(c.customFieldsResolved, f.customFields)) return false;
    if (typeof f.createdAfter === "string" && +new Date(c.createdAt) < startBound(f.createdAfter)) return false;
    if (typeof f.createdBefore === "string" && +new Date(c.createdAt) > endBound(f.createdBefore)) return false;
    return true;
  });
}

function applyOppFilters(rows: Opportunity[], f: ToolInput, index: ChatIndex): Opportunity[] {
  const contactIdSet = Array.isArray(f.contactIds) ? new Set(f.contactIds as string[]) : undefined;
  return rows.filter((o) => {
    if (contactIdSet && !contactIdSet.has(o.contactId)) return false;
    if (typeof f.dePauta === "boolean" && isDePauta(o, index.pautasByContact) !== f.dePauta) return false;
    if (typeof f.pipeline === "string" && !ieq(o.pipelineName, f.pipeline)) return false;
    if (typeof f.stage === "string" && !ieq(o.stage, f.stage)) return false;
    if (typeof f.status === "string" && !ieq(o.status, f.status)) return false;
    if (typeof f.source === "string" && !ieq(o.source, f.source)) return false;
    // Match the campaign filter against BOTH the raw joined campaign and the
    // resolved name (utmCampaign → "Nombre pauta" CF → utmContent → Pauta record).
    if (typeof f.campaign === "string" &&
        !isub(o.campaign, f.campaign) &&
        !isub(resolveCampaignName(o, index.pautaNameByContact), f.campaign)) return false;
    if (typeof f.adId === "string" && !ieq(o.adId, f.adId)) return false;
    if (typeof f.attributionUrl === "string" && !isub(o.attributionUrl, f.attributionUrl)) return false;
    if (typeof f.adType === "string" && !ieq(o.adType, f.adType)) return false;
    if (typeof f.attributionMedium === "string" && !ieq(o.attributionMedium, f.attributionMedium)) return false;
    if (typeof f.assignedTo === "string" && !ieq(o.assignedTo, f.assignedTo)) return false;
    if (typeof f.priority === "string" && !ieq(o.priority, f.priority)) return false;
    if (typeof f.archived === "boolean" && Boolean(o.archived) !== f.archived) return false;
    if (typeof f.minValue === "number" && o.value < f.minValue) return false;
    if (typeof f.maxValue === "number" && o.value > f.maxValue) return false;
    if (typeof f.minProbability === "number" && (o.probability ?? 0) < f.minProbability) return false;
    if (typeof f.maxProbability === "number" && (o.probability ?? 100) > f.maxProbability) return false;
    if (f.customFields && !matchesCustomFields(o.customFieldsResolved, f.customFields)) return false;
    if (typeof f.createdAfter === "string" && +new Date(o.createdAt) < startBound(f.createdAfter)) return false;
    if (typeof f.createdBefore === "string" && +new Date(o.createdAt) > endBound(f.createdBefore)) return false;
    if (typeof f.closedAfter === "string") {
      if (!o.closedAt || +new Date(o.closedAt) < startBound(f.closedAfter)) return false;
    }
    if (typeof f.closedBefore === "string") {
      if (!o.closedAt || +new Date(o.closedAt) > endBound(f.closedBefore)) return false;
    }
    return true;
  });
}

function applyPautaFilters(rows: Pauta[], f: ToolInput): Pauta[] {
  return rows.filter((p) => {
    if (typeof f.tipo === "string" && !ieq(p.tipo, f.tipo)) return false;
    if (typeof f.contactId === "string" && p.contactId !== f.contactId) return false;
    if (typeof f.createdAfter === "string" && +new Date(p.createdAt) < startBound(f.createdAfter)) return false;
    if (typeof f.createdBefore === "string" && +new Date(p.createdAt) > endBound(f.createdBefore)) return false;
    return true;
  });
}

function applyApptFilters(rows: Appointment[], f: ToolInput): Appointment[] {
  return rows.filter((a) => {
    if (typeof f.status === "string" && !ieq(a.status, f.status)) return false;
    if (typeof f.assignedTo === "string" && !ieq(a.assignedTo, f.assignedTo)) return false;
    if (typeof f.startAfter === "string" && +new Date(a.startTime) < startBound(f.startAfter)) return false;
    if (typeof f.startBefore === "string" && +new Date(a.startTime) > endBound(f.startBefore)) return false;
    return true;
  });
}

function applyTaskFilters(rows: Task[], f: ToolInput): Task[] {
  const contactIds = Array.isArray(f.contactIds) ? new Set(f.contactIds as string[]) : undefined;
  return rows.filter((t) => {
    if (typeof f.status === "string" && !ieq(t.status, f.status)) return false;
    if (typeof f.assignedTo === "string" && !isub(t.assignedToName, f.assignedTo)) return false;
    if (typeof f.contactId === "string" && t.contactId !== f.contactId) return false;
    if (contactIds && !contactIds.has(t.contactId)) return false;
    if (typeof f.dueAfter === "string" && t.dueDate && +new Date(t.dueDate) < startBound(f.dueAfter)) return false;
    if (typeof f.dueBefore === "string" && t.dueDate && +new Date(t.dueDate) > endBound(f.dueBefore)) return false;
    if (f.overdue === true && !(t.status === "pending" && t.dueDate && +new Date(t.dueDate) < Date.now())) return false;
    return true;
  });
}

function searchTasks(input: ToolInput, data: ChatDataset) {
  const limit = clampLimit(input.limit);
  const filtered = applyTaskFilters(data.tasks, input);
  const truncated = filtered.length > limit;
  const rows = truncated ? filtered.slice(0, limit) : filtered;
  return {
    rows: rows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueDate: t.dueDate ?? null,
      assignedToName: t.assignedToName ?? null,
      contactId: t.contactId,
      contactName: t.contactName ?? null,
      createdAt: t.createdAt ?? null,
    })),
    returned: rows.length,
    truncated,
  };
}
