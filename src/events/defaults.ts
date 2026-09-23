import type { CreateEventInput, EmailNotificationsInput } from "./schemas.js";

export type ResolvedEmailNotifications =
  | { enabled: false }
  | { enabled: true; minutesBefore: number[] };

export type EventWithDefaults = Omit<CreateEventInput, "emailNotifications"> & {
  emailNotifications: ResolvedEmailNotifications;
};

const DEFAULT_REMINDER_MINUTES = [1440, 120] as const;

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

  const emailNotifications: ResolvedEmailNotifications = settings.enabled
    ? {
        enabled: true,
        minutesBefore: [
          ...(settings.minutesBefore ?? DEFAULT_REMINDER_MINUTES),
        ],
      }
    : { enabled: false };

  return { ...input, emailNotifications };
}
