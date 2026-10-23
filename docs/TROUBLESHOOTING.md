# 🆘 Guide de Dépannage

Solutions aux problèmes courants du système de veille IA.

## 📋 Table des Matières

1. [Problèmes d'Installation](#problèmes-dinstallation)
2. [Problèmes de Démarrage](#problèmes-de-démarrage)
3. [Problèmes PostgreSQL](#problèmes-postgresql)
4. [Problèmes n8n](#problèmes-n8n)
5. [Problèmes Discord](#problèmes-discord)
6. [Problèmes de Performance](#problèmes-de-performance)
7. [Problèmes Réseau](#problèmes-réseau)

---

## Problèmes d'Installation

### ❌ "Docker command not found"

**Cause :** Docker n'est pas installé

**Solution :**
```bash
# Installer Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Se déconnecter/reconnecter
exit
# Reconnectez-vous en SSH
```

### ❌ "docker compose: command not found"

**Cause :** Docker Compose plugin manquant

**Solution :**
```bash
# Ubuntu/Debian
sudo apt install -y docker-compose-plugin

# Vérifier
docker compose version
```

### ❌ "Permission denied" lors de `docker compose`

**Cause :** Utilisateur pas dans groupe docker

**Solution :**
```bash
# Ajouter au groupe
sudo usermod -aG docker $USER

# IMPORTANT : Se déconnecter/reconnecter
exit
# Reconnexion nécessaire !

# Vérifier
groups | grep docker
```

---

## Problèmes de Démarrage

### ❌ Container "veille-postgres" ne démarre pas

**Diagnostic :**
```bash
docker compose logs postgres
```

**Causes possibles :**

#### 1. Port hôte déjà utilisé

Le port hôte de PostgreSQL est `POSTGRES_PORT` (5433 par défaut, publié sur `127.0.0.1`).

```bash
# Vérifier
sudo netstat -tlnp | grep 5433
# ou
sudo lsof -i :5433

# Solution : choisir un autre port dans .env (POSTGRES_PORT=5434 par exemple), puis
docker compose up -d
```

#### 2. Données corrompues

```bash
# Arrêter tout
docker compose down

# Supprimer données PostgreSQL
rm -rf data/postgres/*

# Redémarrer (réinitialisation complète)
docker compose up -d postgres
```

#### 3. Manque de RAM

```bash
# Vérifier mémoire disponible
free -h

# Si < 500MB disponible, arrêter services inutiles
sudo systemctl stop <service-inutile>
```

### ❌ Container "veille-n8n" ne démarre pas

**Diagnostic :**
```bash
docker compose logs n8n
```

**Causes possibles :**

#### 1. N8N_ENCRYPTION_KEY invalide

```bash
# Vérifier .env
grep N8N_ENCRYPTION_KEY .env

# Doit être 64 caractères hex
# Si invalide, régénérer :
openssl rand -hex 32

# Copier dans .env
nano .env
```

#### 2. Connexion PostgreSQL échoue

```bash
# Tester depuis n8n
docker compose exec n8n sh -c 'nc -zv postgres 5432'

# Devrait afficher : postgres (172.x.x.x:5432) open

# Si échec, vérifier que postgres est démarré
docker compose ps postgres
```

### ❌ "Webhook Discord error"

**Cause :** une variable `DISCORD_WEBHOOK_<SALON>` est vide ou erronée (`TECH_NEWS`, `COMPANIES`, `REDDIT` ou `OTHERS`). Un salon sans webhook ne reçoit aucun article : ses articles restent en attente en base (non marqués envoyés), sans erreur visible.

**Solution :**
```bash
# Vérifier .env (noms des variables seulement)
grep -oE '^DISCORD_WEBHOOK_[A-Z_]+=' .env

# Format correct :
# https://discord.com/api/webhooks/VOTRE_ID/VOTRE_TOKEN

# Tester manuellement (remplacer TECH_NEWS par le salon concerné)
curl -X POST "$(grep '^DISCORD_WEBHOOK_TECH_NEWS=' .env | cut -d= -f2-)" \
  -H "Content-Type: application/json" \
  -d '{"content": "Test depuis terminal"}'

# Devrait envoyer un message sur Discord
```

---

## Problèmes PostgreSQL

### ❌ "FATAL: database does not exist"

**Solution :**
```bash
# Se connecter au container
docker compose exec postgres bash

# Créer la base
psql -U n8n -d postgres -c "CREATE DATABASE veille_ia;"

# Charger le schéma
psql -U n8n veille_ia < /docker-entrypoint-initdb.d/init.sql

# Quitter
exit
```

### ❌ "Too many connections"

**Diagnostic :**
```bash
docker compose exec postgres psql -U n8n veille_ia -c "
SELECT count(*) FROM pg_stat_activity;
"
```

**Solution :**
```bash
# Killer connexions inactives
docker compose exec postgres psql -U n8n veille_ia -c "
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle'
AND state_change < NOW() - INTERVAL '1 hour';
"

# Augmenter max_connections (si nécessaire)
# Créer config/postgresql.conf :
max_connections = 200  # Au lieu de 100

# Redémarrer
docker compose restart postgres
```

### ❌ "Could not connect to server"

**Solution :**
```bash
# Vérifier que container tourne
docker compose ps postgres

# Si stopped, démarrer
docker compose up -d postgres

# Attendre 10 secondes
sleep 10

# Tester connexion
docker compose exec postgres pg_isready -U n8n
```

### ❌ "Disk full" ou "No space left"

**Solution :**
```bash
# Vérifier espace
df -h

# Purger vieux articles
docker compose exec postgres psql -U n8n veille_ia -c "
SELECT purge_old_articles();
"

# Vacuum
docker compose exec postgres psql -U n8n veille_ia -c "
VACUUM FULL ANALYZE;
"

# Si toujours plein, nettoyer backups
find backups/ -mtime +30 -delete
```

---

## Problèmes n8n

### ❌ "Cannot access n8n on port 5678"

**Diagnostic :**
```bash
# Vérifier que n8n tourne
docker compose ps n8n

# Vérifier les logs
docker compose logs n8n | tail -50

# Vérifier port ouvert
curl http://localhost:5678
```

**Solutions :**

#### 1. Accès depuis un autre poste

n8n est publié sur `127.0.0.1` : une règle de pare-feu ne l'ouvre pas, et ce n'est pas un problème sur la machine hôte. Depuis un autre poste, utilisez un tunnel SSH :

```bash
ssh -L 5678:localhost:5678 utilisateur@VPS_IP
# Puis ouvrir http://localhost:5678 dans le navigateur
```

#### 2. n8n pas démarré

```bash
# Logs pour cause
docker compose logs n8n

# Redémarrer
docker compose restart n8n
```

#### 3. Accès depuis l'extérieur (VPS)

Un timeout depuis une machine distante est normal. Vérifiez d'abord que n8n répond sur le VPS (`curl http://localhost:5678`), puis utilisez le tunnel SSH du point 1.

### ❌ "Workflow execution timeout"

**Solution :**

Dans n8n :
1. Ouvrir le workflow
2. **Settings** (engrenage) → **Workflow Settings**
3. **Execution Timeout** → `600` (10 minutes)
4. **Save**

### ❌ "Credential not found"

**Cause :** Credentials n8n perdus (si données n8n supprimées)

**Solution :**

Recréer les credentials (détails dans [INSTALL.md](INSTALL.md#configuration-n8n)) :

1. **Settings** → **Credentials**
2. **PostgreSQL** :
   - Host: `postgres`
   - Database: `veille_ia`
   - User: `n8n`
   - Password: (voir .env)
3. **Discord Bot Trigger** :
   - Token du bot : (voir `DISCORD_BOT_TOKEN` dans .env)
4. **OAuth2 API**, nom `Reddit OAuth2` :
   - Grant Type: Client Credentials
   - Access Token URL: `https://www.reddit.com/api/v1/access_token`
   - Client ID / Client Secret : (app « script » sur reddit.com/prefs/apps)
   - Authentication: Header

### ❌ "Node 'RSS Read' error: ETIMEDOUT" (ou « Reddit Fetch » en erreur)

**Cause :** Source RSS (ou Reddit) indisponible ou trop lente

**Comportement :** les nœuds `RSS Read` et `Reddit Fetch` continuent en cas d'erreur : une source en panne n'arrête pas le run, l'erreur reste visible dans l'exécution.

**Solutions :**

1. **Désactiver la source** dans `rss_sources.json` :
   - `"active": false` sur l'entrée concernée (le fichier est relu à chaque run, pas de redémarrage)

2. **Vérifier disponibilité** :
```bash
# Tester manuellement
curl -I https://source-rss.com/feed

# Si erreur SSL
curl -k https://source-rss.com/feed
```

---

## Problèmes Discord

### ❌ "Discord webhook returned 404"

**Cause :** URL webhook invalide ou webhook supprimé pour le salon concerné

**Solution :**

1. Vérifier sur Discord :
   - Salon → Modifier → Intégrations → Webhooks
   - Le webhook "Veille IA" du salon existe ?

2. Si supprimé, recréer :
   - Nouveau Webhook → Copier URL
   - Mettre à jour la variable `DISCORD_WEBHOOK_<SALON>` dans .env

```bash
nano .env
# Modifier DISCORD_WEBHOOK_TECH_NEWS (ou le salon concerné)

# Appliquer : "up" et non "restart", qui ne relit pas .env
docker compose up -d n8n
```

### ❌ "Discord webhook returned 429" (Rate limit)

**Cause :** Trop de requêtes vers Discord

**Solution :**

Le volume est déjà borné : au plus 5 articles par salon et par mention (`Claim Top Articles`), regroupés en messages de 10 embeds maximum (`Format Embeds`).

Si le 429 persiste, ajouter un nœud "Wait" (1 seconde) entre "Format Embeds" et "Send to Discord".

### ❌ "Messages vides sur Discord"

**Cause :** Payload refusé par Discord (HTTP 400) ou embed incomplet

**Diagnostic :**

Dans n8n, ouvrir l'exécution du nœud "Send to Discord" : la réponse de Discord indique le champ en cause. Le payload est construit par le nœud "Format Embeds" :
```json
{
  "content": "...",
  "embeds": [{
    "title": "...",
    "url": "...",
    "description": "...",
    "footer": { "text": "..." }
  }]
}
```

**Solution :**

- `title` obligatoire, 256 caractères max (tronqué par "Format Embeds")
- `description` obligatoire, 1000 caractères max dans ce workflow (Discord accepte 4096)
- `url` doit être valide (http/https)
- Un message contient au plus 10 embeds et 5800 caractères cumulés (titres, descriptions, pieds)

### ❌ Le bot ne répond pas à la mention

**Causes possibles :**

1. Votre identifiant n'est pas dans `DISCORD_ALLOWED_AUTHORS` : la mention est ignorée sans réponse (comportement voulu, deny by default)
2. L'intent **MESSAGE CONTENT** est désactivé dans le portail développeur
3. Le serveur ou le salon n'est pas renseigné dans le nœud `Discord Bot mention1` (champs `guildIds` et `channelIds`)
4. Variable modifiée dans `.env` sans recréer le conteneur : `docker compose up -d n8n`

### ❌ Le bot répond toujours « Rien de nouveau »

**Cause :** aucun article éligible (publié dans les 48 h, confiance ≥ 85, score ≥ 60, pas encore posté), ou scoring bloqué

**Diagnostic :**
```bash
# Ce nombre doit augmenter à chaque run planifié
docker compose exec postgres psql -U n8n veille_ia -c "SELECT count(*) FILTER (WHERE gemini_confidence IS NOT NULL) AS scores, count(*) AS total FROM rss_articles;"
```

Vérifier aussi que le run « Every 30 Minutes » réussit dans la liste des exécutions de n8n. Un échec Gemini (402, 429) laisse les articles non scorés : ils sont réessayés au prochain run, 3 tentatives au maximum. Consulter le quota sur AI Studio.

---

## Problèmes de Performance

### 🐌 "Système lent"

**Diagnostic :**
```bash
# CPU/RAM
docker stats --no-stream

# Charge système
top
htop  # Si installé

# I/O disque
iostat -x 1 5
```

**Solutions :**

#### 1. Limiter ressources Docker

Dans `docker-compose.yml` :
```yaml
n8n:
  deploy:
    resources:
      limits:
        cpus: '1.0'
        memory: 1G
```

#### 2. Optimiser PostgreSQL

```bash
# Vacuum
docker compose exec postgres psql -U n8n veille_ia -c "VACUUM ANALYZE;"

# Reindex
docker compose exec postgres psql -U n8n veille_ia -c "REINDEX DATABASE veille_ia;"
```

#### 3. Réduire fréquence de collecte

Dans n8n, nœud "Every 30 Minutes" : passer à 60 minutes (ou plus). Les mentions Discord répondent toujours depuis la base : seule la fraîcheur des articles change.

#### 4. Désactiver sources volumineuses

Dans `rss_sources.json`, mettre `"active": false` sur les entrées de `sources` les plus volumineuses. Le bloc `reddit` a sa propre clé `active` et sa liste `subreddits`.

### 🐌 "PostgreSQL lent"

**Solution :**

Créer `config/postgresql.conf` :
```conf
shared_buffers = 512MB
effective_cache_size = 1GB
maintenance_work_mem = 128MB
checkpoint_completion_target = 0.9
wal_buffers = 16MB
default_statistics_target = 100
random_page_cost = 1.1
effective_io_concurrency = 200
work_mem = 4MB
```

Monter dans docker-compose.yml :
```yaml
postgres:
  volumes:
    - ./config/postgresql.conf:/etc/postgresql/postgresql.conf:ro
  command: postgres -c config_file=/etc/postgresql/postgresql.conf
```

---

## Problèmes Réseau

### ❌ "Cannot resolve hostname"

**Solution :**
```bash
# Vérifier DNS
cat /etc/resolv.conf

# Tester résolution
nslookup google.com

# Si échec, configurer DNS Google
sudo echo "nameserver 8.8.8.8" >> /etc/resolv.conf
```

### ❌ "SSL certificate verification failed"

**Solution :**

Dans le nœud **RSS Read** (Options) :
- **Ignore SSL Issues** → ON (temporaire, dernier recours)

Ou installer certificats :
```bash
sudo apt install ca-certificates
sudo update-ca-certificates
```

### ❌ "Containers cannot communicate"

**Solution :**
```bash
# Vérifier réseau Docker
docker network ls
docker network inspect veille-ia_veille-network

# Recréer réseau
docker compose down
docker network prune
docker compose up -d
```

---

## Commandes de Diagnostic Général

```bash
# 1. État complet système
./scripts/status.sh

# 2. Logs tous services
./scripts/logs.sh all | tail -100

# 3. Santé containers
docker compose ps
docker inspect <container-name>

# 4. Tester connectivité
# PostgreSQL
docker compose exec n8n sh -c 'nc -zv postgres 5432'

# n8n
curl http://localhost:5678

# 5. Ressources système
free -h
df -h
docker stats --no-stream

# 6. Ports ouverts
sudo netstat -tlnp | grep -E '5678|5433'
```

---

## 🆘 Dernier Recours : Reset Complet

**⚠️ ATTENTION : Perd toutes les données !**

```bash
# 1. Backup avant !
./scripts/backup.sh

# 2. Arrêter tout
docker compose down -v

# 3. Supprimer données
rm -rf data/*

# 4. Redémarrer from scratch
./scripts/start.sh

# 5. Reconfigurer n8n (voir INSTALL.md)
# - Réimporter workflow-simplified.json
# - Recréer les credentials : PostgreSQL, Discord Bot Trigger, Reddit OAuth2
```

---

## 📞 Obtenir de l'Aide

Si aucune solution ne fonctionne :

1. **Collecter infos** :
```bash
./scripts/status.sh > debug.txt
docker compose logs > logs.txt
grep -oE '^[A-Z_0-9]+=' .env >> debug.txt   # noms des variables seulement
```

   ⚠️ Ne joignez jamais `.env` ni les valeurs de ses variables à une issue : il contient le token du bot, la clé Gemini et les webhooks.

2. **Ouvrir une issue GitHub** avec :
   - Version système (Ubuntu/Debian...)
   - Versions Docker/Docker Compose
   - Fichiers debug.txt et logs.txt
   - Description du problème
   - Étapes pour reproduire

3. **Support communauté** :
   - Forum n8n : https://community.n8n.io/
   - Discord n8n
   - Stack Overflow (tag: n8n)

---

**Problème non listé ? Ouvrir une issue !**
