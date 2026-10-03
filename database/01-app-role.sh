#!/bin/sh
# Creates the least-privilege login the API uses. The password comes from the
# environment at first boot and is never written into the repository.
set -eu

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo "APP_DB_PASSWORD is required to create nodevault_app" >&2
  exit 1
fi

escaped=$(printf '%s' "$APP_DB_PASSWORD" | sed "s/'/''/g")

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nodevault_app') THEN
    CREATE ROLE nodevault_app LOGIN PASSWORD '${escaped}';
  ELSE
    ALTER ROLE nodevault_app WITH LOGIN PASSWORD '${escaped}';
  END IF;
END
\$\$;
SQL
