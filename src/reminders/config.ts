import { type MailSettings, validEmail } from "./mail.js";

export function loadReminderConfig(env: Record<string, string | undefined>) {
  if (env.EMAIL_DELIVERY_ENABLED !== "true")
    throw new Error(
      "Set EMAIL_DELIVERY_ENABLED=true to start the reminder worker.",
    );
  if (!env.MONGO_URI?.trim())
    throw new Error("The reminder worker requires MONGO_URI.");
  const host = env.SMTP_HOST?.trim();
  if (!host) throw new Error("The reminder worker requires SMTP_HOST.");
  const port = Number(env.SMTP_PORT ?? "1025");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("SMTP_PORT must be an integer between 1 and 65535.");
  if (
    env.SMTP_SECURE !== undefined &&
    !["true", "false"].includes(env.SMTP_SECURE)
  )
    throw new Error("SMTP_SECURE must be true or false.");
  const from = env.SMTP_FROM ?? "reminders@usthing.invalid";
  if (!validEmail(from)) throw new Error("SMTP_FROM must be an email address.");
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD))
    throw new Error("SMTP_USER and SMTP_PASSWORD must be configured together.");
  const mail: MailSettings = {
    host,
    port,
    from,
    secure: env.SMTP_SECURE === "true",
    ...(env.SMTP_USER
      ? { user: env.SMTP_USER, password: env.SMTP_PASSWORD }
      : {}),
  };
  return { mongoUri: env.MONGO_URI, mail };
}
