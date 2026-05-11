# n8n DNS resolution fix (WSL2 + Docker)

## Symptom

Discord nodes (both the built-in Discord node and the community Discord Trigger)
failed with:

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

Add explicit public resolvers to the `n8n` service in `docker-compose.yml`:

```yaml
  n8n:
    ...
    dns:
      - 1.1.1.1
      - 8.8.8.8
```

This bypasses Docker's embedded resolver for this container.

Apply with:

```bash
docker compose up -d n8n
```

## Verification

```
$ docker compose exec n8n getent hosts discord.com
162.159.128.233   discord.com
```

Discord node calls succeed again.

## Notes

- If other containers that need outbound HTTPS (e.g. `rsshub`) hit the same
  symptom, add the same `dns:` block to them.
- Unrelated warning seen during the investigation:
  `The "DISCORD_WEBHOOK_URL" variable is not set` — make sure it is defined in
  `.env`, otherwise webhook delivery will silently target an empty URL.
