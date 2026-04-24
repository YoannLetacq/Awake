# 📝 Aide-Mémoire - Veille IA

Commandes rapides pour gérer votre système de veille.

---

## 🚀 Installation & Démarrage

```bash
# 1. Installation initiale (première fois uniquement)
./scripts/setup.sh

# 2. Éditer configuration
nano .env
# → Ajouter DISCORD_WEBHOOK_URL

# 3. Démarrer tout
./scripts/start.sh

# 4. Accéder n8n
# http://localhost:5678
# User: admin
# Pass: (affiché lors du setup)
```

---

## 🛠️ Gestion Quotidienne

```bash
# Voir le statut
./scripts/status.sh

# Démarrer
./scripts/start.sh

# Arrêter
./scripts/stop.sh

# Redémarrer
./scripts/restart.sh

# Logs en temps réel
./scripts/logs.sh n8n        # Logs n8n
./scripts/logs.sh postgres   # Logs PostgreSQL
./scripts/logs.sh rsshub     # Logs RSSHub
./scripts/logs.sh all        # Tous les logs
```

---

## 💾 Backups & Restauration

```bash
# Backup manuel
./scripts/backup.sh

# Lister backups
ls -lht backups/

# Restaurer un backup
./scripts/restore.sh backups/veille_ia_20241209_143022.sql

# Backup automatique (cron)
crontab -e
# Ajouter :
# 0 4 * * * cd /home/user/veille-ia && ./scripts/backup.sh >> logs/backup.log 2>&1
```

---

## 🗄️ PostgreSQL

```bash
# Se connecter (depuis le container)
docker compose exec postgres psql -U n8n veille_ia

# Se connecter (depuis l'hôte, si psql installé)
psql -h localhost -p 5433 -U n8n veille_ia

# Compter articles
SELECT COUNT(*) FROM rss_articles;

# Articles par source
SELECT source, COUNT(*) as total
FROM rss_articles
GROUP BY source
ORDER BY total DESC;

# Articles dernières 24h
SELECT COUNT(*) FROM rss_articles
WHERE sent_at > NOW() - INTERVAL '24 hours';

# Purger articles > 90 jours
SELECT purge_old_articles();

# Statistiques rapides
SELECT * FROM article_stats;

# Quitter
\q
```

---

## 🐳 Docker

```bash
# État containers
docker compose ps

# Logs
docker compose logs -f <service>

# Redémarrer un service
docker compose restart <service>

# Arrêter tout
docker compose down

# Démarrer tout
docker compose up -d

# Ressources utilisées
docker stats --no-stream

# Nettoyer (attention : supprime tout le inutilisé)
docker system prune -a
```

---

## 🎨 n8n

```bash
# URL interface
http://localhost:5678

# Credentials
User: admin
Pass: (voir dans .env, ligne N8N_BASIC_AUTH_PASSWORD)

# Tester workflow manuellement
# → Cliquer "Execute Workflow" (▶️)

# Activer workflow automatique
# → Toggle "Inactive" → "Active"

# Voir exécutions
# → Menu "Executions" (gauche)
```

---

## 📊 Sources RSS

```bash
# Éditer sources
nano rss_sources.json

# Désactiver une source
"active": false

# Redémarrer après modif
./scripts/restart.sh
```

---

## 🔐 Configuration

```bash
# Voir configuration
cat .env

# Éditer
nano .env

# Variables importantes :
# - DISCORD_WEBHOOK_URL
# - POSTGRES_PASSWORD
# - POSTGRES_PORT (5433 par défaut)
# - N8N_ENCRYPTION_KEY
# - N8N_BASIC_AUTH_PASSWORD

# Redémarrer après modif
./scripts/restart.sh
```

---

## 🆘 Dépannage

```bash
# Vérifier que tout tourne
docker compose ps

# Logs détaillés
docker compose logs <service> --tail=100

# Tester PostgreSQL
docker compose exec postgres pg_isready -U n8n

# Tester n8n
curl http://localhost:5678

# Tester Discord webhook
curl -X POST "$DISCORD_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"content": "Test"}'

# Espace disque
df -h
du -sh data/

# Processus Docker
docker ps -a
```

---

## 🔥 Reset Complet (Attention !)

```bash
# Backup avant !
./scripts/backup.sh

# Arrêter et supprimer tout
docker compose down -v
rm -rf data/*

# Redémarrer
./scripts/start.sh

# Reconfigurer n8n :
# - Reimporter workflows
# - Recréer credentials
```

---

## 📈 Monitoring

```bash
# Statistiques complètes
./scripts/status.sh

# Watch mode (refresh 5s)
watch -n 5 ./scripts/status.sh

# Ressources Docker
docker stats

# Taille base de données
docker compose exec postgres psql -U n8n veille_ia -c \
  "SELECT pg_size_pretty(pg_database_size('veille_ia'));"
```

---

## ⚙️ Personnalisation

### Changer Fréquence Veille

Dans n8n → Workflow → Nœud "Schedule Trigger" :

```
0 */2 * * *  → Toutes les 2h
0 */4 * * *  → Toutes les 4h
0 */6 * * *  → Toutes les 6h
0 9,18 * * * → À 9h et 18h
0 * * * *    → Toutes les heures
```

### Ajouter Mots-Clés

Dans n8n → Nœud "Code - Filtrer mots-clés" :

```javascript
const aiKeywords = [
  'llm', 'gpt', 'claude',
  'votre-mot-clé',  // Ajouter ici
];
```

### Changer Port n8n

Dans `.env` :

```bash
N8N_PORT=8080  # Au lieu de 5678
```

Puis :

```bash
./scripts/restart.sh
```

---

## 🔒 Sécurité

```bash
# Firewall
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 5678/tcp  # n8n
sudo ufw enable

# Vérifier
sudo ufw status

# Changer mot de passe n8n
nano .env
# Modifier N8N_BASIC_AUTH_PASSWORD
./scripts/restart.sh
```

---

## 📚 Fichiers Importants

```
docker-compose.yml       → Services Docker
env.template             → Template config
.env                     → Configuration (CRÉER)
rss_sources.json         → Sources RSS
scripts/init.sql         → Schéma PostgreSQL

README.md                → Doc principale
QUICKSTART.md            → Guide 5 min
DEPLOIEMENT.md           → Guide complet
docs/INSTALL.md          → Installation détaillée
docs/MAINTENANCE.md      → Maintenance
docs/TROUBLESHOOTING.md  → Dépannage
```

---

## 🎯 Workflow Typique Journalier

```bash
# Matin
./scripts/status.sh        # Vérifier santé

# Si problème
./scripts/logs.sh n8n      # Voir logs

# Hebdomadaire
./scripts/backup.sh        # Backup manuel

# Mensuel
docker compose pull        # Mise à jour images
docker compose up -d       # Redémarrer
```

---

## 💡 Tips

- **Backup avant toute modif** : `./scripts/backup.sh`
- **Logs = votre ami** : `./scripts/logs.sh all`
- **Status régulièrement** : `./scripts/status.sh`
- **Tester avant prod** : Execute Workflow manuellement
- **Documenter vos modifs** : Commentaires dans workflow

---

## 🔗 Liens Utiles

- [n8n Documentation](https://docs.n8n.io/)
- [PostgreSQL Docs](https://www.postgresql.org/docs/)
- [RSSHub Routes](https://docs.rsshub.app/)
- [Discord Webhooks](https://discord.com/developers/docs/resources/webhook)

---

## 📞 Support

- 📖 Documentation : [README.md](README.md)
- 🆘 Dépannage : [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- 💬 Issues GitHub
- 📧 Email support

---

**Imprimez ce cheatsheet et gardez-le à portée de main !** 📌
