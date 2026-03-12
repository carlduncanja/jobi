#!/bin/bash
set -e

mkdir -p /data/surreal /data/attachments

echo "Starting SurrealDB..."
surreal start \
  surrealkv:/data/surreal \
  --bind 0.0.0.0:8000 \
  --user root \
  --pass "${SURREAL_PASSWORD:-root}" \
  --no-banner \
  -l warn &

SURREAL_PID=$!

# Wait for SurrealDB to be ready
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8000/health > /dev/null 2>&1; then
    echo "SurrealDB is ready"
    break
  fi
  if ! kill -0 $SURREAL_PID 2>/dev/null; then
    echo "SurrealDB failed to start"
    exit 1
  fi
  sleep 1
done

echo "Starting Job Bot..."
exec bun run src/index.ts
