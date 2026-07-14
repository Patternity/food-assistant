# Production deployment

The Food Assistant runs as a single container on the same host as the Telegram
bot, with its own auto-deploy pipeline that mirrors the bot's: GitHub Actions
builds the image, ships it as a `docker save` tarball over SSH, and runs
`docker compose` on the server. No registry.

## Topology

```
Telegram bot stack ──(docker network: edge)──▶ food-assistant:3000
                                                └─ SQLite on volume `fooddata` (/data)
```

The bot reaches the service by name over a **shared external docker network**
`edge`. The service is not exposed publicly — only the bot talks to it.

## 1. One-time server setup

```bash
# shared network for bot <-> service discovery
docker network create edge

# deploy dir + secret env (NOT in git)
sudo mkdir -p /opt/food-assistant && cd /opt/food-assistant
cp /path/to/.env.prod.example .env
nano .env      # set LLM_API_KEY (OpenRouter sk-or-...) and SERVICE_TOKEN
```

`SERVICE_TOKEN` must be a long random secret; the bot uses the same value as
`FOOD_SERVICE_TOKEN`.

## 2. GitHub Actions secrets (this repo)

Same set as the bot repo (point them at the same host, a different `DEPLOY_PATH`):

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | server host/IP |
| `DEPLOY_USER` | ssh user |
| `DEPLOY_PORT` | ssh port (default 22) |
| `DEPLOY_SSH_KEY` | private key (ed25519) authorized on the server |
| `DEPLOY_KNOWN_HOSTS` | optional; else auto `ssh-keyscan` |
| `DEPLOY_PATH` | e.g. `/opt/food-assistant` |

Push to `master` → the `CI/CD Deploy (master)` workflow builds, ships, and runs
the container. The workflow creates the `edge` network if missing.

## 3. Wire the bot to the service

In the bot stack (content-platform):

- put the `bot` service on the `edge` network (the bot repo's
  `docker-compose.prod.yml` declares it — deploy with `--profile food` or keep it
  always on);
- set in the bot's `.env`:

```
FOOD_ENABLED=true
FOOD_SERVICE_URL=http://food-assistant:3000
FOOD_SERVICE_TOKEN=<same as this service's SERVICE_TOKEN>
```

## 4. Verify

```bash
cd /opt/food-assistant
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml exec food-assistant \
  wget -qO- http://localhost:3000/api/health      # {"ok":true,"configured":true,...}
# from the bot container:
docker compose -f <bot-compose> exec bot \
  python -c "import urllib.request as u; print(u.urlopen('http://food-assistant:3000/api/health').read())"
```

## Notes

- Data (the SQLite DB) lives on the `fooddata` volume at `/data`; the image's
  `data/` (mock offers, example baskets) is separate and read-only.
- `LLM_API_KEY` and `SERVICE_TOKEN` live only in the server `.env` — never in git.
- Backups: `docker run --rm -v food-assistant_fooddata:/d -v "$PWD":/b alpine \
  cp /d/food-assistant.sqlite /b/` (or `sqlite3 .backup`).
