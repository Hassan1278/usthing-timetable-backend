/**
 * A user defined in the static internal token table.
 *
 * Identities are declared in code; requests authenticate by presenting the
 * bearer token of one of these users.
 */
export type InternalUser = {
  /** Immutable user identifier used for resource ownership. */
  id: string;
  /** The user's username exposed on `request.user` inside `withAuth` scopes. */
  username: string;
  /** The user's display name; may be null. */
  name: string | null;
  /** Internal seed address; never included in the public authenticated identity. */
  email: string;
  /**
   * The bearer token the user authenticates with. Tokens act as passwords:
   * replace these samples before deploying and never commit real secrets.
   */
  token: string;
};

// Sample users for local development and tests. These tokens act as passwords
// and must be replaced with real secrets before any real deployment.
export const users: InternalUser[] = [
  {
    id: "0f5551bd-10be-41dc-bd28-827ed4b49a67",
    username: "alice",
    name: "Alice",
    token: "alice-dev-token",
    email: "alice@example.invalid",
  },
  {
    id: "1ba1e239-12d8-4b8f-8d8f-d9e04e76ca8e",
    username: "bob",
    name: "Bob",
    token: "bob-dev-token",
    email: "bob@example.invalid",
  },
];
