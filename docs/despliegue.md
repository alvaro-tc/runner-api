# Despliegue en VPS

Guía paso a paso para poner la API en un servidor Ubuntu 24.04 LTS. **Sin
Docker**: todo se instala nativamente.

Los archivos de configuración están en [`deploy/`](../deploy) y
[`scripts/`](../scripts); aquí se explica dónde va cada uno y por qué.

---

## Dimensionamiento

**2 vCPU / 4 GB de RAM / 40 GB de disco** sobra para empezar. El reparto real:

| Pieza | RAM en reposo | Comentario |
|---|---|---|
| Node (la API) | ~150 MB | Un proceso. Ver abajo cuándo pasar a varios |
| Postgres | ~300 MB + `shared_buffers` (1 GB) | Es quien más pide |
| Redis | ~50 MB | Sesiones en vivo y rate limit; poco dato y volátil |
| Caddy | ~30 MB | |
| Sistema | ~400 MB | |

Deja ~1 GB libre para el pico de `sharp` procesando avatares y para la caché de
disco de Postgres.

**El dato que manda es el disco, no la RAM.** Un corredor genera un punto GPS por
segundo; una maratón de 42 km a 6:00/km son ~15 000 puntos, unos 2 MB con
índices. Mil corredores en una carrera: 2 GB de una sentada. Por eso `positions`
está particionada por mes y por eso hay una política de retención (18 meses) en
[`decisiones.md`](decisiones.md): sin ella, el disco es el primer recurso que se
acaba.

**Cuándo crecer:**

| Señal | Qué hacer |
|---|---|
| >300 corredores simultáneos emitiendo posiciones | 4 vCPU, y arrancar Node en cluster |
| El mapa en vivo va a tirones con muchos espectadores | Ya está listo: el adapter de Redis reparte entre instancias |
| `/ready` tarda o Postgres satura la CPU | Postgres a su propio VPS antes que agrandar este |
| Disco >70 % | Descartar particiones viejas de `positions` (ver retención) |

Un solo proceso de Node aguanta bien el tráfico de esta app porque casi todo es
I/O. Lo que sí lo bloquea es el trabajo con CPU: redimensionar avatares y generar
PDFs. Si eso empieza a notarse, esas dos tareas salen a un worker antes que
escalar la API entera.

---

## 1. Usuario y directorios

```bash
sudo adduser --system --group --home /srv/running-api paceup
sudo mkdir -p /srv/running-api/current /srv/running-api/uploads /etc/running-api
sudo chown -R paceup:paceup /srv/running-api
sudo chmod 750 /etc/running-api
```

`uploads/` vive **fuera** del directorio del código: un despliegue no debe poder
tocar los avatares de los usuarios, y el servicio systemd solo tiene permiso de
escritura ahí (`ReadWritePaths`).

## 2. Paquetes

```bash
sudo apt update && sudo apt install -y curl gnupg ca-certificates fail2ban ufw

# Node 22 LTS, del repo oficial de NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Postgres 17 y Redis, de los repos del sistema
sudo apt install -y postgresql-17 postgresql-contrib redis-server

# Caddy, del repo oficial
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Versiones fijadas: **Node 22 LTS**, **PostgreSQL 17**, **Redis 7**, **Caddy 2**.
Node tiene que ser 22 o superior: la API corre sobre NestJS 11 y el código usa
imports `node:`.

```bash
node -v && psql --version && redis-server -v && caddy version
```

## 3. Base de datos

```bash
sudo -u postgres createuser --pwprompt paceup
sudo -u postgres createdb --owner=paceup paceup
```

**Postgres no escucha fuera de localhost.** Es el default de Ubuntu; verifica que
`listen_addresses = 'localhost'` en `/etc/postgresql/17/main/postgresql.conf` y
déjalo así. La API corre en la misma máquina y no hay ninguna razón para exponer
el 5432 a internet.

En ese mismo archivo, para 4 GB de RAM:

```
shared_buffers = 1GB
effective_cache_size = 2GB
work_mem = 16MB
maintenance_work_mem = 256MB
```

Redis igual: `bind 127.0.0.1 ::1` en `/etc/redis/redis.conf`.

## 4. Variables de entorno

```bash
sudo cp .env.example /etc/running-api/.env.production
sudo chown root:paceup /etc/running-api/.env.production
sudo chmod 640 /etc/running-api/.env.production
sudo nano /etc/running-api/.env.production
```

Lo que **hay que** cambiar (el resto tiene defaults sanos):

```ini
NODE_ENV=production
API_DOMAIN=api.tudominio.bo
PUBLIC_BASE_URL=https://api.tudominio.bo
CORS_ORIGINS=https://tudominio.bo
DATABASE_URL=postgresql://paceup:LA-CLAVE@localhost:5432/paceup?schema=public
UPLOADS_DIR=/srv/running-api/uploads
LOG_PRETTY=false
JWT_SECRET=<openssl rand -base64 48>
PAYMENT_WEBHOOK_SECRET=<openssl rand -base64 32>
```

La validación con zod corre al arrancar y **mata el proceso** si algo falta o no
tiene sentido. Además, en producción rechaza explícitamente `CORS_ORIGINS=*` y el
secreto de webhook por defecto: son los dos errores de copiar-pegar que dejarían
la API abierta sin que nada lo delate.

Si te equivocas, el fallo se ve en `journalctl -u running-api -n 30` con el
nombre exacto de la variable.

## 5. Código y primer arranque

```bash
sudo -u paceup git clone https://github.com/alvaro-tc/running-api /srv/running-api/current
cd /srv/running-api/current
sudo -u paceup deploy/release.sh
```

El script instala dependencias, genera el cliente de Prisma, compila, aplica
migraciones, reinicia el servicio y espera a que `/health` y `/ready` respondan.
Si no responde en 30 s, imprime el log y sale con error.

Para que `release.sh` pueda reiniciar el servicio sin ser root:

```bash
echo 'paceup ALL=(root) NOPASSWD: /bin/systemctl restart running-api, /bin/journalctl -u running-api *' \
  | sudo tee /etc/sudoers.d/paceup-deploy
sudo chmod 440 /etc/sudoers.d/paceup-deploy
```

Permiso para reiniciar **ese** servicio y leer **ese** log, nada más.

## 6. Servicio systemd

```bash
sudo cp deploy/running-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now running-api
systemctl status running-api
```

`Restart=always` con `RestartSec=5`, y un tope de 5 arranques en 60 s: si revienta
más que eso no es un fallo transitorio sino configuración rota, y reiniciar en
bucle solo llena el journal.

Logs: `journalctl -u running-api -f`. Salen en JSON (pino) hacia journald, que los
rota sin configurar nada. `password`, `token`, `authorization` y `card` van
**redactados** desde el logger.

## 7. Caddy

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/api.paceup.example/api.tudominio.bo/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Antes de esto, el DNS del dominio tiene que apuntar al VPS: Caddy pide el
certificado al arrancar y falla si no puede validar. La renovación es automática.

`/uploads/*` lo sirve Caddy desde disco y el resto va a `127.0.0.1:3000`,
WebSocket incluido.

## 8. Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

El 80 se queda abierto: sin él Let's Encrypt no puede renovar por HTTP-01.

## 9. Backups

```bash
sudo mkdir -p /var/backups/paceup && sudo chown postgres:postgres /var/backups/paceup
sudo crontab -u postgres -e
```

```cron
15 3 * * * /srv/running-api/current/scripts/backup-db.sh >> /var/log/paceup-backup.log 2>&1
```

Volcado comprimido diario con rotación de 7 días. El script escribe a un temporal
y lo renombra al final: un `pg_dump` cortado a la mitad —disco lleno, VPS
reiniciado— no llega a ocupar el nombre del día. Un backup corrupto que parece
bueno es peor que no tener backup.

**Los avatares y las tarjetas de resultado no están en el volcado.** Son archivos:

```cron
30 3 * * * tar -czf /var/backups/paceup/uploads-$(date +\%F).tar.gz -C /srv/running-api uploads
```

### Restauración (probar, no suponer)

Sobre una base desechable, que es como se prueba sin arriesgar nada:

```bash
sudo -u postgres createdb paceup_restore
gunzip -c /var/backups/paceup/paceup-2026-08-20.sql.gz | sudo -u postgres psql paceup_restore
sudo -u postgres psql paceup_restore -c "SELECT count(*) FROM users;"
sudo -u postgres dropdb paceup_restore
```

Sobre la base real, con el servicio parado:

```bash
sudo systemctl stop running-api
sudo -u postgres dropdb paceup && sudo -u postgres createdb --owner=paceup paceup
gunzip -c /var/backups/paceup/paceup-2026-08-20.sql.gz | sudo -u postgres psql paceup
sudo systemctl start running-api
```

Un backup que nunca se restauró no es un backup: hazlo cada tanto contra la base
desechable, no el día del incendio.

---

## Actualizar

```bash
cd /srv/running-api/current
sudo -u paceup git pull
sudo -u paceup deploy/release.sh
```

El `git pull` es manual a propósito: qué se publica es una decisión, no algo que
un script deba resolver por su cuenta.

**Volver atrás:** `git checkout <commit-anterior>` y correr `release.sh` otra vez.
Las migraciones **no** se deshacen solas — por eso toda migración debe ser
compatible con el código anterior mientras dura el despliegue (agregar columnas,
sí; renombrar, en dos pasos).

## Vigilancia

`/health` dice si el proceso responde. `/ready` además comprueba Postgres y
Redis. Un healthcheck externo debe apuntar a **`/health`**: si apuntara a
`/ready`, una caída de Redis reiniciaría una API que sigue perfectamente capaz de
servir el catálogo.

Comprobación de cortesía cada 5 minutos, por si el proceso se queda colgado sin
morir —que es justo lo que `Restart=always` no cubre—:

```cron
*/5 * * * * curl -fsS --max-time 10 http://127.0.0.1:3000/health >/dev/null || systemctl restart running-api
```

Las particiones mensuales de `positions` **se crean solas**: la ingesta se asegura
de que exista la del mes antes de escribir. No hace falta cron para eso.

---

## Checklist de seguridad

- [ ] SSH solo por clave: `PasswordAuthentication no` y `PermitRootLogin no` en
      `/etc/ssh/sshd_config`. Comprueba que entras con tu clave **antes** de
      recargar sshd, o te quedas fuera del servidor.
- [ ] `ufw` activo con solo 22, 80 y 443 abiertos.
- [ ] `fail2ban` corriendo (`sudo systemctl enable --now fail2ban`), con la jail
      de sshd activa.
- [ ] Postgres y Redis escuchando solo en localhost. Verifícalo de verdad:
      `sudo ss -lntp | grep -E '5432|6379'` debe mostrar `127.0.0.1`.
- [ ] `/etc/running-api/.env.production` en `640 root:paceup`. No está en el repo
      y no debe estarlo.
- [ ] `JWT_SECRET` y `PAYMENT_WEBHOOK_SECRET` generados en este servidor, no
      copiados de desarrollo.
- [ ] `CORS_ORIGINS` con dominios explícitos.
- [ ] La API corre como `paceup`, nunca como root.
- [ ] Actualizaciones de seguridad automáticas:
      `sudo apt install unattended-upgrades`.
- [ ] Backups corriendo **y una restauración probada**.
- [ ] Swagger: `/api/docs` queda expuesto. Si no lo quieres público, bloquéalo en
      Caddy con `handle /api/docs* { respond 404 }`.

---

## Desarrollo local

Postgres y Redis instalados en la máquina, sin Docker, igual que en el VPS:

```bash
cp .env.example .env       # los defaults ya apuntan a localhost
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

```ini
DATABASE_URL=postgresql://paceup:paceup@localhost:5432/paceup?schema=public
REDIS_URL=redis://localhost:6379
```

La API queda en `http://localhost:3000/api/v1`, la documentación en `/api/docs` y
el panel en `/admin`.

---

## Cuando algo va mal

| Síntoma | Dónde mirar |
|---|---|
| El servicio no arranca | `journalctl -u running-api -n 50`. Casi siempre es una variable de entorno: el mensaje dice cuál |
| 502 desde Caddy | La API no está escuchando. `systemctl status running-api` |
| `/ready` devuelve 503 | Mira `checks` en la respuesta: dice si es Postgres o Redis |
| No renueva el certificado | El 80 cerrado, o el DNS ya no apunta aquí. `journalctl -u caddy` |
| 429 en todo | `GLOBAL_RATE_LIMIT_PER_MINUTE`. Si viene de una sola oficina detrás de NAT, súbelo |
| Los avatares dan 404 | `UPLOADS_DIR` y el `root` del Caddyfile tienen que apuntar al mismo sitio |
