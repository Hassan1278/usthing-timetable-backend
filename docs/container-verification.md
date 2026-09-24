# Container setup and verification

## Files

- `Dockerfile`: installs production packages from the frozen lockfile in a
  dependency stage, then copies only the runtime dependencies and source into a
  non-root Bun image. Exec-form CMD runs Fastify on 0.0.0.0:3000. SIGTERM and the
  existing Fastify CLI shutdown handler close the server and MongoDB connections.
- `.dockerignore`: allowlists the required build files, excluding .env, Git,
  local packages, caches, tests and documentation from the context.
- `compose.yaml`: starts one API and MongoDB, waits for database health, publishes
  local-only ports, and keeps MongoDB data in the named volume.
- `src/routes/health/index.ts`: readiness check with a bounded MongoDB ping;
  failures return a generic 503 without disclosing connection details.

The build pattern follows the [official Bun Docker guide](https://bun.sh/guides/ecosystem/docker).
The runtime stage does not run TypeScript compilation; run `bun run compile`,
`bun run check` and `bun run test` before building/submitting.

## Verification status

Verified on 24 September 2026:

- TypeScript compilation, Biome checks and all 240 automated tests pass.
- Production-only frozen dependency installation and the Docker image build pass.
- An isolated Compose project starts both services healthy. The API runs as the
  non-root `bun` user (UID 1000) and reaches MongoDB through Compose networking.
- HTTP checks pass for health, authentication, create/read/update/delete, owner
  isolation, overlap rejection and stale-revision rejection.
- An updated event survives `docker compose down` followed by `up -d --wait`:
  containers are recreated and the named database volume retains its contents.
- Only the isolated verification project's test volume is removed after testing;
  existing development volumes are not reset.

## Run the container checks

1. Confirm `docker version` shows both client and server, and `docker compose
   version` succeeds. [Docker's WSL instructions](https://docs.docker.com/desktop/features/wsl/)
   describe enabling the integration.
2. Run `docker compose config --quiet`, then `docker compose up --build -d --wait`.
3. Run `docker compose ps`; both services should be healthy. Fetch `/health`
   and expect status 200. Fetch `/events` without credentials and expect 401.
4. Use the README POST example to create an event with Alice's token. Record
   its ID and ETag; fetch it with GET. Bob's token must receive 404 for that ID.
5. Repeat the same POST with allowConflicts=false and expect 409. PATCH using
   the correct If-Match revision; retry the old revision and expect 412.
6. Run `docker compose down` without `-v`, then `docker compose up -d --wait`.
   Fetch the saved event again; its updated title and revision must persist.
7. DELETE the test event using its latest If-Match revision; expect 204, then
   GET should return 404. Delete only the event created for this check.

For an isolated test stack without touching a running development stack, use a
separate Compose project and ports on every command, for example:

```sh
API_PORT=3001 MONGO_HOST_PORT=27019 docker compose -p usthing-check up --build -d --wait
```

The project name also isolates the database volume. Repeat those port settings
and `-p usthing-check` for subsequent Compose commands. No host Bun installation
is needed to run the containers, only Docker and Compose.
