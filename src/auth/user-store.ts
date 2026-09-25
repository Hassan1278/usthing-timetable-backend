import type { Collection } from "mongodb";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { InternalUser } from "./users.js";

/** Private profile contract. The stable account UUID is also the MongoDB key. */
const UserDocumentSchema = Type.Object(
  {
    _id: Type.String({ format: "uuid" }),
    username: Type.String({ minLength: 1 }),
    name: Type.Union([Type.String(), Type.Null()]),
    email: Type.String({ format: "email", maxLength: 254 }),
  },
  { additionalProperties: false },
);
export type UserDocument = Static<typeof UserDocumentSchema>;
const validator = Compile(UserDocumentSchema);

/** Seed internal profiles once; restarts must not overwrite saved addresses. */
export async function seedUserProfiles(
  collection: Collection<UserDocument>,
  identities: InternalUser[],
): Promise<void> {
  const profiles = identities.map(({ id, username, name, email }) => ({
    _id: id,
    username,
    name,
    email,
  }));
  if (profiles.some((profile) => !validator.Check(profile)))
    throw new Error("Invalid internal user profile configuration.");
  for (const profile of profiles) {
    await collection.updateOne(
      { _id: profile._id },
      { $setOnInsert: profile },
      { upsert: true },
    );
  }
}
