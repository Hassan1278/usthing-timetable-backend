import ICAL from "ical.js";
import type { Collection } from "mongodb";
import type { EventDocument } from "./model.js";
import type { ListEventsQuery } from "./query-schemas.js";
import { buildEventFilter } from "./service.js";

export const ICS_EXPORT_LIMIT = 1000;

export class CalendarExportLimitError extends Error {
  constructor() {
    super(
      "Export is limited to 1000 events. Select a smaller from/to date range.",
    );
  }
}

/** Bounded export: never silently truncate a user's calendar. */
export async function exportCalendar(
  collection: Collection<EventDocument>,
  query: Pick<ListEventsQuery, "from" | "to">,
  ownerId: string,
): Promise<string> {
  const events = await collection
    .find(buildEventFilter(query, ownerId))
    .sort({ _id: 1 })
    .limit(ICS_EXPORT_LIMIT + 1)
    .toArray();
  if (events.length > ICS_EXPORT_LIMIT) throw new CalendarExportLimitError();
  return serializeCalendar(events);
}

/** Standard calendar data only: no account IDs, tokens or email instructions. */
export function serializeCalendar(events: EventDocument[]): string {
  const calendar = new ICAL.Component("vcalendar");
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//USThing//Custom Timetable//EN");
  calendar.addPropertyWithValue("calscale", "GREGORIAN");
  for (const event of events) {
    const entry = new ICAL.Component("vevent");
    entry.addPropertyWithValue("uid", event.uid);
    entry.addPropertyWithValue(
      "dtstamp",
      ICAL.Time.fromJSDate(event.updatedAt, true),
    );
    entry.addPropertyWithValue(
      "last-modified",
      ICAL.Time.fromJSDate(event.updatedAt, true),
    );
    entry.addPropertyWithValue("sequence", event.revision - 1);
    entry.addPropertyWithValue("summary", calendarText(event.title));
    if (event.description !== undefined)
      entry.addPropertyWithValue(
        "description",
        calendarText(event.description),
      );
    if (event.location !== undefined)
      entry.addPropertyWithValue("location", calendarText(event.location));
    // ICS has second precision. Round outwards so a short event never collapses.
    const schedule = event.schedule;
    entry.addPropertyWithValue(
      "dtstart",
      schedule.kind === "timed"
        ? ICAL.Time.fromJSDate(
            new Date(Math.floor(schedule.startsAt.getTime() / 1000) * 1000),
            true,
          )
        : ICAL.Time.fromDateString(schedule.startsOn),
    );
    entry.addPropertyWithValue(
      "dtend",
      schedule.kind === "timed"
        ? ICAL.Time.fromJSDate(
            new Date(Math.ceil(schedule.endsAt.getTime() / 1000) * 1000),
            true,
          )
        : ICAL.Time.fromDateString(schedule.endsOn),
    );
    calendar.addSubcomponent(entry);
  }
  return `${calendar.toString()}\r\n`;
}

/** Normalize line endings before library escaping; omit invalid ICS controls. */
function calendarText(value: string): string {
  return Array.from(value.replace(/\r\n?/g, "\n"))
    .filter(
      (character) =>
        character === "\n" ||
        character === "\t" ||
        (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    )
    .join("");
}
