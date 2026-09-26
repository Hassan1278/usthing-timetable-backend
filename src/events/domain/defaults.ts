import { resolveRecurrence } from "../recurrence/defaults.js";
import type {
  CreateEventInput,
  EmailNotificationsInput,
} from "../schemas/event.js";
import type { ResolvedRecurrence } from "../schemas/recurrence.js";

export type ResolvedEmailNotifications =
  | { enabled: false }
  | { enabled: true; minutesBefore: number[] };

export type EventWithDefaults = Omit<
  CreateEventInput,
  "emailNotifications" | "recurrence" | "color"
> & {
  color: string;
  emailNotifications: ResolvedEmailNotifications;
  recurrence?: ResolvedRecurrence;
};

/** Defaults are applied once; changing category does not overwrite a saved color. */
export const DEFAULT_EVENT_COLORS: Readonly<
  Record<CreateEventInput["eventType"], string>
> = {
  class: "#2563EB",
  appointment: "#DC2626",
  club: "#7C3AED",
  study: "#16A34A",
  personal: "#DB2777",
  other: "#64748B",
};

export function resolveEventColor(
  event: Pick<CreateEventInput, "color" | "eventType">,
): string {
  return event.color ?? DEFAULT_EVENT_COLORS[event.eventType];
}

const DEFAULT_REMINDER_MINUTES = [1440, 120] as const;

/** Resolve explicit settings; callers decide what an omitted field means. */
export function resolveEmailNotifications(
  settings: EmailNotificationsInput,
): ResolvedEmailNotifications {
  return settings.enabled
    ? {
        enabled: true,
        minutesBefore: [
          ...(settings.minutesBefore ?? DEFAULT_REMINDER_MINUTES),
        ],
      }
    : { enabled: false };
}

/**
 * Apply defaults after validating a manual create request with CreateEventSchema.
 * Updates and imports have different omission rules and must not use this helper.
 */
export function applyCreateEventDefaults(
  input: CreateEventInput,
): EventWithDefaults {
  const settings: EmailNotificationsInput = input.emailNotifications ?? {
    enabled: input.eventType === "appointment",
  };

  const { recurrence, ...fields } = input;
  const resolved = resolveRecurrence(input.schedule, recurrence);
  return {
    ...fields,
    color: resolveEventColor(input),
    emailNotifications: resolveEmailNotifications(settings),
    ...(resolved ? { recurrence: resolved } : {}),
  };
}
