import ICAL from "ical.js";
import type { Collection } from "mongodb";
import type { EventDocument } from "../domain/model.js";
import {
  baseOccurrences,
  CalendarCapacityError,
  expandEvent,
  MAX_EXPANDED_OCCURRENCES,
  overlapsRange,
} from "../recurrence/series.js";
import type { ListEventsQuery } from "../schemas/query.js";
import { buildEventFilter } from "../services/events.js";

export const ICS_EXPORT_LIMIT = 1000;

export class CalendarExportLimitError extends Error {
  constructor() {
    super(
      "Export exceeds its limits (1000 scanned events, 5000 components or 16 MiB). Select a smaller range or reduce calendar data.",
    );
  }
}

/** Bounded export: never silently truncate a user's calendar. */
export async function exportCalendar(
  collection: Collection<EventDocument>,
  query: Pick<ListEventsQuery, "from" | "to">,
  ownerId: string,
): Promise<string> {
  const filter = buildEventFilter(query, ownerId);
  const cursor = collection
    .find(
      query.from
        ? { ownerId, $or: [filter, { recurrence: { $exists: true } }] }
        : { ownerId },
    )
    .sort({ _id: 1 })
    .limit(ICS_EXPORT_LIMIT + 1)
    .maxTimeMS(5000)
    .batchSize(10);
  const events: EventDocument[] = [];
  const budget = { remaining: MAX_EXPANDED_OCCURRENCES };
  let scanned = 0,
    retainedBytes = 0;
  try {
    for await (const event of cursor) {
      if (++scanned > ICS_EXPORT_LIMIT) throw new CalendarExportLimitError();
      if (
        query.from &&
        query.to &&
        !expandEvent(event, budget).some((item) =>
          overlapsRange(item, query.from!, query.to!),
        )
      )
        continue;
      retainedBytes += Buffer.byteLength(JSON.stringify(event));
      if (retainedBytes > 16 * 1024 * 1024)
        throw new CalendarExportLimitError();
      events.push(event);
    }
  } finally {
    await cursor.close();
  }
  return serializeCalendar(events);
}

/** Standard calendar data only: no account IDs, tokens or email instructions. */
export function serializeCalendar(events: EventDocument[]): string {
  const calendar = new ICAL.Component("vcalendar");
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//USThing//Custom Timetable//EN");
  calendar.addPropertyWithValue("calscale", "GREGORIAN");
  let components = 0;
  let expanded = 0;
  for (const event of events) {
    if (++components > 5000) throw new CalendarExportLimitError();
    const entry = calendarEntry(event);
    if (event.recurrence) {
      const base = baseOccurrences(event);
      expanded += base.length;
      if (expanded > MAX_EXPANDED_OCCURRENCES)
        throw new CalendarCapacityError();
      entry.addPropertyWithValue(
        "rrule",
        ICAL.Recur.fromString(
          `FREQ=${event.recurrence.frequency.toUpperCase()};COUNT=${base.length}`,
        ),
      );
      const effective = expandEvent(event);
      for (const exception of event.exceptions ?? []) {
        const original =
          event.schedule.kind === "timed"
            ? ICAL.Time.fromJSDate(
                new Date(
                  Math.floor(Date.parse(exception.originalStart) / 1000) * 1000,
                ),
                true,
              )
            : ICAL.Time.fromDateString(exception.originalStart);
        if (exception.cancelled) entry.addPropertyWithValue("exdate", original);
        else {
          if (++components > 5000) throw new CalendarExportLimitError();
          const override = effective.find(
            (item) => item.originalStart === exception.originalStart,
          );
          if (!override) throw new Error("Missing validated exception.");
          const detached = calendarEntry(override);
          detached.addPropertyWithValue("recurrence-id", original);
          calendar.addSubcomponent(detached);
        }
      }
    }
    calendar.addSubcomponent(entry);
  }
  const output = `${calendar.toString()}\r\n`;
  if (Buffer.byteLength(output) > 16 * 1024 * 1024)
    throw new CalendarExportLimitError();
  return output;
}

function calendarEntry(event: EventDocument): ICAL.Component {
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
    entry.addPropertyWithValue("description", calendarText(event.description));
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
  return entry;
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
