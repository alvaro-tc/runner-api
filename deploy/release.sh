#!/usr/bin/env bash
#
# Publica la version que YA esta en el directorio de trabajo del VPS.
#
#   cd /srv/running-api/current
#   git pull            # <- lo hace el operador, a mano y a conciencia
#   sudo -u paceup deploy/release.sh
#
# El script no toca git a proposito: decidir QUE se despliega es una decision
# humana. Un script que hace `git pull` solo publica lo ultimo que alguien
# empujo, que no siempre es lo que se queria publicar.
#
# Es idempotente: correrlo dos veces sobre el mismo commit no rompe nada.

set -euo pipefail

APP_DIR="${APP_DIR:-/srv/running-api/current}"
ENV_FILE="${ENV_FILE:-/etc/running-api/.env.production}"
SERVICE="${SERVICE:-running-api}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000}"

cd "$APP_DIR"

[ -r "$ENV_FILE" ] || { echo "No puedo leer $ENV_FILE"; exit 1; }
# Solo para prisma migrate: el servicio lee el fichero por su cuenta via systemd.
set -a; . "$ENV_FILE"; set +a

echo "▸ Desplegando $(git rev-parse --short HEAD 2>/dev/null || echo 'sin git') en $APP_DIR"

echo "▸ Dependencias"
# `npm ci` y no `install`: instala exactamente el lock, sin resolver versiones
# nuevas. Con devDependencies porque el build necesita el compilador; podarlas
# despues ahorraria ~200 MB de disco y ningun problema real.
npm ci

echo "▸ Cliente de Prisma"
# generated/ no esta versionado: sin esto, un clon limpio no compila.
npm run db:generate

echo "▸ Build"
npm run build

echo "▸ Migraciones"
# `migrate deploy`, nunca `migrate dev`: aplica lo pendiente y no genera nada.
# Va ANTES del restart para que el codigo nuevo encuentre su esquema; a cambio,
# toda migracion debe ser compatible con el codigo viejo durante estos segundos
# (agregar columnas si, renombrarlas en dos pasos).
npm run db:deploy

echo "▸ Reiniciando $SERVICE"
sudo systemctl restart "$SERVICE"

echo "▸ Esperando a que responda"
for i in $(seq 1 30); do
	if curl -fsS "$HEALTH_URL/health" >/dev/null 2>&1; then
		# /ready ademas comprueba Postgres y Redis: arrancar sin base es
		# exactamente el fallo que un healthcheck de liveness no ve.
		if curl -fsS "$HEALTH_URL/ready" >/dev/null 2>&1; then
			echo "✓ Desplegado y listo"
			exit 0
		fi
	fi
	sleep 1
done

echo "✗ La API no respondio en 30 s. Ultimas lineas del log:"
sudo journalctl -u "$SERVICE" -n 40 --no-pager
exit 1
