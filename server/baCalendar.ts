import type { BaAgendaEvent, BaCustomer, Cached } from "../shared/baCustomers.ts";
import type { Attendee, CalendarEvent, CalendarInfo, MacCalendarStatus } from "../shared/calendar.ts";
import { getBaFlags } from "./baEdition.ts";
import { domainOf, groupName } from "../shared/baCustomers.ts";
import { cached, connectorCall, dropCache, parseJson } from "./baConnector.ts";

/**
 * Your agenda through the claude.ai Google Calendar connector: the calendar Claude
 * already reads, with no Google Cloud project, OAuth client or macOS permission.
 * One exact list_events call, parsed here, cached for 10 minutes, and matched to
 * customers by attendee email domain or name.
 */

const LIST = "mcp__claude_ai_Google_Calendar__list_events";

/** Local time without offset, as the connector wants it. */
const local = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
};

const str = (...v: unknown[]) => v.find((x): x is string => typeof x === "string" && x.trim().length > 0)?.trim() ?? null;
const when = (v: any): { at: number | null; allDay: boolean } => {
  const s = str(v?.dateTime, v?.date_time, v?.date, typeof v === "string" ? v : null);
  if (!s) return { at: null, allDay: false };
  const allDay = /^\d{4}-\d\d-\d\d$/.test(s);
  const t = Date.parse(allDay ? `${s}T00:00:00` : s);
  return { at: Number.isNaN(t) ? null : t, allDay };
};

function parseEvents(raw: string): Omit<BaAgendaEvent, "projectId">[] {
  const p = parseJson(raw);
  const list: any[] = Array.isArray(p) ? p : (p?.events ?? p?.items ?? p?.results ?? []);
  return list
    .map((e) => {
      const start = when(e.start ?? e.startTime);
      const end = when(e.end ?? e.endTime);
      const attendees = (Array.isArray(e.attendees) ? e.attendees : []).map((a: any) => ({
        email: str(a?.email, typeof a === "string" ? a : null),
        name: str(a?.displayName, a?.name, a?.email),
        response: str(a?.responseStatus, a?.response),
        self: a?.self === true,
      }));
      return {
        id: String(e.id ?? e.eventId ?? `${e.summary}-${start.at}`),
        title: str(e.summary, e.title) ?? "(no title)",
        start: start.at,
        end: end.at,
        allDay: start.allDay,
        location: str(e.location),
        meetLink: str(e.hangoutLink, e.conferenceData?.entryPoints?.find?.((x: any) => x?.entryPointType === "video")?.uri, e.meetLink),
        link: str(e.htmlLink, e.link),
        description: str(e.description)?.replace(/<[^>]+>/g, " ").slice(0, 600) ?? null,
        attendees: attendees.filter((a: { email: string | null; name: string | null }) => a.email || a.name),
        declined: attendees.some((a: { self: boolean; response: string | null }) => a.self && a.response === "declined"),
      };
    })
    .filter((e) => e.start !== null)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

export function matchCustomer(e: Pick<BaAgendaEvent, "title" | "description" | "attendees">, customers: BaCustomer[]): number | null {
  const doms = new Set(e.attendees.map((a) => (a.email ? domainOf(a.email) : null)).filter(Boolean));
  const text = ` ${`${e.title} ${e.description ?? ""}`.toLowerCase()} `;
  const byDomain = customers.find((c) => c.domains.some((d) => doms.has(d)));
  if (byDomain) return byDomain.projectId;
  const byName = customers.find((c) => [c.name, ...c.deals.map((d) => groupName(d.name))].some((n) => n.length >= 4 && text.includes(n.toLowerCase())));
  return byName?.projectId ?? null;
}

export async function agenda(days: number, refresh: boolean, customers: BaCustomer[]): Promise<Cached<BaAgendaEvent[]>> {
  const span = Math.min(Math.max(Math.round(days) || 2, 1), 14);
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + span * 86_400_000);
  const res = await cached(
    `agenda:${local(from).slice(0, 10)}:${span}`,
    refresh,
    async () =>
      parseEvents(
        await connectorCall(LIST, { startTime: local(from), endTime: local(to), orderBy: "startTime", pageSize: 150 }, "Show the user's upcoming meetings on their dashboard, matched to their customers."),
      ),
    10 * 60_000,
  );
  return { ...res, data: res.data?.map((e) => ({ ...e, projectId: matchCustomer(e, customers) })) ?? null };
}

// ── as a source for the dashboard's own Calendar page ────────────────────────


/** The connector feeds the Calendar page, Home and Delivery when its switch is on. */
export const connectorCalendarOn = () => {
  const f = getBaFlags();
  return f.enabled && f.calendar;
};

export const CONNECTOR_CALENDAR_ID = "claude:primary";

export const CONNECTOR_CALENDAR: CalendarInfo = {
  id: CONNECTOR_CALENDAR_ID,
  title: "Google Calendar (via Claude)",
  account: "claude.ai connector",
  color: "#4285f4",
  editable: false,
  isDefault: false,
};

/** Rein's page asks whether the Mac calendar is on; with the connector it can show events either way. */
export function withConnectorStatus(mac: MacCalendarStatus): MacCalendarStatus {
  // Off, or on without macOS permission: the connector still shows the calendar.
  return connectorCalendarOn() && (!mac.enabled || mac.access !== "granted") ? { available: true, enabled: true, access: "granted" } : mac;
}

const replyOf = (r: string | null): Attendee["status"] => (r === "accepted" ? "accepted" : r === "declined" ? "declined" : r === "tentative" ? "tentative" : "pending");

/** Events for any range the Calendar page asks for, read through the connector and cached per range. */
export async function connectorEvents(from: number, to: number): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  if (!connectorCalendarOn()) return { events: [], errors: [] };
  const res = await cached(
    `calrange:${from}:${to}`,
    false,
    async () => parseEvents(await connectorCall(LIST, { startTime: local(new Date(from)), endTime: local(new Date(to)), orderBy: "startTime", pageSize: 250 }, "Show the user's calendar in their dashboard.")),
    10 * 60_000,
    { swr: true },
  );
  const events: CalendarEvent[] = (res.data ?? [])
    .filter((e) => e.start !== null)
    .map((e) => ({
      key: `${e.id}@${e.start}`,
      id: e.id,
      externalId: null,
      occurrence: e.start!,
      calendarId: CONNECTOR_CALENDAR_ID,
      calendar: CONNECTOR_CALENDAR.title,
      account: CONNECTOR_CALENDAR.account,
      color: CONNECTOR_CALENDAR.color,
      title: e.title,
      start: e.start!,
      // An all-day event ends inside its last day, as the page expects.
      end: e.allDay ? (e.end ?? e.start! + 86_400_000) - 1 : (e.end ?? e.start! + 30 * 60_000),
      allDay: e.allDay,
      location: e.location,
      notes: e.description,
      url: e.meetLink ?? e.link,
      recurring: false,
      editable: false,
      attendees: e.attendees.map((a) => ({ name: a.name ?? a.email ?? "", status: replyOf(a.response), email: a.email, room: /resource\.calendar\.google\.com$/.test(a.email ?? ""), me: a.self })),
    }));
  return { events, errors: res.error ? [`Google Calendar via Claude: ${res.error}`] : [] };
}

export const dropConnectorCalendar = () => dropCache("calrange:%");
