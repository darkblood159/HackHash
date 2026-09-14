#!/bin/sh
set -e

echo "Applying database migrations..."
if ! npx prisma migrate deploy; then
  echo ""
  echo "=================================================================="
  echo " Migrations failed to apply."
  echo ""
  echo " This usually means a PREVIOUS migration attempt got cut off"
  echo " partway through (the container was restarted, lost its"
  echo " connection to the database, etc.) and Prisma is now refusing to"
  echo " run anything else until it's told what actually happened. This"
  echo " is Prisma's own bookkeeping being unsure, not your data being"
  echo " damaged."
  echo ""
  echo " See the \"If a migration fails on startup (P3009)\" section of"
  echo " DOCKER_PORTAINER_GUIDE.md for exactly how to check what really"
  echo " happened and get this container running again."
  echo "=================================================================="
  exit 1
fi

echo "Starting server..."
exec "$@"
