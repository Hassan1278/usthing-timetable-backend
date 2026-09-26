import { MongoClient } from "mongodb";
import { withDefaultMongoDatabase } from "../plugins/init-mongo.js";
import { loadReminderConfig } from "./config.js";
import { createMailer } from "./mail.js";
import { createReminderScheduler } from "./scheduler.js";

const config = loadReminderConfig(Bun.env);
const client = new MongoClient(
  withDefaultMongoDatabase(config.mongoUri, "template-api"),
);
await client.connect();
const mailer = createMailer(config.mail);
const worker = await createReminderScheduler(client.db(), mailer.send, {
  log: (message, jobId) => console.error(JSON.stringify({ message, jobId })),
});
const health = Bun.serve({
  hostname: "127.0.0.1",
  port: 3001,
  async fetch() {
    try {
      const ready = await worker.isReady();
      return new Response(ready ? "ready" : "unavailable", {
        status: ready ? 200 : 503,
      });
    } catch {
      return new Response("unavailable", { status: 503 });
    }
  },
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  health.stop();
  await worker.stop();
  mailer.close();
  await client.close();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
await worker.start();
console.info("Reminder worker started.");
