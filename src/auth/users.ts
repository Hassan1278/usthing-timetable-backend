/**
 * A user defined in the static internal token table.
 *
 * Identities are declared in code; requests authenticate by presenting the
 * bearer token of one of these users.
 */
export type InternalUser = {
  /** The user's username exposed on `request.user` inside `withAuth` scopes. */
  username: string;
  /** The user's display name; may be null. */
  name: string | null;
  /**
   * The bearer token the user authenticates with. Tokens act as passwords:
   * replace these samples before deploying and never commit real secrets.
   */
  token: string;
};

// Sample users for local development and tests. These tokens act as passwords
// and must be replaced with real secrets before any real deployment.
export const users: InternalUser[] = [
  { username: "alice", name: "Alice", token: "alice-dev-token" },
  { username: "bob", name: "Bob", token: "bob-dev-token" },
];
