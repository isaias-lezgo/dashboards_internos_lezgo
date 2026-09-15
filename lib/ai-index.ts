// Contact-hub join index. Appointments, pautas, and opportunities only relate to
// each other through their shared contact. Precomputing reverse lookups once lets
// the `relate` tool traverse those links in code (one turn) instead of the model
// orchestrating a multi-turn contactId join.

import type {
  Contact,
  Opportunity,
  Pauta,
  Appointment,
  Task,
} from "@/lib/types";
import type { ChatDataset } from "@/lib/ai-tools";
import { buildPautaNameByContact } from "@/lib/pauta";
import { buildMetaIndex, type MetaIndex } from "@/lib/meta-attribution";

export interface ChatIndex {
  contactById: Map<string, Contact>;
  oppsByContact: Map<string, Opportunity[]>;
  pautasByContact: Map<string, Pauta[]>;
  apptsByContact: Map<string, Appointment[]>;
  tasksByContact: Map<string, Task[]>;
  // contactId → first named Pauta's campaign name; last-resort fallback for the
  // shared resolveCampaignName (see lib/pauta). pautasByContact.has() gives the
  // "es de pauta" trace directly, so no separate id set is needed.
  pautaNameByContact: Map<string, string>;
  /** Índice de Meta Ads (adId → jerarquía); null sin conexión. */
  metaIndex: MetaIndex | null;
}

function pushTo<T>(map: Map<string, T[]>, key: string | undefined, val: T): void {
  if (!key) return;
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

export function buildChatIndex(data: ChatDataset): ChatIndex {
  const contactById = new Map<string, Contact>();
  for (const c of data.contacts) contactById.set(c.id, c);

  const oppsByContact = new Map<string, Opportunity[]>();
  for (const o of data.opportunities) pushTo(oppsByContact, o.contactId, o);

  const pautasByContact = new Map<string, Pauta[]>();
  for (const p of data.pautas) pushTo(pautasByContact, p.contactId, p);

  const apptsByContact = new Map<string, Appointment[]>();
  for (const a of data.appointments) pushTo(apptsByContact, a.contactId, a);

  const tasksByContact = new Map<string, Task[]>();
  for (const t of data.tasks) pushTo(tasksByContact, t.contactId, t);

  const pautaNameByContact = buildPautaNameByContact(data.pautas);

  const metaIndex = data.metaAds ? buildMetaIndex(data.metaAds) : null;
  return { contactById, oppsByContact, pautasByContact, apptsByContact, tasksByContact, pautaNameByContact, metaIndex };
}

// Cache keyed on the contacts array reference (stable within a single agent run),
// so the index is built once per dataset rather than on every tool call. The
// index also derives from opportunities/pautas/appointments — these normally
// change together with contacts (same SWR payload), but we record their
// references and rebuild if any of them changed even when `contacts` did not,
// so a partially-refreshed dataset can never serve a stale index. The WeakMap
// entry is garbage-collected with the contacts array.
interface CacheEntry {
  index: ChatIndex;
  opportunities: Opportunity[];
  pautas: Pauta[];
  appointments: Appointment[];
  tasks: Task[];
}

const cache = new WeakMap<Contact[], CacheEntry>();

export function getChatIndex(data: ChatDataset): ChatIndex {
  const existing = cache.get(data.contacts);
  if (
    existing &&
    existing.opportunities === data.opportunities &&
    existing.pautas === data.pautas &&
    existing.appointments === data.appointments &&
    existing.tasks === data.tasks
  ) {
    return existing.index;
  }
  const index = buildChatIndex(data);
  cache.set(data.contacts, {
    index,
    opportunities: data.opportunities,
    pautas: data.pautas,
    appointments: data.appointments,
    tasks: data.tasks,
  });
  return index;
}
