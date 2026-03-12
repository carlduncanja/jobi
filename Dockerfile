# Stage 1: Install dependencies
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Stage 2: Production image
FROM oven/bun:1.3
WORKDIR /app

# Install SurrealDB
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates bash && \
    curl -sSf https://install.surrealdb.com | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY tsconfig.json ./

RUN mkdir -p /data/attachments /data/surreal

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 3000
CMD ["./entrypoint.sh"]
