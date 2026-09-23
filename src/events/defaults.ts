import type { CreateEventInput, EmailNotificationsInput } from "./schemas.js";

export type ResolvedEmailNotifications =
  | { enabled: false }
  | { enabled: true; minutesBefore: number[] };

export type EventWithDefaults = Omit<CreateEventInput, "emailNotifications"> & {
  emailNotifications: ResolvedEmailNotifications;
};

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

  return { ...input, emailNotifications: resolveEmailNotifications(settings) };
}
