# n8n DNS resolution fix (WSL2 + Docker)

## Symptom

Outbound calls from n8n (the Discord bot trigger and webhooks, Reddit, RSS feeds,
Gemini) failed with:

> The DNS server returned an error, perhaps the server is offline

Restarting via `./scripts/start.sh` / `stop.sh` did not help.

## Root cause

Inside the n8n container, `/etc/resolv.conf` pointed at Docker's embedded
resolver `127.0.0.11`, which forwards to the host upstream — on WSL2 that is
`10.255.255.254` (WSL's virtual DNS). From inside the container this upstream
is unreachable, so every lookup (`discord.com`, `discordapp.com`, …) times out.

Verified from the container:

```
$ nslookup discord.com
Server:  127.0.0.11
;; connection timed out; no servers could be reached
```

Direct IP egress also failed because `wget` still needs DNS for SNI/hosts.

## Fix

The `n8n` service in `docker-compose.yml` already sets explicit public resolvers.
Keep this block:

```yaml
  n8n:
    ...
    dns:
      - 1.1.1.1
      - 8.8.8.8
```

This bypasses Docker's embedded resolver for this container.

After any change to this block, apply it with:

```bash
docker compose up -d n8n
```

## Verification

```
$ docker compose exec n8n getent hosts discord.com
162.159.128.233   discord.com
```

Outbound calls from n8n succeed again.

## Notes

- `n8n` is the only container that makes outbound HTTPS calls; `postgres`
  does not need the `dns:` block.
- Make sure the four channel variables `DISCORD_WEBHOOK_TECH_NEWS`,
  `DISCORD_WEBHOOK_COMPANIES`, `DISCORD_WEBHOOK_REDDIT` and
  `DISCORD_WEBHOOK_OTHERS` are defined in `.env`. An empty one silently stops
  posting to that channel: its articles stay unsent in the database.
