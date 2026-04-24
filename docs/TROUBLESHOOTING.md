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

#### 1. Port 5432 déjà utilisé

```bash
# Vérifier
sudo netstat -tlnp | grep 5432
# ou
sudo lsof -i :5432

# Solution : Changer le port dans docker-compose.yml
ports:
  - "5433:5432"  # Utiliser 5433 à la place
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

**Cause :** DISCORD_WEBHOOK_URL mal configuré

**Solution :**
```bash
# Vérifier .env
grep DISCORD_WEBHOOK_URL .env

# Format correct :
# https://discord.com/api/webhooks/1234567890/abcdef...

# Tester manuellement
curl -X POST "$(grep DISCORD_WEBHOOK_URL .env | cut -d= -f2)" \
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
psql -U n8n -c "CREATE DATABASE veille_ia;"

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

#### 1. Firewall bloque le port

```bash
# Ouvrir le port
sudo ufw allow 5678/tcp

# Vérifier
sudo ufw status
```

#### 2. n8n pas démarré

```bash
# Logs pour cause
docker compose logs n8n

# Redémarrer
docker compose restart n8n
```

#### 3. Accès depuis externe (VPS)

```bash
# Depuis votre machine locale
curl http://VPS_IP:5678

# Si timeout, vérifier :
# 1. Firewall VPS
sudo ufw status

# 2. Firewall cloud provider (AWS Security Groups, etc.)
```

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

Recréer les credentials :

1. **Settings** → **Credentials**
2. **PostgreSQL** :
   - Host: `postgres`
   - Database: `veille_ia`
   - User: `n8n`
   - Password: (voir .env)
3. **Discord Webhook** :
   - URL: (voir .env)

### ❌ "Node 'RSS Feed Read' error: ETIMEDOUT"

**Cause :** Source RSS indisponible ou trop lente

**Solutions :**

1. **Augmenter timeout** :
   - Dans le nœud RSS, ajouter timeout 30s

2. **Désactiver source temporairement** :
   - Double-cliquer nœud
   - **Continue On Fail** → ON

3. **Vérifier disponibilité** :
```bash
# Tester manuellement
curl -I https://source-rss.com/feed

# Si erreur SSL
curl -k https://source-rss.com/feed
```

---

## Problèmes Discord

### ❌ "Discord webhook returned 404"

**Cause :** URL webhook invalide ou supprimé

**Solution :**

1. Vérifier sur Discord :
   - Salon → Modifier → Intégrations → Webhooks
   - Le webhook "Veille IA" existe ?

2. Si supprimé, recréer :
   - Nouveau Webhook → Copier URL
   - Mettre à jour .env

```bash
nano .env
# Modifier DISCORD_WEBHOOK_URL

# Redémarrer n8n
docker compose restart n8n
```

### ❌ "Discord webhook returned 429" (Rate limit)

**Cause :** Trop de requêtes vers Discord

**Solution :**

1. **Ajouter un délai entre messages** :

Dans n8n, ajouter nœud "Wait" entre articles :
- 1 seconde entre chaque message

2. **Grouper les articles** :

Au lieu d'envoyer 1 embed par message, en envoyer 10 par message.

### ❌ "Messages vides sur Discord"

**Cause :** Format embed incorrect

**Diagnostic :**

Dans n8n, vérifier le nœud Discord :
```json
{
  "embeds": [{
    "title": "...",
    "description": "...",
    "url": "..."
  }]
}
```

**Solution :**

- `title` et `description` obligatoires
- `title` max 256 caractères
- `description` max 4096 caractères
- `url` doit être valide (http/https)

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

#### 3. Réduire fréquence scraping

Dans n8n, Schedule Trigger :
- `0 */4 * * *` (toutes les 4h au lieu de 2h)

#### 4. Désactiver sources volumineuses

Dans `rss_sources.json` :
- ArXiv (beaucoup d'articles)
- Towards Data Science
- Reddit général

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

Dans nœud RSS n8n :
- **Ignore SSL Issues** → ON (temporaire)

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

# RSSHub
curl http://localhost:1200

# n8n
curl http://localhost:5678

# 5. Ressources système
free -h
df -h
docker stats --no-stream

# 6. Ports ouverts
sudo netstat -tlnp | grep -E '5678|5432|1200'
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

# 5. Reconfigurer n8n
# - Reimporter workflows
# - Recréer credentials
```

---

## 📞 Obtenir de l'Aide

Si aucune solution ne fonctionne :

1. **Collecter infos** :
```bash
./scripts/status.sh > debug.txt
docker compose logs > logs.txt
cat .env | grep -v PASSWORD >> debug.txt
```

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
