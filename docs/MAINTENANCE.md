# 🔧 Guide de Maintenance

Guide complet pour maintenir votre système de veille IA en bon état.

## 📋 Table des Matières

1. [Maintenance Quotidienne](#maintenance-quotidienne)
2. [Backups](#backups)
3. [Monitoring](#monitoring)
4. [Mises à Jour](#mises-à-jour)
5. [Optimisation](#optimisation)
6. [Troubleshooting Courant](#troubleshooting-courant)

---

## Maintenance Quotidienne

### Vérification Rapide (2 minutes)

```bash
# Voir le statut général
./scripts/status.sh

# Vérifier les logs pour erreurs
./scripts/logs.sh n8n | grep -i error | tail -20
./scripts/logs.sh postgres | grep -i error | tail -20
```

**Indicateurs de santé :**
- ✅ Tous les containers "running"
- ✅ Articles collectés dans les dernières 24h > 0, et scorés (`gemini_confidence` renseigné)
- ✅ Aucune erreur critique dans les logs
- ✅ Utilisation disque < 80%

---

## Backups

### Backup Manuel

```bash
# Backup complet (BDD + workflows + config)
./scripts/backup.sh

# Sortie :
# ✅ backups/veille_ia_20241209_143022.sql (PostgreSQL : données, workflows n8n, credentials chiffrés)
# ✅ backups/n8n_data_20241209_143022.tar.gz (fichiers locaux n8n)
# ✅ backups/env_20241209_143022.bak (Configuration)
```

**Fréquence recommandée :** Quotidien

> ⚠️ Les archives `env_*.bak` contiennent vos secrets (`.env`). Protégez le dossier `backups/` et chiffrez toute copie envoyée hors du serveur. Les credentials n8n sont chiffrés avec `N8N_ENCRYPTION_KEY` : une restauration exige le `.env` de la même installation.

### Backup Automatique

#### Configurer Cron

```bash
# Éditer crontab
crontab -e

# Ajouter cette ligne (backup quotidien à 4h du matin)
0 4 * * * cd /home/USER/veille-ia && ./scripts/backup.sh >> logs/backup.log 2>&1

# Sauvegarder et quitter
```

#### Vérifier Cron

```bash
# Lister les tâches cron
crontab -l

# Voir les logs de backup
tail -f logs/backup.log
```

### Restauration

```bash
# Lister les backups disponibles
ls -lht backups/*.sql | head -5

# Restaurer un backup spécifique
./scripts/restore.sh backups/veille_ia_20241209_143022.sql

# ⚠️ ATTENTION : Cela écrase les données actuelles !
```

### Backup Externe (Recommandé)

#### Vers un Serveur Distant (rsync)

```bash
# Créer script backup-remote.sh
cat > scripts/backup-remote.sh << 'EOF'
#!/bin/bash
# Backup local
./scripts/backup.sh

# Copier vers serveur distant
rsync -avz --delete \
  backups/ \
  user@backup-server.com:/backups/veille-ia/

echo "✅ Backup distant terminé"
EOF

chmod +x scripts/backup-remote.sh

# Configurer SSH sans mot de passe
ssh-keygen -t ed25519
ssh-copy-id user@backup-server.com

# Tester
./scripts/backup-remote.sh
```

#### Vers Cloud Storage (rclone)

```bash
# Installer rclone
curl https://rclone.org/install.sh | sudo bash

# Configurer (Google Drive, Dropbox, S3...)
rclone config

# Créer script backup-cloud.sh
cat > scripts/backup-cloud.sh << 'EOF'
#!/bin/bash
./scripts/backup.sh
rclone sync backups/ remote:veille-ia-backups/
echo "✅ Backup cloud terminé"
EOF

chmod +x scripts/backup-cloud.sh
```

---

## Monitoring

### Dashboard Temps Réel

```bash
# Statistiques complètes
./scripts/status.sh

# Mise à jour automatique toutes les 5 secondes
watch -n 5 ./scripts/status.sh
```

### Métriques à Surveiller

#### 1. Santé des Containers

```bash
# Statut
docker compose ps

# Ressources utilisées
docker stats --no-stream

# Redémarrage automatique ?
docker compose ps | grep -i restart
```

#### 2. Base de Données

```bash
# Connexion PostgreSQL
docker compose exec postgres psql -U n8n veille_ia

# Requêtes SQL utiles :

-- Nombre d'articles total
SELECT COUNT(*) FROM rss_articles;

-- Articles par source
SELECT source, COUNT(*) as total
FROM rss_articles
GROUP BY source
ORDER BY total DESC
LIMIT 10;

-- Articles envoyés (mention Discord) dernières 24h
SELECT COUNT(*) FROM rss_articles
WHERE sent_at > NOW() - INTERVAL '24 hours';

-- Taille de la base
SELECT pg_size_pretty(pg_database_size('veille_ia'));

-- Tables les plus volumineuses
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

#### 3. Workflows n8n

Dans n8n UI → **Executions** :
- ✅ Succès > 90%
- ⚠️ Erreurs < 10%
- 🔴 Alertes si échecs répétés

#### 4. Utilisation Disque

```bash
# Espace disque global
df -h

# Espace utilisé par le projet
du -sh ~/veille-ia

# Détails par répertoire
du -sh ~/veille-ia/{data,backups,logs}/*

# Si espace insuffisant :
# 1. Purger anciens backups
find backups/ -name "*.sql" -mtime +30 -delete

# 2. Purger anciens logs
find logs/ -name "*.log" -mtime +30 -delete

# 3. Nettoyer Docker
docker system prune -a --volumes
```

---

## Mises à Jour

### Mise à Jour des Images Docker

```bash
# Sauvegarder avant !
./scripts/backup.sh

# Télécharger les nouvelles images
docker compose pull

# Redémarrer avec nouvelles versions
docker compose up -d

# Vérifier
./scripts/status.sh
```

> ⚠️ n8n est épinglé à une version précise dans `docker-compose.yml` : `docker compose pull` ne le met pas à jour. Changez ce tag seulement après un test.

**Fréquence recommandée :** Mensuelle

### Mise à Jour du Code

```bash
# Si repository Git
cd ~/veille-ia

# Sauvegarder config
cp .env .env.backup

# Récupérer dernière version
git pull origin main

# Restaurer config si écrasée
cp .env.backup .env

# Recréer les conteneurs (up et non restart : restart ne relit pas .env)
docker compose up -d

# Appliquer le schéma s'il a changé (idempotent)
docker compose exec -T postgres psql -U n8n veille_ia < scripts/init.sql
```

Si `workflow-simplified.json` a changé : importer le fichier dans n8n (**Import from File**), reconfigurer ses credentials, puis désactiver et supprimer l'ancien workflow (deux workflows actifs s'exécutent en parallèle).

### Rollback en Cas de Problème

```bash
# Si problème après mise à jour

# 1. Revenir version précédente (Git)
git log --oneline
git checkout <commit-hash-précédent>

# 2. Ou restaurer backup
./scripts/restore.sh backups/veille_ia_AVANT_MAJ.sql

# 3. Redémarrer
./scripts/restart.sh
```

---

## Optimisation

### PostgreSQL

#### Vacuum et Analyze (Hebdomadaire)

```bash
# Se connecter
docker compose exec postgres psql -U n8n veille_ia

# Exécuter
VACUUM ANALYZE rss_articles;

# Ou en one-liner
docker compose exec -T postgres psql -U n8n veille_ia -c "VACUUM ANALYZE;"
```

#### Reconstruire les Index (Mensuel)

```sql
-- Se connecter à PostgreSQL
docker compose exec postgres psql -U n8n veille_ia

-- Reconstruire tous les index
REINDEX TABLE rss_articles;
```

#### Purge Manuelle (> 90 jours)

La purge tourne automatiquement à chaque run planifié (toutes les 30 minutes) ; cette commande la force.

```bash
# Via fonction SQL
docker compose exec -T postgres psql -U n8n veille_ia << EOF
SELECT purge_old_articles();
EOF

# Vérifier combien supprimés
# Retourne: deleted_count | 42
```

### n8n

#### Nettoyer Executions History

Dans n8n UI :
1. **Settings** → **Executions**
2. **Prune Execution Data** → Configurer
3. Garder seulement 30 derniers jours

Ou manuellement :

```bash
# Se connecter à PostgreSQL
docker compose exec postgres psql -U n8n veille_ia

# Supprimer vieilles executions
DELETE FROM execution_entity
WHERE "startedAt" < NOW() - INTERVAL '30 days';
```

### Docker

```bash
# Nettoyer images non utilisées
docker image prune -a

# Nettoyer volumes orphelins
docker volume prune

# Nettoyage complet (ATTENTION : supprime tout le inutilisé)
docker system prune -a --volumes
```

### Logs

```bash
# Rotation automatique configurée dans docker-compose.yml
# max-size: 10m, max-file: 3

# Vérifier taille logs
du -sh /var/lib/docker/containers/*/

# Nettoyer logs manuels
truncate -s 0 logs/*.log
```

---

## Troubleshooting Courant

### Container qui Redémarre en Boucle

```bash
# Identifier le container
docker compose ps

# Voir les logs
docker compose logs <container-name>

# Causes fréquentes :
# 1. Fichier .env mal configuré
# 2. Port déjà utilisé
# 3. Manque de RAM
```

### PostgreSQL "too many connections"

```bash
# Se connecter
docker compose exec postgres psql -U n8n veille_ia

# Voir connexions actives
SELECT count(*) FROM pg_stat_activity;

# Killer connexions inactives
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle'
AND state_change < NOW() - INTERVAL '1 hour';
```

### n8n "Workflow timeout"

Dans n8n, augmenter le timeout :
1. Workflow → Settings
2. **Execution Timeout** → 300 (5 min)

### Disque Plein

```bash
# Identifier gros fichiers
du -ah ~/veille-ia | sort -rh | head -20

# Solutions :
# 1. Purger backups anciens
find backups/ -mtime +30 -delete

# 2. Purger articles PostgreSQL
docker compose exec -T postgres psql -U n8n veille_ia -c "SELECT purge_old_articles();"

# 3. Nettoyer Docker
docker system prune -a --volumes
```

---

## Checklist Maintenance Mensuelle

- [ ] Backup manuel de sécurité
- [ ] Mise à jour images Docker
- [ ] VACUUM ANALYZE PostgreSQL
- [ ] REINDEX tables
- [ ] Vérifier exécutions n8n (taux de succès)
- [ ] Nettoyer vieux backups (> 90j)
- [ ] Vérifier logs pour erreurs récurrentes
- [ ] Tester restauration backup
- [ ] Vérifier espace disque disponible
- [ ] Mettre à jour documentation si modifs

---

## Scripts Personnalisés Utiles

### Script de Health Check

```bash
# Créer scripts/healthcheck.sh
cat > scripts/healthcheck.sh << 'EOF'
#!/bin/bash
echo "🏥 Health Check Système Veille IA"
echo "=================================="

# Containers
if [ $(docker compose ps -q | wc -l) -eq 2 ]; then
  echo "✅ Containers: OK (2/2)"
else
  echo "❌ Containers: ERREUR"
fi

# PostgreSQL
if docker compose exec -T postgres pg_isready -U n8n > /dev/null 2>&1; then
  echo "✅ PostgreSQL: OK"
else
  echo "❌ PostgreSQL: ERREUR"
fi

# n8n
if curl -sf http://localhost:5678 > /dev/null; then
  echo "✅ n8n: OK"
else
  echo "❌ n8n: ERREUR"
fi

# Disque
DISK_USAGE=$(df -h . | tail -1 | awk '{print $5}' | sed 's/%//')
if [ $DISK_USAGE -lt 80 ]; then
  echo "✅ Disque: OK ($DISK_USAGE%)"
else
  echo "⚠️  Disque: ATTENTION ($DISK_USAGE%)"
fi

echo ""
echo "✅ Health check terminé"
EOF

chmod +x scripts/healthcheck.sh
```

---

## 💡 Bonnes Pratiques

1. **Backups réguliers** : Automatiser avec cron
2. **Tester les restaurations** : Mensuel
3. **Surveiller les logs** : Quotidien
4. **Mises à jour** : Mensuel (avec backup avant)
5. **Documentation** : Noter toute modification
6. **Monitoring externe** : Uptime Robot / Healthchecks.io
7. **Alertes** : Configurer notifications Discord/email erreurs

---

**Questions ? Voir [TROUBLESHOOTING.md](TROUBLESHOOTING.md)**
