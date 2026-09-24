import type {
  RecurrenceInput,
  ResolvedRecurrence,
} from "./recurrence-schema.js";
import type { CreateEventInput } from "./schemas.js";
import { EventValidationError } from "./validation.js";

/**
 * Call after structural validation. Resolve once when a series is created,
 * never extend the stored end on reads or unrelated edits.
 */
export function resolveRecurrence(
  schedule: CreateEventInput["schedule"],
  recurrence: RecurrenceInput | undefined,
): ResolvedRecurrence | undefined {
  if (recurrence === undefined) return undefined;
  const startsOn =
    schedule.kind === "all-day"
      ? schedule.startsOn
      : new Date(Date.parse(schedule.startsAt) + 8 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
  // A recurrence date must fit the schema's four-digit calendar year.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn))
    throw new EventValidationError(
      "Recurrence start is outside the supported calendar range.",
    );
  const year = Number(startsOn.slice(0, 4)) + 1;
  if (year > 9999)
    throw new EventValidationError(
      "Recurrence needs a start year before 9999.",
    );
  // Only February 29 needs clamping when adding one calendar year.
  const monthDay = startsOn.slice(5) === "02-29" ? "02-28" : startsOn.slice(5);
  const latestEnd = `${String(year).padStart(4, "0")}-${monthDay}`;
  const endsOn = recurrence.endsOn ?? latestEnd;
  if (endsOn < startsOn)
    throw new EventValidationError(
      "Recurrence endsOn must be on or after the first Hong Kong start date.",
    );
  if (endsOn > latestEnd)
    throw new EventValidationError(
      "Recurrence endsOn must be within 12 calendar months of the first start.",
    );
  return { frequency: recurrence.frequency, endsOn };
}
