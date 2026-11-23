import type { CalendarEvent, CalendarInfo, EventDraft, EventPatch, EventRef, Person } from "../shared/calendar.ts";
import {
  createGoogleEvent,
  deleteGoogleEvent,
  directAccounts,
  googleCalendars,
  googleEvents,
  googleSubscribed,
  parseGoogleCalendarId,
  updateGoogleEvent,
} from "./google.ts";
import { createMacEvent, deleteMacEvent, macCalendars, macEvents, macPeople, updateMacEvent } from "./macCalendar.ts";
import { CONNECTOR_CALENDAR, connectorCalendarOn, connectorEvents } from "./baCalendar.ts";

/**
 * One calendar out of two sources. A Google account that is connected is read and
 * written through Google itself, which answers at once; everything else comes from
 * the Calendar app on this Mac. The Mac also holds a synced copy of a connected
 * account's calendars, and those copies are left out so nothing shows twice.
 */
const GOOGLE_LABEL = /google|gmail/i;

type Sources = { calendars: CalendarInfo[]; macHidden: Set<string>; errors: string[] };

const SOURCES_TTL_MS = 30_000;
const EVENTS_TTL_MS = 5_000;
const EVENTS_KEPT = 40;

let knownSources: { at: number; value: Promise<Sources> } | null = null;
const knownEvents = new Map<string, { at: number; value: Promise<{ events: CalendarEvent[]; errors: string[] }> }>();

/** Forget what was read, after anything that changes a calendar. */
export function invalidateCalendar(): void {
  knownSources = null;
  knownEvents.clear();
}

function sources(): Promise<Sources> {
  if (knownSources && Date.now() - knownSources.at < SOURCES_TTL_MS) return knownSources.value;
  const value = readSources();
  knownSources = { at: Date.now(), value };
  value.catch(() => {
    if (knownSources?.value === value) knownSources = null;
  });
  return value;
}

async function readSources(): Promise<Sources> {
  const errors: string[] = [];
  // BA edition: with the connector on, a Mac calendar macOS has not allowed must not take the page down with it.
  const mac = connectorCalendarOn()
    ? await macCalendars().catch(() => [] as CalendarInfo[])
    : await macCalendars();
  const google = (
    await Promise.all(
      directAccounts().map((account) =>
        googleCalendars(account).catch((e: Error) => {
          errors.push(`${account}: ${e.message}`);
          return [] as CalendarInfo[];
        }),
      ),
    )
  ).flat();
  const names = new Set(google.map((c) => c.title.toLowerCase()));
  const accounts = new Set(google.map((c) => c.account.toLowerCase()));
  const isCopy = (c: CalendarInfo) =>
    names.has(c.title.toLowerCase()) && (GOOGLE_LABEL.test(c.account) || accounts.has(c.account.toLowerCase()) || accounts.has(c.title.toLowerCase()));
  const macHidden = new Set(mac.filter(isCopy).map((c) => c.id));
  const hasGoogleDefault = google.some((c) => c.isDefault);
  const kept = mac.filter((c) => !macHidden.has(c.id)).map((c) => (hasGoogleDefault ? { ...c, isDefault: false } : c));
  // BA edition: Google Calendar through the claude.ai connector, read-only, when no Google account is connected here.
  const viaClaude = connectorCalendarOn() && google.length === 0 ? [CONNECTOR_CALENDAR] : [];
  return { calendars: [...google, ...kept, ...viaClaude], macHidden, errors };
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  return (await sources()).calendars;
}

const byStart = (a: CalendarEvent, b: CalendarEvent) => a.start - b.start || b.end - a.end;

export function listEvents(from: number, to: number): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  const key = `${from}:${to}`;
  const hit = knownEvents.get(key);
  if (hit && Date.now() - hit.at < EVENTS_TTL_MS) return hit.value;
  const value = readEvents(from, to);
  knownEvents.delete(key);
  knownEvents.set(key, { at: Date.now(), value });
  if (knownEvents.size > EVENTS_KEPT) knownEvents.delete(knownEvents.keys().next().value!);
  value.catch(() => {
    if (knownEvents.get(key)?.value === value) knownEvents.delete(key);
  });
  return value;
}

async function readEvents(from: number, to: number): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  const [{ macHidden, errors, calendars }, mac, google, viaClaude] = await Promise.all([
    sources(),
    connectorCalendarOn() ? macEvents(from, to).catch((e: Error) => ({ events: [] as CalendarEvent[], error: e.message })) : macEvents(from, to),
    Promise.all(directAccounts().map((account) => googleEvents(account, from, to).catch((e: Error) => ({ events: [] as CalendarEvent[], errors: [`${account}: ${e.message}`] })))),
    connectorEvents(from, to).catch((e: Error) => ({ events: [] as CalendarEvent[], errors: [e.message] })),
  ]);
  // The connector's events only when its calendar is in the list (no Google account connected here).
  const claude = calendars.some((c) => c.id === CONNECTOR_CALENDAR.id) ? viaClaude : { events: [], errors: [] };
  const unreachable = google.some((g) => g.events.length === 0 && g.errors.length > 0);
  const fromMac = unreachable ? mac.events : mac.events.filter((e) => !macHidden.has(e.calendarId));
  return {
    events: [...fromMac, ...google.flatMap((g) => g.events), ...claude.events].sort(byStart),
    errors: [...errors, ...google.flatMap((g) => g.errors), ...claude.errors],
  };
}

/** People and rooms to suggest: those on your own events, plus the colleagues and rooms subscribed to in Google. */
export async function listPeople(): Promise<Person[]> {
  const [met, subscribed] = await Promise.all([
    // BA edition: with the connector serving the calendar, a Mac calendar without permission gives no suggestions rather than an error.
    connectorCalendarOn() ? macPeople().catch(() => []) : macPeople(),
    Promise.all(directAccounts().map((account) => googleSubscribed(account).catch(() => [] as Person[]))),
  ]);
  const known = new Map(met.map((p) => [p.email.toLowerCase(), p]));
  for (const p of subscribed.flat()) {
    const seen = known.get(p.email.toLowerCase());
    known.set(p.email.toLowerCase(), seen ? { ...seen, name: seen.name === seen.email ? p.name : seen.name, room: seen.room || p.room } : p);
  }
  return [...known.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function createEvent(draft: EventDraft): Promise<void> {
  invalidateCalendar();
  if (parseGoogleCalendarId(draft.calendarId) || draft.google) return createGoogleEvent(draft);
  await createMacEvent(draft);
}

export async function updateEvent(patch: EventPatch): Promise<void> {
  invalidateCalendar();
  if (parseGoogleCalendarId(patch.calendarId)) {
    const { id, occurrence: _occurrence, span: _span, calendarId, seriesId: _seriesId, google: _google, ...fields } = patch;
    return updateGoogleEvent(calendarId!, id, fields);
  }
  const { calendarId: _calendarId, seriesId: _seriesId, ...macPatch } = patch;
  await updateMacEvent(macPatch);
}

export async function deleteEvent(ref: EventRef): Promise<void> {
  invalidateCalendar();
  if (parseGoogleCalendarId(ref.calendarId)) {
    const wholeSeries = ref.span === "future" && ref.seriesId;
    return deleteGoogleEvent(ref.calendarId!, wholeSeries ? ref.seriesId! : ref.id);
  }
  await deleteMacEvent(ref);
}
