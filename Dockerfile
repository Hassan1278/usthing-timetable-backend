# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src
USER bun
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(3000) }); process.exit(r.ok ? 0 : 1)"
CMD ["bun", "--bun", "node_modules/fastify-cli/cli.js", "start", "--address=0.0.0.0", "--port=3000", "--log-level=info", "--options", "src/app.ts"]
