import { resolveRecurrence } from "../recurrence/defaults.js";
import type {
  CreateEventInput,
  EmailNotificationsInput,
} from "../schemas/event.js";
import type { ResolvedRecurrence } from "../schemas/recurrence.js";
import { assertEmailDisabled } from "./validation.js";

export type ResolvedEmailNotifications =
  | { enabled: false }
  | { enabled: true; minutesBefore: number[] };

export type EventWithDefaults = Omit<
  CreateEventInput,
  "emailNotifications" | "recurrence"
> & {
  emailNotifications: ResolvedEmailNotifications;
  recurrence?: ResolvedRecurrence;
};

/** Resolve explicit settings; callers decide what an omitted field means. */
export function resolveEmailNotifications(
  settings: EmailNotificationsInput,
): ResolvedEmailNotifications {
  assertEmailDisabled(settings);
  return { enabled: false };
}

/**
 * Apply defaults after validating a manual create request with CreateEventSchema.
 * Updates and imports have different omission rules and must not use this helper.
 */
export function applyCreateEventDefaults(
  input: CreateEventInput,
): EventWithDefaults {
  const settings: EmailNotificationsInput = input.emailNotifications ?? {
    enabled: false,
  };

  const { recurrence, ...fields } = input;
  const resolved = resolveRecurrence(input.schedule, recurrence);
  return {
    ...fields,
    emailNotifications: resolveEmailNotifications(settings),
    ...(resolved ? { recurrence: resolved } : {}),
  };
}
