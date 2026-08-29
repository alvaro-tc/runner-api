#!/usr/bin/env bash
#
# Copia de seguridad de Postgres, comprimida y con rotacion de 7 dias.
#
# Cron (diario a las 03:15, hora del VPS):
#   sudo crontab -u postgres -e
#   15 3 * * * /opt/running-api/current/scripts/backup-db.sh >> /var/log/paceup-backup.log 2>&1
#
# Restauracion (probada, ver docs/despliegue.md):
#   sudo -u postgres dropdb paceup && sudo -u postgres createdb -O paceup paceup
#   gunzip -c /var/backups/paceup/paceup-2026-08-20.sql.gz | sudo -u postgres psql paceup

set -euo pipefail

DB_NAME="${DB_NAME:-paceup}"
DEST="${DEST:-/var/backups/paceup}"
DIAS="${DIAS:-7}"

mkdir -p "$DEST"
ARCHIVO="$DEST/$DB_NAME-$(date +%F).sql.gz"

# A un temporal y luego mv: si el pg_dump se corta a la mitad —disco lleno, VPS
# reiniciado— el fichero incompleto no llega a ocupar el nombre del dia. Un
# backup corrupto que parece bueno es peor que no tener backup.
TMP="$ARCHIVO.parcial"
trap 'rm -f "$TMP"' EXIT

# --clean --if-exists: el volcado se puede restaurar sobre una base con datos.
pg_dump --format=plain --clean --if-exists "$DB_NAME" | gzip -9 > "$TMP"

# Un volcado de esta base nunca baja de unos pocos KB; si sale menos, algo fallo
# aunque pg_dump haya devuelto 0.
TAM=$(stat -c %s "$TMP")
if [ "$TAM" -lt 4096 ]; then
	echo "✗ El volcado son solo $TAM bytes: no se guarda" >&2
	exit 1
fi

mv "$TMP" "$ARCHIVO"
trap - EXIT
echo "✓ $ARCHIVO ($(numfmt --to=iec "$TAM"))"

# Rotacion: se borra por fecha de modificacion, no por nombre.
find "$DEST" -maxdepth 1 -name "$DB_NAME-*.sql.gz" -mtime "+$DIAS" -print -delete

# Un backup que nunca se restauro no es un backup. La prueba de restauracion
# esta en docs/despliegue.md y toca hacerla cada tanto, no solo el dia del
# incendio. ponytail: sin verificacion automatica; si el dato importa de verdad,
# restaurar semanalmente en una base desechable desde cron.
