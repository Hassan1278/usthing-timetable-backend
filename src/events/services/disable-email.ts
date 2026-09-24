import type { Collection } from "mongodb";
import type { EventDocument } from "../domain/model.js";

/** Idempotent startup migration; each document changes atomically before readiness. */
export async function disableLegacyEmailNotifications(
  events: Collection<EventDocument>,
): Promise<void> {
  await events.updateMany(
    {
      $or: [
        { "emailNotifications.enabled": true },
        { "exceptions.patch.emailNotifications.enabled": true },
      ],
    },
    [
      {
        $set: {
          // Preserve old choices for future development without exposing them in responses.
          emailNotificationArchive: {
            $ifNull: [
              "$emailNotificationArchive",
              {
                settings: "$emailNotifications",
                overrides: {
                  $map: {
                    input: {
                      $filter: {
                        input: { $ifNull: ["$exceptions", []] },
                        as: "exception",
                        cond: {
                          $eq: [
                            "$$exception.patch.emailNotifications.enabled",
                            true,
                          ],
                        },
                      },
                    },
                    as: "exception",
                    in: {
                      originalStart: "$$exception.originalStart",
                      settings: "$$exception.patch.emailNotifications",
                    },
                  },
                },
              },
            ],
          },
          emailNotifications: { $literal: { enabled: false } },
          exceptions: {
            $cond: [
              { $isArray: "$exceptions" },
              {
                $map: {
                  input: "$exceptions",
                  as: "exception",
                  in: {
                    $cond: [
                      {
                        $eq: [
                          "$$exception.patch.emailNotifications.enabled",
                          true,
                        ],
                      },
                      {
                        $mergeObjects: [
                          "$$exception",
                          {
                            patch: {
                              $mergeObjects: [
                                "$$exception.patch",
                                {
                                  emailNotifications: {
                                    $literal: { enabled: false },
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                      "$$exception",
                    ],
                  },
                },
              },
              "$$REMOVE",
            ],
          },
          revision: { $add: ["$revision", 1] },
          updatedAt: "$$NOW",
        },
      },
    ],
  );
}
