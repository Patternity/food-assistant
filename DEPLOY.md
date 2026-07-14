# Deployment

Food Assistant runs as a **service inside the Telegram bot's docker-compose
stack** (the same pattern as dash-pay), not as a standalone deploy. This repo's
only CI job is to **publish the image to GHCR**; the bot stack pulls and runs it.

## Pipeline

```
push to master ─▶ GitHub Actions (publish-image.yml)
                    └─ build docker/Dockerfile ─▶ push ghcr.io/patternity/food-assistant:{latest,sha}

bot deploy (content-platform) ─▶ docker pull ghcr.io/patternity/food-assistant:latest
                                 └─ docker compose --profile food up   (service `food-assistant`)
```

The bot reaches the service by name on the compose network at
`http://food-assistant:3000`. Nothing is exposed publicly.

## GHCR access

- The package `ghcr.io/patternity/food-assistant` is published by this repo's
  Actions via `GITHUB_TOKEN` (no extra secrets).
- The **server must be able to pull it**: either make the package **public**
  (Packages → package → visibility), or `docker login ghcr.io` on the host with a
  PAT that has `read:packages`.

## Bot-side wiring (content-platform)

`docker-compose.prod.yml` defines a `food-assistant` service under
`profiles: ["food"]` that pulls the image and reads its env from `.env.food`.

1. On the server, next to the bot's `.env`, create `.env.food`:

   ```
   LLM_PROVIDER=openai-compatible
   LLM_API_KEY=sk-or-...            # OpenRouter key (secret)
   LLM_BASE_URL=https://openrouter.ai/api/v1
   LLM_MODEL=openai/gpt-4o-mini
   LLM_VISION_MODEL=openai/gpt-4o-mini
   LLM_DEFAULT_LANGUAGE=ru
   SERVICE_TOKEN=<long-random-secret>
   ```

2. In the bot's main `.env`:

   ```
   FOOD_ENABLED=true
   FOOD_SERVICE_URL=http://food-assistant:3000
   FOOD_SERVICE_TOKEN=<same as SERVICE_TOKEN above>
   ```

The bot's deploy pulls the image and starts the `food` profile automatically
when `.env.food` is present. Data (the SQLite DB) lives on the `fooddata` volume
at `/data`.

## Run standalone (local/testing)

```bash
docker build -f docker/Dockerfile -t food-assistant .
docker run --rm -p 3000:3000 --env-file .env -v fooddata:/data food-assistant
# health: curl localhost:3000/api/health
```
