import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { CALENDAR_RANGE_MAX_DAYS } from "./query-schemas.js";
import { resolveRecurrence } from "./recurrence.js";
import { ResolvedRecurrenceSchema } from "./recurrence-schema.js";
import { ScheduleSchema } from "./schemas.js";
import { EventValidationError } from "./validation.js";

const DAY_MS = 86_400_000;
const HK_OFFSET_MS = 8 * 60 * 60 * 1000;
// An inclusive 12-calendar-month daily series can have 367 starts in a leap year.
export const MAX_OCCURRENCES_PER_SERIES = 367;

const SourceSchema = Type.Object(
  {
    schedule: ScheduleSchema,
    recurrence: Type.Optional(ResolvedRecurrenceSchema),
  },
  { additionalProperties: false },
);
const RangeSchema = Type.Object(
  {
    from: Type.String({ format: "date" }),
    to: Type.String({ format: "date" }),
  },
  { additionalProperties: false },
);
const sourceValidator = Compile(SourceSchema);
const rangeValidator = Compile(RangeSchema);

export type OccurrenceSource = Static<typeof SourceSchema>;
export type OccurrenceRange = Static<typeof RangeSchema>;
export type Occurrence = {
  /** Pair with the authenticated, stored series ID; this value is not authorization. */
  originalStart: string;
  schedule: OccurrenceSource["schedule"];
};

/**
 * Pure expansion of an already-resolved series (or one normal event).
 * Revalidates at runtime, jumps directly to the overlapping index interval,
 * and never persists generated occurrences. Exceptions are not supported yet.
 * The caller must load an owned series and enforce an aggregate response budget.
 */
export function generateOccurrences(
  source: OccurrenceSource,
  range: OccurrenceRange,
): Occurrence[] {
  return expand(source, range);
}

/** Full finite series, bounded by the same 367-start invariant. */
export function generateAllOccurrences(source: OccurrenceSource): Occurrence[] {
  return expand(source);
}

function expand(
  source: OccurrenceSource,
  range?: OccurrenceRange,
): Occurrence[] {
  if (
    !sourceValidator.Check(source) ||
    (range !== undefined && !rangeValidator.Check(range))
  )
    throw new EventValidationError(
      "Invalid occurrence source or date range. Recurrence requires a resolved endsOn.",
    );
  const rangeStart = range ? hkMidnight(range.from) : -Infinity;
  const rangeEnd = range ? hkMidnight(range.to) : Infinity;
  const rangeDays = (rangeEnd - rangeStart) / DAY_MS;
  if (range && !(rangeDays > 0 && rangeDays <= CALENDAR_RANGE_MAX_DAYS))
    throw new EventValidationError(
      `Date range must be between 1 and ${CALENDAR_RANGE_MAX_DAYS} days.`,
    );
  const { schedule, recurrence } = source;
  const start =
    schedule.kind === "timed"
      ? Date.parse(schedule.startsAt)
      : hkMidnight(schedule.startsOn);
  const end =
    schedule.kind === "timed"
      ? Date.parse(schedule.endsAt)
      : hkMidnight(schedule.endsOn);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new EventValidationError("Occurrence end must be after its start.");

  // Validate the entire rule even for an empty requested window; no early bypass.
  if (recurrence) resolveRecurrence(schedule, recurrence);
  const period = recurrence?.frequency === "weekly" ? 7 * DAY_MS : DAY_MS;
  if (schedule.kind === "timed") calendarDate(start);
  const firstDay = calendarDate(start + HK_OFFSET_MS);
  const lastIndex = recurrence
    ? Math.floor(
        (hkMidnight(recurrence.endsOn) - hkMidnight(firstDay)) / period,
      )
    : 0;
  if (lastIndex < 0 || lastIndex + 1 > MAX_OCCURRENCES_PER_SERIES)
    throw new EventValidationError("Series exceeds the occurrence limit.");
  // Refuse unrepresentable shifted dates rather than emitting invalid schedules.
  calendarDate(
    end + lastIndex * period + (schedule.kind === "all-day" ? HK_OFFSET_MS : 0),
  );
  // Half-open intervals: an end at from or a start at to is not an overlap.
  // Using end directly avoids subtracting a potentially very long duration.
  const first = Math.max(0, Math.floor((rangeStart - end) / period) + 1);
  const last = Math.min(lastIndex, Math.ceil((rangeEnd - start) / period) - 1);
  const count = Math.max(0, last - first + 1);
  if (count > MAX_OCCURRENCES_PER_SERIES)
    throw new EventValidationError(
      "Occurrence result exceeds the output limit.",
    );

  return Array.from({ length: count }, (_, index) => {
    const shiftedStart = start + (first + index) * period;
    const shiftedEnd = end + (first + index) * period;
    if (schedule.kind === "timed") {
      const startsAt = new Date(shiftedStart).toISOString();
      return {
        originalStart: startsAt,
        schedule: {
          kind: "timed" as const,
          startsAt,
          endsAt: new Date(shiftedEnd).toISOString(),
        },
      };
    }
    const startsOn = calendarDate(shiftedStart + HK_OFFSET_MS);
    return {
      originalStart: startsOn,
      schedule: {
        kind: "all-day" as const,
        startsOn,
        endsOn: calendarDate(shiftedEnd + HK_OFFSET_MS),
      },
    };
  });
}

function hkMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

function calendarDate(timestamp: number): string {
  const value = new Date(timestamp).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new EventValidationError(
      "Occurrence is outside the supported calendar range.",
    );
  return value;
}
