import nodemailer from "nodemailer";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { EventDocument } from "../events/domain/model.js";
import type { Reminder } from "./planning.js";

const emailValidator = Compile(
  Type.String({ format: "email", maxLength: 254 }),
);
export const validEmail = (value: unknown): value is string =>
  emailValidator.Check(value);
export type MailSettings = {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  password?: string;
};
export class DeliveryError extends Error {
  constructor(readonly retryable: boolean) {
    // Do not persist SMTP responses containing addresses, credentials or event text.
    super(
      retryable
        ? "Temporary SMTP delivery failure."
        : "Permanent SMTP delivery failure.",
    );
  }
}
export type SendReminder = (
  to: string,
  event: EventDocument,
  reminder: Reminder,
) => Promise<void>;

export function createMailer(settings: MailSettings) {
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.user
      ? { auth: { user: settings.user, pass: settings.password } }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const send: SendReminder = async (to, event, reminder) => {
    const start =
      event.schedule.kind === "all-day"
        ? `${event.schedule.startsOn} (all day, Hong Kong)`
        : `${new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Hong_Kong",
            dateStyle: "full",
            timeStyle: "short",
          }).format(event.schedule.startsAt)} (Hong Kong)`;
    try {
      await transport.sendMail({
        from: { name: "USThing", address: settings.from },
        to: { address: to, name: "" },
        subject: `Reminder: ${event.title.replace(/[\r\n]/g, " ")}`,
        messageId: `<${reminder.key}@usthing.invalid>`,
        text: [
          event.title,
          `When: ${start}`,
          event.location ? `Where: ${event.location}` : "",
          event.description ?? "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    } catch (error) {
      const code = (error as { responseCode?: number }).responseCode;
      throw new DeliveryError(code === undefined || code < 500);
    }
  };
  return { send, close: () => transport.close() };
}
