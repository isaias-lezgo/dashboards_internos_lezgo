// Internal types — full GHL API shape + computed/resolved additions.
// Fields marked "computed" are added by the dashboard API route (not from GHL directly).

export interface Contact {
  // Always present (normalized by transform)
  id: string
  name: string
  email: string
  phone: string
  tags: string[]
  dateAdded: string
  createdAt: string   // computed: alias for dateAdded

  // GHL Contact fields
  locationId?: string
  firstName?: string
  lastName?: string
  emailLowerCase?: string
  timezone?: string
  companyName?: string
  dnd?: boolean
  dndSettings?: Record<string, unknown>
  type?: string
  address1?: string
  city?: string
  state?: string
  country?: string
  postalCode?: string
  website?: string
  dateOfBirth?: string
  dateUpdated?: string
  lastActivity?: string
  customFields?: Array<{ id: string; value: string }>
  // computed: name→value resolved custom fields. Multi-option/checkbox fields
  // keep their array shape; single-value fields are stored as a plain string.
  customFieldsResolved?: Record<string, string | string[]>
  businessId?: string
  visitorId?: string
  keyword?: string
  firstNameLowerCase?: string
  fullNameLowerCase?: string
  lastNameLowerCase?: string
  attachments?: unknown[]
  ssn?: string
  assignedTo?: string   // GHL field; resolved to user name by transform
  attributionSource?: { [key: string]: string | undefined }
  lastAttributionSource?: { [key: string]: string | undefined }
  attributions?: Array<{ [key: string]: unknown }>

  // Computed attribution (derived from attributions array)
  source?: string
  campaign?: string
  campaignName?: string // computed: utmCampaign alone (the ad campaign / "pauta" identity)
  adType?: string
  adId?: string
  attributionUrl?: string
  attributionMedium?: string
}

export interface Opportunity {
  // Always present
  id: string
  name: string
  pipelineId: string
  pipelineStageId: string
  status: "open" | "won" | "lost" | "abandoned"
  createdAt: string

  // Computed/resolved (always set by transform)
  contactId: string     // computed: from embedded contact.id or direct contactId
  value: number         // computed: monetaryValue ?? 0
  stage: string         // computed: resolved from pipelineStageId via pipeline lookup
  pipelineName: string  // computed: resolved from pipelineId via pipeline lookup

  // GHL Opportunity fields
  locationId?: string
  userId?: string
  assignedTo?: string   // GHL field; resolved to user name by transform
  statusId?: string
  monetaryValue?: number
  currency?: string
  probability?: number
  closedAt?: string
  updatedAt?: string
  source?: string
  campaignId?: string
  funnelId?: string
  workflowId?: string
  tags?: string[]       // opportunity's own tags (not from contact)
  priority?: string
  notes?: string
  archived?: boolean
  origin?: string
  lastActivity?: string
  lostReasonId?: string
  lostReason?: string   // computed (resolveLostReason): native lostReasonId → the location's lost-reason catalog, else a "Motivo/Razón de Perdido" custom field
  customFields?: Array<{ id: string; key?: string; value?: string; fieldValue?: string; fieldValueString?: string; type?: string }>
  // computed: name→value resolved custom fields. Multi-option/checkbox fields
  // keep their array shape; single-value fields are stored as a plain string.
  customFieldsResolved?: Record<string, string | string[]>
  attributions?: Array<{ [key: string]: unknown }>

  // Embedded contact object from search endpoint
  contact?: { id: string; name?: string; email?: string; phone?: string; tags?: string[] }

  // Computed attribution (derived from attributions array)
  campaign?: string
  campaignName?: string // computed: utmCampaign alone (the ad campaign / "pauta" identity)
  adType?: string
  adId?: string
  attributionUrl?: string
  attributionMedium?: string  // computed: GHL-internal medium (whatsapp, instagram, calendar, manual, …) or utmSessionSource fallback
  originPlatform?: string     // computed: linked contact's "Origen de Lead" custom field (Instagram/Facebook/TikTok/…); fallback signal for platformLabel
}

export interface Call {
  id: string
  contactId: string
  assignedTo?: string
  direction: "inbound" | "outbound"
  status: "completed" | "missed" | "no-answer"
  durationSeconds: number
  createdAt: string
}

export interface Task {
  id: string
  title: string
  body?: string
  status: "pending" | "completed"
  dueDate?: string
  contactId: string
  contactName?: string
  opportunityId?: string
  assignedTo?: string
  assignedToName?: string
  createdAt?: string
}

export interface Appointment {
  id: string
  contactId: string
  assignedTo?: string
  title?: string
  startTime: string
  endTime: string
  status: string
  notes?: string
  location?: string
}

// Channels we can render with an icon/label in the thread.
// Anything else collapses to "other".
export type MessageChannel =
  | "sms"
  | "email"
  | "facebook"
  | "instagram"
  | "whatsapp"
  | "google_chat"
  | "call"
  | "webchat"
  | "live_chat"
  | "tiktok"
  | "review"
  | "form_submission"
  | "internal_comment"
  | "other"

// System / activity event kinds — rendered as a centered timeline chip,
// not a chat bubble.
export type ActivityKind =
  | "opportunity"
  | "appointment"
  | "invoice"
  | "payment"
  | "contact"
  | "employee_action"
  | "other"

export interface Message {
  id: string
  contactId: string
  conversationId?: string
  assignedTo?: string
  direction: "inbound" | "outbound"
  // Omitted = real message. "activity" = system event (rendered as a chip).
  kind?: "message" | "activity"
  // For messages: the channel. For activities: "system".
  source: MessageChannel | "system"
  // Only set on activities — drives the chip label.
  activityKind?: ActivityKind
  content?: string
  createdAt: string
}

export interface Pipeline {
  id: string
  name: string
  stages: string[]
}


export interface Pauta {
  id: string
  tipo: string
  nombrePauta: string
  createdAt: string
  contactId?: string
  properties?: Record<string, string>
}

export interface CustomFieldDef {
  id: string
  name: string
  objectKey: "contact" | "opportunity"
  dataType: string // TEXT | LARGE_TEXT | NUMERICAL | SINGLE_OPTIONS | MULTIPLE_OPTIONS | DATE | CHECKBOX | RADIO
  fieldKey?: string
  picklistOptions?: string[]
}

// ── Meta Ads ─────────────────────────────────────────────────────────────────
// El dataset de la Marketing API, normalizado en tablas con ids de padre (no
// anidado): el cruce es por adId y los charts agrupan hacia arriba. Ver
// docs/superpowers/specs/2026-09-14-meta-ads-conexion-y-sync-design.md.

export interface MetaAccount {
  /** "act_123", como lo da Graph. */
  id: string
  name: string
  /** ISO 4217. No se convierte: cuentas con monedas distintas se muestran aparte. */
  currency: string
  timezone: string
}

export interface MetaCampaign {
  id: string
  name: string
  objective?: string
  accountId: string
}

export interface MetaAdset {
  id: string
  name: string
  campaignId: string
}

export interface MetaAd {
  id: string
  name: string
  adsetId: string
  status?: string
}

/** Un ad, un día. Meta omite los días sin gasto, así que no hay filas en cero. */
export interface MetaDailyRow {
  adId: string
  /** YYYY-MM-DD en la zona horaria de la cuenta. */
  date: string
  spend: number
  impressions: number
  reach: number
  clicks: number
  linkClicks: number
  /** action_type "lead": formularios → source "Pauta Formulario". */
  leadsForm: number
  /** action_type "onsite_conversion.messaging_conversation_started_7d": WhatsApp → "Pauta WhatsApp". */
  leadsMsg: number
}

export interface MetaAdsData {
  accounts: MetaAccount[]
  campaigns: MetaCampaign[]
  adsets: MetaAdset[]
  ads: MetaAd[]
  daily: MetaDailyRow[]
  /** YYYY-MM-DD ambos; lo que se pidió, no lo que vino. */
  window: { since: string; until: string }
  /** Cuentas que fallaron en este sync. Vacío = todas bien. */
  failedAccounts: { id: string; reason: string }[]
}

/**
 * Cómo le fue al paso `meta` en el último sync. Viaja en el payload (y por tanto
 * en el caché) para que la píldora lo lea también en un load en caliente.
 * `none` = nadie conectó o el proyecto no tiene cuenta asignada: NO es error.
 */
export type MetaAdsStatus =
  | { state: "none" }
  | { state: "ok" }
  | { state: "partial"; failedAccounts: { id: string; reason: string }[] }
  | { state: "error"; reason: "token_revoked" | "token_unreadable" | "failed" }

// The whole dashboard dataset: what the sync produces, what the cache stores, and
// what the browser receives. One definition so the three cannot drift apart.
export interface DashboardPayload {
  locationName: string
  contacts: Contact[]
  opportunities: Opportunity[]
  calls: Call[]
  tasks: Task[]
  appointments: Appointment[]
  pipelines: Pipeline[]
  members: string[]
  tags: string[]
  campaigns: string[]
  sources: string[]
  pautas: Pauta[]
  customFieldDefs: CustomFieldDef[]
  // Opcionales: un frame `data` cacheado por un deploy anterior no los trae.
  // `metaAds` es null sin conexión; el campo existente `meta` NO cambia.
  metaAds?: MetaAdsData | null
  metaAdsStatus?: MetaAdsStatus
  locationId: string
  meta: {
    totalContacts: number
    totalOpportunities: number
    // When the data was fetched FROM GHL — not when it was read from the cache.
    // This is the timestamp the header renders as "actualizado hace X".
    fetchedAt: string
  }
}
