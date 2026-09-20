# Multiloger production deployment

This directory holds **example** production assets. Copy them to the real
locations, then edit the placeholders (`<...>`) to match your machine.

| File | Install to | Purpose |
|---|---|---|
| `systemd/multiloger.service` | `/etc/systemd/system/multiloger.service` | Runs the API + dashboard as a service |
| `systemd/multiloger-backup.service` + `multiloger-backup.timer` | `/etc/systemd/system/` | Scheduled backups of every profile |
| `systemd/backup-all.sh` | `/opt/multiloger/backup-all.sh` (chmod 700) | Called by the backup service |
| `systemd/multiloger.env.example` | `/etc/multiloger/multiloger.env` (chmod 600, root:root) | Secrets + config (never in git) |
| `nginx/multiloger.conf` | `/etc/nginx/sites-available/multiloger` | TLS reverse proxy in front of the API |

## 1. Install

```sh
# code (once)
git clone <your-multiloger-repo> /opt/multiloger/app
cd /opt/multiloger/app && pnpm install && pnpm build

# runtime user + dirs (never run as root)
sudo useradd --system --home /var/lib/multiloger --create-home multiloger
sudo mkdir -p /var/lib/multiloger/data /etc/multiloger
sudo chown multiloger:multiloger /var/lib/multiloger/data
```

## 2. Secrets

```sh
# generate the two encryption keys (32 bytes hex each)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # → MULTILOGER_BACKUP_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # → MULTILOGER_VAULT_KEY

sudo cp deploy/systemd/multiloger.env.example /etc/multiloger/multiloger.env
sudo chmod 600 /etc/multiloger/multiloger.env   # owner-only: the keys inside void encryption if world-readable
sudo chown root:root /etc/multiloger/multiloger.env
# edit the file and paste the keys + a long random API bootstrap is NOT needed here —
# the server prints a bootstrap token on first start; create a named token and revoke it.
```

Key files (`MULTILOGER_BACKUP_KEY_FILE` / `MULTILOGER_VAULT_KEY_FILE`) are the
safer alternative to inline env values; they must also be `0600` or the
server refuses to start.

## 3. Enable

```sh
sudo cp deploy/systemd/multiloger.service /etc/systemd/system/
sudo cp deploy/systemd/multiloger-backup.* deploy/systemd/backup-all.sh /etc/systemd/system/  # (script → /opt/multiloger/)
sudo systemctl daemon-reload
sudo systemctl enable --now multiloger.service
sudo systemctl enable --now multiloger-backup.timer
```

First start prints a **bootstrap API token** in the journal — save it, create a
named token, revoke the bootstrap:

```sh
sudo journalctl -u multiloger.service | grep -i bootstrap
```

## 4. Firewall (ufw)

The API listens on `127.0.0.1` only (see the unit file); nginx is the only
thing exposed. Minimal ruleset:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp        # ssh — restrict to your IP if possible: `ufw allow from <your-ip> to any port 22`
sudo ufw allow 80,443/tcp    # http/https via nginx
sudo ufw enable
```

Do **not** open the API port (3000) to the network. If you must reach the API
remotely, go through the nginx TLS proxy, never plain HTTP.

## 5. Backups

`multiloger-backup.timer` runs `backup-all.sh` daily at 03:30. The script
lists profiles via the API and creates one encrypted `.mlbackup` per profile.
Backup files live under `<data-dir>/backups/`; the DB's retention policy
prunes old ones. **Copy the backup dir off-machine** (rsync/rclone to
encrypted storage) — a backup on the same disk is not a backup.

Check timer status: `systemctl list-timers multiloger-backup.timer`
Run once now: `sudo systemctl start multiloger-backup.service`
Logs: `sudo journalctl -u multiloger-backup.service`

## 6. TLS

See `nginx/multiloger.conf`. Get a cert with certbot:

```sh
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d multiloger.example.com
```

The API itself stays plain HTTP on loopback; TLS terminates at nginx.

## 7. Upgrading

```sh
cd /opt/multiloger/app && git pull --ff-only && pnpm install && pnpm build
sudo systemctl restart multiloger.service
```

SQLite migrations run automatically on boot. Keep a fresh `.mlbackup` before
every upgrade.
