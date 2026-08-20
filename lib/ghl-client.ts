// GoHighLevel API Client
// Uses Private Integration Token authentication
// API Docs: https://marketplace.gohighlevel.com/docs
//
// Credentials are per-request, not per-process: ghlFetch reads them from the
// AsyncLocalStorage context established by the route (see lib/ghl-context.ts).
import { currentClient, reportRetry } from "./ghl-context";
import {
  acquireSlot,
  releaseSlot,
  acquireRateToken,
  noteRateLimitHeaders,
  note429,
  rateLimitCooldownMs,
  serverErrorDelayMs,
  RATE_LIMIT_INTERVAL_MS,
} from "./ghl-limiter";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
// GHL's current API contract. Verified (read-only probe) to return shapes
// identical to the legacy 2021-07-28 for every core endpoint this app reads
// (contacts, opportunities, conversations, calendars, customFields, users), so
// we standardize on the current version everywhere. Custom-objects and the
// /ad-publishing Facebook endpoints already require this version.
const GHL_API_VERSION = "2023-02-21";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GHLRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: Record<string, unknown>;
  params?: Record<string, string | number | boolean | undefined>;
  useSnakeCaseLocationId?: boolean;
  version?: string;
  // Suppress the auto-injected `locationId`/`location_id` *query* param.
  noQueryLocationId?: boolean;
  // Suppress the auto-injected `locationId` in the POST *body*. These are
  // independent: noQueryLocationId only affects the query string.
  noBodyLocationId?: boolean;
}

// Abort a single attempt if GHL doesn't respond. The dashboard route fans these
// out in parallel, so one hung socket must not stall the whole response.
const GHL_REQUEST_TIMEOUT_MS = 30_000;

async function ghlFetch<T>(
  endpoint: string,
  options: GHLRequestOptions = {}
): Promise<T> {
  // Fails closed if the route forgot to establish the context — never falls back
  // to a default token, because serving the wrong tenant is worse than a 500.
  const { ghlToken: token, locationId } = currentClient();

  // Replace :locationId placeholder in endpoint
  const hadLocationPlaceholder = endpoint.includes(":locationId");
  const resolvedEndpoint = endpoint.replace(":locationId", locationId);
  const url = new URL(`${GHL_BASE_URL}${resolvedEndpoint}`);

  // Add query params
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    }
  }

  // Add locationId to query params for endpoints that need it. Keyed off whether
  // the path carried a :locationId placeholder (rather than a substring match on
  // the id, which could spuriously fire for unrelated id-shaped path segments).
  const locationKey = options.useSnakeCaseLocationId ? "location_id" : "locationId";
  if (!options.noQueryLocationId && !hadLocationPlaceholder && !url.searchParams.has("locationId") && !url.searchParams.has("location_id")) {
    url.searchParams.append(locationKey, locationId);
  }

  // For POST requests, also include locationId in body (unless suppressed).
  let body = options.body;
  if (options.method === "POST" && body && !body.locationId && !options.noBodyLocationId) {
    body = { ...body, locationId };
  }

  const requestInit: RequestInit = {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: options.version ?? GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  };

  // Cap total concurrent in-flight GHL requests across the whole process. Held
  // for the request's full lifetime — including retry backoff — so that when GHL
  // pushes back with 429s we aggressively shed concurrency instead of hammering.
  await acquireSlot(locationId);
  try {
    // 4 retries (5 attempts total). Backoff is jittered so concurrent requests
    // don't re-fire in lockstep (a synchronized retry wave just re-triggers the
    // storm). Every attempt first passes through acquireRateToken(), so retries
    // are rate-paced too and a 429's global cooldown throttles ALL requests.
    const MAX_RETRIES = 4;
    const jitter = () => Math.floor(Math.random() * 500);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await acquireRateToken(locationId);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          ...requestInit,
          signal: AbortSignal.timeout(GHL_REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Timeout (AbortError) or network failure — retry, rethrow on last attempt.
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === MAX_RETRIES) {
          throw new Error(`GHL API Error: request failed after retries - ${message}`);
        }
        const delay = Math.pow(2, attempt) * 1000 + jitter();
        console.warn(`[GHL] Request failed (${message}) — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }

      // Absorb GHL's rate-limit headers so we coast under the limit pre-emptively.
      noteRateLimitHeaders(locationId, response);

      if (response.status === 429 || response.status >= 500) {
        if (attempt === MAX_RETRIES) {
          throw new Error(`GHL API Error: ${response.status} - retries exhausted`);
        }
        const retryAfter = Number(response.headers.get("Retry-After") ?? 0);
        if (response.status === 429) {
          // A 429 means we (or another consumer of this token) overran the window.
          // Cool down THIS LOCATION until the window resets, so every pending
          // request for this client backs off together — and no other client is
          // affected (a shared cooldown would freeze every tenant's sync).
          const interval =
            Number(response.headers.get("x-ratelimit-interval-milliseconds")) ||
            RATE_LIMIT_INTERVAL_MS;
          const cool = rateLimitCooldownMs(retryAfter, interval);
          note429(locationId, cool + jitter());
          console.warn(`[GHL] 429 for ${locationId} — cooldown ~${cool}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          reportRetry({ status: 429, attempt: attempt + 1, maxAttempts: MAX_RETRIES + 1, delayMs: cool });
          continue; // acquireRateToken() at the top of the loop waits out the cooldown
        }
        // Capped: a 5xx is a broken gateway, not a rate limit, so its Retry-After
        // does not get to park the whole sync (see lib/ghl-limiter.ts).
        const delay = serverErrorDelayMs(retryAfter, attempt, jitter());
        console.warn(`[GHL] ${response.status} — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        reportRetry({ status: response.status, attempt: attempt + 1, maxAttempts: MAX_RETRIES + 1, delayMs: delay });
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        // GHL returns `401 {"message":"Command timed out"}` when its gateway
        // times out under load — a transient error, NOT an auth failure (a real
        // auth error carries a different message). Retry it like a 429; genuine
        // 401s and all other non-ok statuses still throw immediately.
        const isTransientTimeout =
          response.status === 401 && /timed out/i.test(errorText);
        if (isTransientTimeout && attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000 + jitter();
          console.warn(`[GHL] 401 timeout — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delay);
          continue;
        }
        console.error(`[GHL API Error] ${response.status}: ${errorText}`);
        throw new Error(`GHL API Error: ${response.status} - ${errorText}`);
      }

      // Some endpoints (204 No Content, or empty-body DELETE/POST mutations like
      // the Facebook pause/resume/delete actions) return no JSON. Calling
      // response.json() on an empty body throws, turning a success into an error.
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    throw new Error("GHL API Error: unexpected retry loop exit");
  } finally {
    releaseSlot(locationId);
  }
}

// ============ TAGS ============

export interface GHLTag {
  id: string;
  name: string;
  locationId: string;
}

export interface GHLTagsResponse {
  tags: GHLTag[];
}

export async function getTags(): Promise<GHLTagsResponse> {
  return ghlFetch<GHLTagsResponse>("/locations/:locationId/tags");
}

// ============ LOCATIONS (SUB-ACCOUNTS) ============

export interface GHLLocation {
  id: string;
  name: string;
  companyId?: string;
  logoUrl?: string;
}

export interface GHLLocationResponse {
  location: GHLLocation;
}

export async function getLocation(): Promise<GHLLocationResponse> {
  return ghlFetch<GHLLocationResponse>("/locations/:locationId");
}

// ============ CONTACTS ============

export interface GHLContact {
  id: string;
  locationId: string;
  name?: string;
  contactName?: string;
  firstName?: string;
  lastName?: string;
  firstNameRaw?: string;
  lastNameRaw?: string;
  email?: string;
  emailLowerCase?: string;
  phone?: string;
  timezone?: string;
  companyName?: string;
  dnd?: boolean;
  dndSettings?: Record<string, unknown>;
  type?: string;
  source?: string;
  assignedTo?: string;
  address1?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  website?: string;
  tags?: string[];
  dateOfBirth?: string;
  dateAdded: string;
  dateUpdated?: string;
  lastActivity?: string;
  customFields?: Array<{ id: string; value: string }>;
  businessId?: string;
  visitorId?: string;
  keyword?: string;
  firstNameLowerCase?: string;
  fullNameLowerCase?: string;
  lastNameLowerCase?: string;
  attachments?: unknown[];
  ssn?: string;
  // List endpoint returns attributions array; single-contact endpoint returns attributionSource
  attributions?: Array<{
    isFirst?: boolean;
    isLast?: boolean;
    utmCampaign?: string;
    utmContent?: string;
    utmMedium?: string;
    utmSource?: string;
    utmSessionSource?: string;
    adSource?: string;
    medium?: string;
    mediumId?: string;
    utmAdId?: string;
    utmCampaignId?: string;
    [key: string]: unknown;
  }>;
  attributionSource?: {
    campaign?: string;
    utmCampaign?: string;
    content?: string;
    utmContent?: string;
    medium?: string;
    utmMedium?: string;
    source?: string;
    utmSource?: string;
    sessionSource?: string;
    [key: string]: string | undefined;
  };
  lastAttributionSource?: {
    [key: string]: string | undefined;
  };
}

export interface GHLContactsResponse {
  contacts: GHLContact[];
  meta?: {
    total?: number;
    currentPage?: number;
    nextPage?: number;
    prevPage?: number;
    startAfterId?: string;
    startAfter?: number;
  };
}

// Simple contacts list with cursor pagination.
// GHL needs BOTH startAfterId and startAfter (a dateAdded epoch ms) together —
// passing only the id makes the cursor non-unique and returns overlapping pages.
export async function getContacts(params?: {
  limit?: number;
  startAfterId?: string;
  startAfter?: number;
  query?: string;
}): Promise<GHLContactsResponse> {
  return ghlFetch<GHLContactsResponse>("/contacts/", {
    params: {
      limit: params?.limit ?? 100,
      startAfterId: params?.startAfterId,
      startAfter: params?.startAfter,
      query: params?.query,
    },
  });
}

// ============ OPPORTUNITIES ============

// Calendar entries embedded by /opportunities/search when getCalendarEvents=true.
// Note GHL's misspellings: the array key is `calenders` and the status field is
// `appoinmentStatus`.
export interface GHLOpportunityCalendarEntry {
  id: string;
  contactId?: string;
  calendarId?: string;
  assignedUserId?: string;
  startTime: string;
  endTime: string;
  status?: string;
  appoinmentStatus?: string;
  title?: string;
  notes?: string;
}

export interface GHLOpportunity {
  id: string;
  locationId?: string;
  pipelineId: string;
  pipelineStageId: string;
  // contactId is present on the get-by-id endpoint; search endpoint embeds a contact object instead
  contactId?: string;
  userId?: string;
  assignedTo?: string;
  name: string;
  status: "open" | "won" | "lost" | "abandoned";
  statusId?: string;
  monetaryValue?: number;
  currency?: string;
  probability?: number;
  closedAt?: string;
  createdAt: string;
  updatedAt?: string;
  lastStatusChangeAt?: string;
  source?: string;
  campaignId?: string;
  funnelId?: string;
  workflowId?: string;
  tags?: string[];
  priority?: string;
  notes?: string;
  archived?: boolean;
  origin?: string;
  lastActivity?: string;
  lostReasonId?: string;
  // `fieldValueArray` is where multi-option opportunity fields actually arrive —
  // NOT under fieldValue/fieldValueString like the single-valued ones.
  customFields?: Array<{ id: string; key?: string; value?: string; fieldValue?: string; fieldValueString?: string; fieldValueArray?: string[]; type?: string }>;
  // Present only when fetched via /opportunities/search with getCalendarEvents=true
  calenders?: GHLOpportunityCalendarEntry[];
  // Embedded contact object returned by the search endpoint
  contact: {
    id: string;
    name?: string;
    email?: string;
    phone?: string;
    tags?: string[];
  };
  attributions?: Array<{
    isFirst?: boolean;
    isLast?: boolean;
    utmCampaign?: string;
    utmContent?: string;
    utmMedium?: string;
    utmSource?: string;
    utmSessionSource?: string;
    adSource?: string;
    medium?: string;
    [key: string]: unknown;
  }>;
}

export interface GHLOpportunitiesResponse {
  opportunities: GHLOpportunity[];
  meta: {
    total: number;
    currentPage: number;
    nextPage?: number | null;
    prevPage?: number | null;
  };
}

export interface GHLOpportunityDetail extends GHLOpportunity {
  calendarEvents: GHLCalendarEvent[];
}

export async function getOpportunityById(id: string): Promise<GHLOpportunityDetail> {
  // GET /opportunities/{id} does NOT return calendar events. The search endpoint
  // with getCalendarEvents=true does — under the misspelled key `calenders`.
  const resp = await ghlFetch<GHLOpportunitiesResponse>("/opportunities/search", {
    useSnakeCaseLocationId: true,
    params: { id, getCalendarEvents: true, limit: 1 },
  });
  const opp = resp.opportunities[0];
  if (!opp) throw new Error(`Opportunity ${id} not found`);
  const calendarEvents: GHLCalendarEvent[] = (opp.calenders ?? []).map((c) => ({
    id: c.id,
    calendarId: c.calendarId ?? "",
    contactId: c.contactId ?? "",
    status: c.status ?? "",
    startTime: c.startTime,
    endTime: c.endTime,
    appointmentStatus: c.appoinmentStatus ?? c.status,
    assignedUserId: c.assignedUserId,
    title: c.title,
    notes: c.notes,
    dateAdded: c.startTime,
  }));
  return { ...opp, calendarEvents };
}

export async function getOpportunities(params?: {
  pipelineId?: string;
  pipelineStageId?: string;
  status?: string;
  assignedTo?: string;
  limit?: number;
  page?: number;
}): Promise<GHLOpportunitiesResponse> {
  // Opportunities search endpoint uses location_id (snake_case)
  return ghlFetch<GHLOpportunitiesResponse>("/opportunities/search", {
    useSnakeCaseLocationId: true,
    params: {
      pipelineId: params?.pipelineId,
      pipelineStageId: params?.pipelineStageId,
      status: params?.status,
      assigned_to: params?.assignedTo,
      limit: params?.limit ?? 100,
      page: params?.page ?? 1,
    },
  });
}

// ============ PIPELINES ============

export interface GHLPipelineStage {
  id: string;
  name: string;
  position: number;
}

export interface GHLPipeline {
  id: string;
  name: string;
  stages: GHLPipelineStage[];
  locationId: string;
}

export interface GHLPipelinesResponse {
  pipelines: GHLPipeline[];
}

export async function getPipelines(): Promise<GHLPipelinesResponse> {
  return ghlFetch<GHLPipelinesResponse>("/opportunities/pipelines");
}

// A lost-reason catalog entry. `lostReasonId` on an opportunity is one of these
// `_id`s; the human-readable `name` is what GHL's own "Lost reason:" UI shows.
export interface GHLLostReason {
  _id: string;
  name: string;
  locationId?: string;
}

export interface GHLLostReasonsResponse {
  lostReasons: GHLLostReason[];
}

// The location's lost-reason catalog (id→name). Sub-accounts that record the
// loss motive via GHL's native field use this; accounts that don't have a
// catalog return an empty list, and the transform falls back to a custom field.
export async function getLostReasons(): Promise<GHLLostReasonsResponse> {
  // ghlFetch auto-appends ?locationId=… (camelCase) — exactly what this
  // endpoint requires — because the path carries no :locationId placeholder.
  return ghlFetch<GHLLostReasonsResponse>("/opportunities/lost-reason");
}

// ============ CONVERSATIONS / MESSAGES ============

export interface GHLConversation {
  id: string;
  contactId: string;
  locationId: string;
  lastMessageBody?: string;
  lastMessageDate?: string;
  lastMessageType?: string;
  type: string;
  unreadCount: number;
  dateAdded: string;
  dateUpdated?: string;
  assignedTo?: string;
  deleted?: boolean;
  inbox?: boolean;
  starred?: boolean;
}

export interface GHLConversationsResponse {
  conversations: GHLConversation[];
  total?: number;
}

export async function getConversations(params?: {
  limit?: number;
  type?: string;
  assignedTo?: string;
  contactId?: string;
}): Promise<GHLConversationsResponse> {
  return ghlFetch<GHLConversationsResponse>("/conversations/search", {
    params: {
      limit: params?.limit ?? 100,
      type: params?.type,
      assignedTo: params?.assignedTo,
      contactId: params?.contactId,
    },
  });
}

export interface GHLMessage {
  id: string;
  conversationId: string;
  contactId: string;
  locationId: string;
  body?: string;
  // Numeric type — opaque, prefer messageType for routing
  type: number;
  // String enum: TYPE_SMS, TYPE_EMAIL, TYPE_WHATSAPP, TYPE_FACEBOOK,
  // TYPE_INSTAGRAM, TYPE_ACTIVITY_OPPORTUNITY, … — see GHL-API-Schemas.md
  messageType?: string;
  direction: "inbound" | "outbound";
  status: string;
  dateAdded: string;
  attachments?: string[];
  source?: string;
}

export interface GHLMessagesResponse {
  messages: {
    messages: GHLMessage[];
    lastMessageId?: string;
    nextPage?: boolean;
  };
}

export async function getMessages(conversationId: string, params?: {
  limit?: number;
  lastMessageId?: string;
}): Promise<GHLMessagesResponse> {
  return ghlFetch<GHLMessagesResponse>(`/conversations/${conversationId}/messages`, {
    params: {
      limit: params?.limit ?? 50,
      lastMessageId: params?.lastMessageId,
    },
  });
}

// ============ USERS / TEAM MEMBERS ============

export interface GHLUser {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  role: string;
}

export interface GHLUsersResponse {
  users: GHLUser[];
}

export async function getUsers(): Promise<GHLUsersResponse> {
  return ghlFetch<GHLUsersResponse>("/users/");
}

// ============ CALENDARS / APPOINTMENTS ============

export interface GHLCalendarEvent {
  id: string;
  title?: string;
  calendarId: string;
  contactId: string;
  status: string;
  startTime: string;
  endTime: string;
  appointmentStatus?: string;
  assignedUserId?: string;
  notes?: string;
  address?: string;
  location?: string;
  dateAdded: string;
}

export interface GHLCalendarEventsResponse {
  events: GHLCalendarEvent[];
}

export async function getCalendarEvents(params?: {
  calendarId?: string;
  userId?: string;
  startTime?: string;
  endTime?: string;
}): Promise<GHLCalendarEventsResponse> {
  return ghlFetch<GHLCalendarEventsResponse>("/calendars/events", {
    params: {
      calendarId: params?.calendarId,
      userId: params?.userId,
      startTime: params?.startTime,
      endTime: params?.endTime,
    },
  });
}

export interface GHLCalendar {
  id: string;
  locationId: string;
  name: string;
  isActive?: boolean;
}

export interface GHLCalendarsResponse {
  calendars: GHLCalendar[];
}

export async function getCalendars(): Promise<GHLCalendarsResponse> {
  return ghlFetch<GHLCalendarsResponse>("/calendars/");
}

// ============ TASKS ============

export interface GHLTask {
  _id: string;
  locationId?: string;
  deleted?: boolean;
  searchAfter?: [number, string];
  dateAdded?: string;
  createdAt?: string;
  dateUpdated?: string;
  updatedAt?: string;
  assignedTo?: string;
  contactDetails?: { firstName?: string; lastName?: string };
  assignedToUserDetails?: { id: string; firstName?: string; lastName?: string; profilePhoto?: string };
  body?: string;
  completed: boolean;
  dueDate?: string;
  title: string;
  contactId: string;
}

export interface GHLTaskSearchResponse {
  tasks: GHLTask[];
  traceId?: string;
}

export interface GHLContactTask {
  id: string;
  title: string;
  body?: string;
  contactId: string;
  assignedTo?: string;
  dueDate?: string;
  status: "pending" | "completed";
  dateAdded: string;
}

export interface GHLContactTasksResponse {
  tasks: GHLContactTask[];
}

export async function getContactTasks(contactId: string): Promise<GHLContactTasksResponse> {
  return ghlFetch<GHLContactTasksResponse>(`/contacts/${contactId}/tasks`);
}

async function fetchTaskPage(filters: {
  contactId?: string[];
  completed: boolean;
  assignedTo?: string[];
  query?: string;
}, skip: number, limit: number): Promise<GHLTaskSearchResponse> {
  return ghlFetch<GHLTaskSearchResponse>("/locations/:locationId/tasks/search", {
    method: "POST",
    body: { ...filters, limit, skip },
    noBodyLocationId: true,
  });
}

async function paginateTasks(filters: {
  contactId?: string[];
  completed: boolean;
  assignedTo?: string[];
  query?: string;
}, cap: number): Promise<GHLTask[]> {
  const limit = 100;
  const all: GHLTask[] = [];
  let skip = 0;
  while (true) {
    const res = await fetchTaskPage(filters, skip, limit);
    all.push(...res.tasks);
    if (res.tasks.length < limit) break;
    skip += limit;
    if (all.length >= cap) break;
  }
  return all;
}

// GHL's task search endpoint requires `completed` to be explicitly set —
// omitting it returns an empty list. Fetch pending and completed separately.
export async function searchLocationTasks(filters: {
  contactId?: string[];
  completed?: boolean;
  assignedTo?: string[];
  query?: string;
} = {}): Promise<GHLTask[]> {
  const CAP = 500;

  if (filters.completed !== undefined) {
    return paginateTasks({ ...filters, completed: filters.completed }, CAP);
  }

  const { completed: _ignored, ...rest } = filters;
  const [pending, done] = await Promise.all([
    paginateTasks({ ...rest, completed: false }, CAP),
    paginateTasks({ ...rest, completed: true }, CAP),
  ]);
  return [...pending, ...done];
}

// ============ NOTES ============

export interface GHLNote {
  id: string;
  body: string;
  userId?: string;
  dateAdded: string;
  contactId?: string;
}

export interface GHLNotesResponse {
  notes: GHLNote[];
}

export async function getContactNotes(contactId: string): Promise<GHLNotesResponse> {
  return ghlFetch<GHLNotesResponse>(`/contacts/${contactId}/notes`, {
    noQueryLocationId: true,
  });
}

// ============ CUSTOM FIELD DEFINITIONS ============

export interface GHLCustomField {
  id: string;
  name: string;
  fieldKey?: string;
  dataType?: string;
  model?: string; // "contact" | "opportunity" | "custom_objects.<key>"
  locationId?: string;
  position?: number;
  placeholder?: string;
  required?: boolean;
  standard?: boolean;
  picklistOptions?: string[]; // opciones para *_OPTIONS / RADIO / CHECKBOX (string[] plano)
}

export interface GHLCustomFieldsResponse {
  customFields: GHLCustomField[];
}

export async function getCustomFields(): Promise<GHLCustomFieldsResponse> {
  // Without ?model=all the endpoint returns ONLY contact custom fields, so
  // opportunity fields (e.g. "Motivo de Perdido") never make it into the
  // id→name map and stay unresolved.
  return ghlFetch<GHLCustomFieldsResponse>("/locations/:locationId/customFields", {
    params: { model: "all" },
  });
}

// ============ CUSTOM FIELD WRITES (modo edición del asistente) ============

/** PUT /contacts/:id — actualiza valores de custom fields de un contacto.
 *  Forma de escritura: { id, field_value } (distinta de la lectura { id, value }). */
export async function updateContactCustomFields(
  contactId: string,
  fields: Array<{ id: string; field_value: string | string[] }>,
): Promise<unknown> {
  return ghlFetch(`/contacts/${contactId}`, {
    method: "PUT",
    body: { customFields: fields },
    noQueryLocationId: true, // el endpoint no espera ?locationId
  });
}

/** PUT /opportunities/:id — actualiza valores de custom fields de una oportunidad. */
export async function updateOpportunityCustomFields(
  opportunityId: string,
  fields: Array<{ id: string; field_value: string | string[] }>,
): Promise<unknown> {
  return ghlFetch(`/opportunities/${opportunityId}`, {
    method: "PUT",
    body: { customFields: fields },
    noQueryLocationId: true,
  });
}

// Asimetría lectura/escritura: la LECTURA devuelve las opciones en
// `picklistOptions` (string[]), pero la ESCRITURA (create/update) las espera en
// `options`. Mandar `picklistOptions` da 422 "property picklistOptions should
// not exist". Traducimos aquí, en el límite HTTP.
/** POST /locations/:locationId/customFields — crea una definición de campo. */
export async function createCustomFieldDef(input: {
  name: string;
  dataType: string;
  model: "contact" | "opportunity";
  picklistOptions?: string[];
}): Promise<GHLCustomField> {
  const { picklistOptions, ...rest } = input;
  const body: Record<string, unknown> = { ...rest };
  if (picklistOptions && picklistOptions.length) body.options = picklistOptions;
  const res = await ghlFetch<{ customField: GHLCustomField }>(
    "/locations/:locationId/customFields",
    { method: "POST", body },
  );
  return res.customField;
}

/** PUT /locations/:locationId/customFields/:id — renombra / agrega opciones. */
export async function updateCustomFieldDef(
  fieldId: string,
  input: { name?: string; picklistOptions?: string[] },
): Promise<GHLCustomField> {
  const body: Record<string, unknown> = {};
  if (input.name) body.name = input.name;
  if (input.picklistOptions && input.picklistOptions.length)
    body.options = input.picklistOptions;
  const res = await ghlFetch<{ customField: GHLCustomField }>(
    `/locations/:locationId/customFields/${fieldId}`,
    { method: "PUT", body },
  );
  return res.customField;
}

// ============ CUSTOM OBJECTS ============

export interface GHLCustomObjectField {
  id: string;
  fieldKey: string;
  name: string;
  dataType: string;
}

export interface GHLCustomObjectSchema {
  id: string;
  key: string;
  labels: { singular: string; plural: string };
  fields?: GHLCustomObjectField[];
}

export interface GHLCustomObjectsResponse {
  objects: GHLCustomObjectSchema[];
}

export interface GHLCustomObjectRelation {
  associationId: string;
  relationId: string;
  objectKey: string;
  recordId: string;
  createdAt?: string;
}

export interface GHLCustomObjectRecord {
  id: string;
  properties: Record<string, string | string[] | null>;
  createdAt?: string;
  updatedAt?: string;
  relations?: GHLCustomObjectRelation[];
  /** @deprecated GHL returns `relations`, not `associations` */
  associations?: Record<string, unknown>;
}

export interface GHLCustomObjectRecordsResponse {
  records: GHLCustomObjectRecord[];
  total?: number;
}

export async function getCustomObjects(): Promise<GHLCustomObjectsResponse> {
  return ghlFetch<GHLCustomObjectsResponse>("/objects/", {
    version: "2023-02-21",
  });
}

export async function getCustomObjectSchema(objectKey: string): Promise<{ object: GHLCustomObjectSchema & { fields: GHLCustomObjectField[] } }> {
  return ghlFetch(`/objects/${objectKey}`, { version: "2023-02-21" });
}

export async function getAllCustomObjectRecords(
  objectKey: string,
  onProgress?: (count: number) => void
): Promise<GHLCustomObjectRecord[]> {
  const pageLimit = 100;
  // locationId is required here, but in the request body — not the query string.
  // noQueryLocationId keeps it out of the query; ghlFetch still injects it into
  // the POST body (noBodyLocationId is left unset).
  const fetchPage = (page: number) =>
    ghlFetch<GHLCustomObjectRecordsResponse>(`/objects/${objectKey}/records/search`, {
      method: "POST",
      version: "2023-02-21",
      noQueryLocationId: true,
      body: { page, pageLimit },
    });

  const first = await fetchPage(1);
  const total = first.total ?? first.records.length;

  const seen = new Set<string>();
  const all: GHLCustomObjectRecord[] = [];
  const absorb = (records: GHLCustomObjectRecord[]) => {
    for (const r of records) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      all.push(r);
    }
    onProgress?.(all.length);
  };
  absorb(first.records);

  if (all.length >= total || first.records.length < pageLimit) return all;

  // Total known after page 1 → fetch the remaining pages concurrently; ghlFetch's
  // limiter bounds in-flight count and rate, so no manual paging/sleep is needed.
  const totalPages = Math.ceil(total / pageLimit);
  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2).then((r) => r.records))
  );
  for (const records of rest) absorb(records);

  return all;
}

// ============ HELPER FUNCTIONS ============

// Helper to fetch all pages of opportunities.
// The /opportunities/search endpoint is page-numbered AND returns meta.total on
// the first page, so once we have page 1 we know exactly how many pages remain
// and can fetch them all concurrently. The global semaphore + token bucket in
// ghlFetch bound the actual in-flight count and request rate, so there's no need
// for the old sequential page-walk or the inter-page sleep — those just added
// latency on top of the central limiter. Results are deduped by id so a shifting
// dataset (page boundaries moving between requests) can't inflate the count.
export async function getAllOpportunities(
  onProgress?: (count: number) => void
): Promise<GHLOpportunity[]> {
  const pageSize = 100;
  const first = await getOpportunities({ page: 1, limit: pageSize });
  const total = first.meta.total ?? first.opportunities.length;

  const seen = new Set<string>();
  const all: GHLOpportunity[] = [];
  const absorb = (opps: GHLOpportunity[]) => {
    for (const o of opps) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      all.push(o);
    }
    onProgress?.(all.length);
  };
  absorb(first.opportunities);

  if (all.length >= total || !first.meta.nextPage) return all;

  // Fan out the remaining pages. ghlFetch's limiter keeps this safe.
  const totalPages = Math.ceil(total / pageSize);
  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) =>
      getOpportunities({ page: i + 2, limit: pageSize }).then((r) => r.opportunities)
    )
  );
  for (const opps of rest) absorb(opps);

  return all;
}

// Helper to fetch all contacts with cursor pagination
export async function getAllContacts(
  onProgress?: (count: number) => void
): Promise<GHLContact[]> {
  const allContacts: GHLContact[] = [];
  const seenIds = new Set<string>();
  let startAfterId: string | undefined;
  let startAfter: number | undefined;
  let total: number | undefined;

  while (true) {
    const response = await getContacts({ limit: 100, startAfterId, startAfter });
    if (total === undefined && response.meta?.total !== undefined) total = response.meta.total;

    // Dedupe by id — GHL's cursor pagination occasionally returns overlapping
    // pages and we'd otherwise inflate the count.
    let pageNew = 0;
    for (const c of response.contacts) {
      if (seenIds.has(c.id)) continue;
      seenIds.add(c.id);
      allContacts.push(c);
      pageNew++;
    }
    onProgress?.(allContacts.length);

    // Stop once we have all records or got a partial page.
    if (
      (total !== undefined && allContacts.length >= total) ||
      response.contacts.length < 100
    ) break;

    // If a whole page is duplicates, the cursor is stuck — bail out.
    if (pageNew === 0) break;

    // Advance cursor — use both fields together (startAfter is a dateAdded
    // epoch ms; without it the cursor isn't unique).
    const last = response.contacts[response.contacts.length - 1];
    startAfterId = response.meta?.startAfterId ?? last.id;
    // Guard against a missing/malformed dateAdded producing a NaN cursor (which
    // would serialize to the literal "NaN" on the query string). The dedupe +
    // pageNew===0 bailout above still protect us if the cursor isn't unique.
    const lastDateMs = new Date(last.dateAdded).getTime();
    startAfter = response.meta?.startAfter ?? (Number.isNaN(lastDateMs) ? undefined : lastDateMs);
    // No inter-page sleep: cursor pagination must stay sequential, but ghlFetch's
    // token bucket already paces the request rate. An extra sleep here is pure
    // added latency.
  }

  return allContacts;
}

// ============ FACEBOOK ADS / AD MANAGER (ad-publishing) ============
//
// GHL Ad Manager — Facebook integration + Facebook Ads endpoints.
//   Docs: https://marketplace.gohighlevel.com/docs/ghl/ad-manager/facebook-integration
//         https://marketplace.gohighlevel.com/docs/ghl/ad-manager/facebook-ads
//
// All endpoints live under /ad-publishing/facebook and require Version 2023-02-21
// (passed via fbFetch). locationId is appended automatically by ghlFetch as a
// query param (and into the body on POSTs).
//
// SCOPE NOTE: this wires up the CONNECTION only — none of these are imported by
// app/api/dashboard/route.ts yet, and no data is fetched into the UI. Response
// shapes are intentionally permissive: the public docs don't publish full JSON
// schemas, so each interface carries an index signature. Refine the shapes against
// live data via the ghl-mcp server before depending on specific fields.
//
// PATH NOTE: the docs are inconsistent between the single-resource read paths
// (singular: GET /campaign/:id, GET /entity) and the collection/action paths
// (plural: PUT /campaigns, POST /campaigns/:id/pause). The paths below mirror the
// docs verbatim; verify the singular/plural split against the live API if a call 404s.

const GHL_AD_PUBLISHING_VERSION = "2023-02-21";

// Thin wrapper that pins the ad-publishing API version. Everything else
// (auth, locationId injection, 429 retries) is inherited from ghlFetch.
function fbFetch<T>(endpoint: string, options: GHLRequestOptions = {}): Promise<T> {
  return ghlFetch<T>(endpoint, { version: GHL_AD_PUBLISHING_VERSION, ...options });
}

// --- Permissive entity shapes (refine against live data before relying on fields) ---

export interface GHLFacebookUser {
  id?: string;
  name?: string;
  email?: string;
  picture?: string;
  [key: string]: unknown;
}

export interface GHLFacebookPage {
  id?: string;
  facebookPageId?: string;
  name?: string;
  isConnected?: boolean;
  isDefault?: boolean;
  [key: string]: unknown;
}

export interface GHLFacebookInstagramAccount {
  id?: string;
  username?: string;
  name?: string;
  [key: string]: unknown;
}

export interface GHLFacebookAdAccount {
  id?: string;
  accountId?: string;
  name?: string;
  currency?: string;
  status?: string;
  [key: string]: unknown;
}

export interface GHLFacebookLeadForm {
  id?: string;
  name?: string;
  pageId?: string;
  status?: string;
  [key: string]: unknown;
}

export interface GHLFacebookIntegration {
  id?: string;
  locationId?: string;
  pageId?: string;
  adAccountId?: string;
  [key: string]: unknown;
}

export interface GHLFacebookPixel {
  id?: string;
  pixelId?: string;
  name?: string;
  [key: string]: unknown;
}

export interface GHLFacebookCustomAudience {
  id?: string;
  name?: string;
  description?: string;
  approximateCount?: number;
  [key: string]: unknown;
}

// Campaign / ad set / ad records returned by the read endpoints.
export interface GHLFacebookCampaign {
  id?: string;
  name?: string;
  status?: string;
  objective?: string;
  effectiveStatus?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  [key: string]: unknown;
}

export interface GHLFacebookAdSet {
  id?: string;
  campaignId?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

export interface GHLFacebookAd {
  id?: string;
  adSetId?: string;
  campaignId?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

// "Get campaign with linked entities" returns the campaign plus its adsets and ads.
export interface GHLFacebookCampaignWithEntities extends GHLFacebookCampaign {
  adsets?: GHLFacebookAdSet[];
  ads?: GHLFacebookAd[];
}

// ---- Facebook integration: account / page / form management ----

/** GET /ad-publishing/facebook/me — authenticated Facebook user profile. */
export async function getFacebookCurrentUser(): Promise<GHLFacebookUser> {
  return fbFetch<GHLFacebookUser>("/ad-publishing/facebook/me");
}

/** GET /ad-publishing/facebook/pages — Facebook pages connected to the location. */
export async function getFacebookPages(): Promise<GHLFacebookPage[]> {
  return fbFetch<GHLFacebookPage[]>("/ad-publishing/facebook/pages");
}

/** GET /ad-publishing/facebook/page/{pageId}/instagram — Instagram accounts linked to a page. */
export async function getFacebookInstagramAccounts(
  pageId: string
): Promise<GHLFacebookInstagramAccount[]> {
  return fbFetch<GHLFacebookInstagramAccount[]>(`/ad-publishing/facebook/page/${pageId}/instagram`);
}

/** GET /ad-publishing/facebook/page/{pageId}/forms — lead gen forms for a page. */
export async function getFacebookPageLeadForms(pageId: string): Promise<GHLFacebookLeadForm[]> {
  return fbFetch<GHLFacebookLeadForm[]>(`/ad-publishing/facebook/page/${pageId}/forms`);
}

/** POST /ad-publishing/facebook/page/{pageId}/forms — create a lead gen form on a page. */
export async function createFacebookPageLeadForm(
  pageId: string,
  body: Record<string, unknown>
): Promise<GHLFacebookLeadForm> {
  return fbFetch<GHLFacebookLeadForm>(`/ad-publishing/facebook/page/${pageId}/forms`, {
    method: "POST",
    body,
  });
}

/** GET /ad-publishing/facebook/lead-form/{leadFormId} — single lead form by ID. */
export async function getFacebookLeadForm(leadFormId: string): Promise<GHLFacebookLeadForm> {
  return fbFetch<GHLFacebookLeadForm>(`/ad-publishing/facebook/lead-form/${leadFormId}`);
}

/** GET /ad-publishing/facebook/ad-accounts — Facebook ad accounts available for the user. */
export async function getFacebookAdAccounts(): Promise<GHLFacebookAdAccount[]> {
  return fbFetch<GHLFacebookAdAccount[]>("/ad-publishing/facebook/ad-accounts");
}

/** GET /ad-publishing/facebook/ad-accounts/{adAccountId} — details for a single ad account. */
export async function getFacebookAdAccount(adAccountId: string): Promise<GHLFacebookAdAccount> {
  return fbFetch<GHLFacebookAdAccount>(`/ad-publishing/facebook/ad-accounts/${adAccountId}`);
}

/** DELETE /ad-publishing/facebook/ad-accounts/{adAccountId} — disconnect an ad account. */
export async function deleteFacebookAdAccount(adAccountId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/ad-accounts/${adAccountId}`, { method: "DELETE" });
}

/** GET /ad-publishing/facebook/conversation-forms — conversation lead forms for the location. */
export async function getFacebookConversationForms(): Promise<GHLFacebookLeadForm[]> {
  return fbFetch<GHLFacebookLeadForm[]>("/ad-publishing/facebook/conversation-forms");
}

/** POST /ad-publishing/facebook/conversation-forms — create a conversation lead form. */
export async function createFacebookConversationForm(
  body: Record<string, unknown>
): Promise<GHLFacebookLeadForm> {
  return fbFetch<GHLFacebookLeadForm>("/ad-publishing/facebook/conversation-forms", {
    method: "POST",
    body,
  });
}

/** GET /ad-publishing/facebook/integration — current Facebook ad integration for the location. */
export async function getFacebookIntegration(): Promise<GHLFacebookIntegration> {
  return fbFetch<GHLFacebookIntegration>("/ad-publishing/facebook/integration");
}

/** POST /ad-publishing/facebook/integration — create the Facebook ad integration. */
export async function createFacebookIntegration(
  body: Record<string, unknown>
): Promise<GHLFacebookIntegration> {
  return fbFetch<GHLFacebookIntegration>("/ad-publishing/facebook/integration", {
    method: "POST",
    body,
  });
}

/** DELETE /ad-publishing/facebook/integration — remove the Facebook ad integration. */
export async function deleteFacebookIntegration(): Promise<unknown> {
  return fbFetch("/ad-publishing/facebook/integration", { method: "DELETE" });
}

/** DELETE /ad-publishing/facebook/page — remove the Facebook page connection. */
export async function deleteFacebookPage(): Promise<unknown> {
  return fbFetch("/ad-publishing/facebook/page", { method: "DELETE" });
}

/** PUT /ad-publishing/facebook/page/default — set the default Facebook page for the location. */
export async function setFacebookDefaultPage(body: Record<string, unknown>): Promise<unknown> {
  return fbFetch("/ad-publishing/facebook/page/default", { method: "PUT", body });
}

// ---- Facebook Ads: targeting, pixels, custom audiences ----

/** GET /ad-publishing/facebook/targeting/search — search geolocations/interests for targeting. */
export async function searchFacebookTargeting(
  params?: Record<string, string | number | boolean | undefined>
): Promise<unknown> {
  return fbFetch("/ad-publishing/facebook/targeting/search", { params });
}

/** GET /ad-publishing/facebook/pixels — conversion pixels for the location. */
export async function getFacebookPixels(): Promise<GHLFacebookPixel[]> {
  return fbFetch<GHLFacebookPixel[]>("/ad-publishing/facebook/pixels");
}

/** PUT /ad-publishing/facebook/pixels — create or update a conversion pixel. */
export async function upsertFacebookPixel(body: Record<string, unknown>): Promise<GHLFacebookPixel> {
  return fbFetch<GHLFacebookPixel>("/ad-publishing/facebook/pixels", { method: "PUT", body });
}

/** GET /ad-publishing/facebook/custom-audience — custom audiences for the location. */
export async function getFacebookCustomAudiences(): Promise<GHLFacebookCustomAudience[]> {
  return fbFetch<GHLFacebookCustomAudience[]>("/ad-publishing/facebook/custom-audience");
}

/** GET /ad-publishing/facebook/custom-audience/{audienceId} — single custom audience. */
export async function getFacebookCustomAudience(
  audienceId: string
): Promise<GHLFacebookCustomAudience> {
  return fbFetch<GHLFacebookCustomAudience>(`/ad-publishing/facebook/custom-audience/${audienceId}`);
}

/** PUT /ad-publishing/facebook/custom-audience/{audienceId} — update name/description. */
export async function updateFacebookCustomAudience(
  audienceId: string,
  body: Record<string, unknown>
): Promise<GHLFacebookCustomAudience> {
  return fbFetch<GHLFacebookCustomAudience>(`/ad-publishing/facebook/custom-audience/${audienceId}`, {
    method: "PUT",
    body,
  });
}

/** DELETE /ad-publishing/facebook/custom-audience/{audienceId} — delete a custom audience. */
export async function deleteFacebookCustomAudience(audienceId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/custom-audience/${audienceId}`, { method: "DELETE" });
}

/** PUT /ad-publishing/facebook/custom-audience/{audienceId}/member — add a member. */
export async function addFacebookCustomAudienceMember(
  audienceId: string,
  body: Record<string, unknown>
): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/custom-audience/${audienceId}/member`, {
    method: "PUT",
    body,
  });
}

/** DELETE /ad-publishing/facebook/custom-audience/{audienceId}/member — remove a member. */
export async function removeFacebookCustomAudienceMember(
  audienceId: string,
  body: Record<string, unknown>
): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/custom-audience/${audienceId}/member`, {
    method: "DELETE",
    body,
  });
}

/** PUT /ad-publishing/facebook/custom-audience/{audienceId}/member/batch — bulk add/remove members. */
export async function batchUpdateFacebookCustomAudienceMembers(
  audienceId: string,
  body: Record<string, unknown>
): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/custom-audience/${audienceId}/member/batch`, {
    method: "PUT",
    body,
  });
}

// ---- Facebook Ads: campaigns / ad sets / ads ----

/**
 * GET /ad-publishing/facebook/entity — list campaigns, ad sets, or ads.
 * Filtered by entity type via query params (e.g. type=campaign|adset|ad, adAccountId, …).
 */
export async function getFacebookEntities(
  params?: Record<string, string | number | boolean | undefined>
): Promise<unknown> {
  return fbFetch("/ad-publishing/facebook/entity", { params });
}

/** GET /ad-publishing/facebook/campaign/{campaignId} — campaign with its ad sets and ads. */
export async function getFacebookCampaign(
  campaignId: string
): Promise<GHLFacebookCampaignWithEntities> {
  return fbFetch<GHLFacebookCampaignWithEntities>(`/ad-publishing/facebook/campaign/${campaignId}`);
}

/** PUT /ad-publishing/facebook/campaigns — create or update a campaign. */
export async function upsertFacebookCampaign(
  body: Record<string, unknown>
): Promise<GHLFacebookCampaign> {
  return fbFetch<GHLFacebookCampaign>("/ad-publishing/facebook/campaigns", { method: "PUT", body });
}

/** POST /ad-publishing/facebook/campaigns/{campaignId}/publish — push a campaign live. */
export async function publishFacebookCampaign(
  campaignId: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/campaigns/${campaignId}/publish`, { method: "POST", body });
}

/** POST /ad-publishing/facebook/campaigns/{campaignId}/pause — pause a running campaign. */
export async function pauseFacebookCampaign(campaignId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/campaigns/${campaignId}/pause`, { method: "POST" });
}

/** POST /ad-publishing/facebook/campaigns/{campaignId}/resume — resume a paused campaign. */
export async function resumeFacebookCampaign(campaignId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/campaigns/${campaignId}/resume`, { method: "POST" });
}

/** POST /ad-publishing/facebook/campaigns/{campaignId}/duplicate — duplicate a campaign. */
export async function duplicateFacebookCampaign(
  campaignId: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/campaigns/${campaignId}/duplicate`, { method: "POST", body });
}

/** DELETE /ad-publishing/facebook/campaigns/{campaignId} — delete a campaign. */
export async function deleteFacebookCampaign(campaignId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/campaigns/${campaignId}`, { method: "DELETE" });
}

/** PUT /ad-publishing/facebook/adsets — create or update an ad set. */
export async function upsertFacebookAdSet(body: Record<string, unknown>): Promise<GHLFacebookAdSet> {
  return fbFetch<GHLFacebookAdSet>("/ad-publishing/facebook/adsets", { method: "PUT", body });
}

/** POST /ad-publishing/facebook/adsets/{adSetId}/pause — pause a running ad set. */
export async function pauseFacebookAdSet(adSetId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/adsets/${adSetId}/pause`, { method: "POST" });
}

/** POST /ad-publishing/facebook/adsets/{adSetId}/resume — resume a paused ad set. */
export async function resumeFacebookAdSet(adSetId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/adsets/${adSetId}/resume`, { method: "POST" });
}

/** POST /ad-publishing/facebook/adsets/{adSetId}/duplicate — duplicate an ad set. */
export async function duplicateFacebookAdSet(
  adSetId: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/adsets/${adSetId}/duplicate`, { method: "POST", body });
}

/** DELETE /ad-publishing/facebook/adsets/{adSetId} — delete an ad set. */
export async function deleteFacebookAdSet(adSetId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/adsets/${adSetId}`, { method: "DELETE" });
}

/** PUT /ad-publishing/facebook/ads — create or update an ad. */
export async function upsertFacebookAd(body: Record<string, unknown>): Promise<GHLFacebookAd> {
  return fbFetch<GHLFacebookAd>("/ad-publishing/facebook/ads", { method: "PUT", body });
}

/** POST /ad-publishing/facebook/ads/{adId}/pause — pause a running ad. */
export async function pauseFacebookAd(adId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/ads/${adId}/pause`, { method: "POST" });
}

/** POST /ad-publishing/facebook/ads/{adId}/resume — resume a paused ad. */
export async function resumeFacebookAd(adId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/ads/${adId}/resume`, { method: "POST" });
}

/** POST /ad-publishing/facebook/ads/{adId}/duplicate — duplicate an ad. */
export async function duplicateFacebookAd(
  adId: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/ads/${adId}/duplicate`, { method: "POST", body });
}

/** DELETE /ad-publishing/facebook/ads/{adId} — delete an ad. */
export async function deleteFacebookAd(adId: string): Promise<unknown> {
  return fbFetch(`/ad-publishing/facebook/ads/${adId}`, { method: "DELETE" });
}
