# 🤖 Système de Veille IA Automatique

Système de veille technologique automatisé pour l'Intelligence Artificielle, utilisant n8n, PostgreSQL et Discord.

## 🌟 Caractéristiques

- ✅ **25+ sources RSS** centralisées dans `rss_sources.json` (TechCrunch, Hacker News, GitHub, OpenAI, Anthropic, Reddit...)
- ✅ **Déduplication intelligente** avec stockage PostgreSQL (90 jours)
- ✅ **Catégorisation automatique** (🧠 LLM, 🤖 Agents, 🎨 Vision, 💻 Coding...)
- ✅ **Filtrage + résumé par IA Gemini** (score de pertinence, confiance, résumé, takeaway)
- ✅ **Déclenchement par mention Discord Bot** + lock Redis anti-spam
- ✅ **4 webhooks Discord** (Tech News / Companies / Reddit / Others)
- ✅ **100% Open Source** et self-hostable
- ✅ **Backups automatiques** quotidiens
- ✅ **Monitoring** et logs intégrés

## 📋 Prérequis

- **VPS ou serveur local** avec :
  - Ubuntu 20.04+ / Debian 11+ (ou équivalent)
  - 2GB RAM minimum (4GB recommandé)
  - 20GB d'espace disque
  - Docker et Docker Compose
- **Serveur Discord** avec droits administrateur
- **Webhook Discord** configuré

## 🚀 Installation Rapide

```bash
# 1. Cloner le projet
git clone https://github.com/votre-username/veille-ia.git
cd veille-ia

# 2. Lancer le setup automatique
./scripts/setup.sh

# 3. Éditer le fichier .env et ajouter votre DISCORD_WEBHOOK_URL
nano .env

# 4. Démarrer le système
./scripts/start.sh

# 5. Accéder à n8n
# URL: http://localhost:5678
# User: admin
# Pass: (affiché par le script setup)
```

## 📁 Structure du Projet

```
veille-ia/
├── docker-compose.yml      # Orchestration des services
├── env.template            # Template de configuration
├── .env                    # Configuration (à créer)
├── rss_sources.json        # Liste complète des sources RSS (single source of truth)
├── workflow-simplified.json # Workflow n8n courant (25 nodes)
├── old.json                # Ancien workflow (61 nodes) conservé pour référence
├── scripts/
│   ├── setup.sh            # Installation initiale
│   ├── start.sh            # Démarrer le système
│   ├── stop.sh             # Arrêter le système
│   ├── restart.sh          # Redémarrer
│   ├── status.sh           # Vérifier le statut
│   ├── logs.sh             # Consulter les logs
│   ├── backup.sh           # Backup manuel
│   ├── restore.sh          # Restaurer backup
│   └── init.sql            # Schéma PostgreSQL
├── data/                   # Données persistantes
│   ├── postgres/           # Base de données
│   └── n8n/                # Workflows n8n
├── backups/                # Backups automatiques
├── logs/                   # Fichiers de logs
└── docs/
    ├── INSTALL.md          # Guide installation détaillé
    ├── MAINTENANCE.md      # Guide de maintenance
    └── TROUBLESHOOTING.md  # Résolution de problèmes
```

## 🔧 Configuration

### Webhook Discord

1. Sur Discord, aller dans **Paramètres du salon** → **Intégrations** → **Webhooks**
2. Cliquer sur **Nouveau Webhook**
3. Nommer le webhook "Veille IA"
4. Copier l'URL du webhook
5. Ajouter dans `.env` :
```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
```

### Sources RSS

Le fichier `rss_sources.json` contient toutes les sources disponibles. Pour activer/désactiver une source, modifier le champ `"active"`.

Catégories disponibles :
- **Tech News** : TechCrunch, Hacker News
- **AI Companies** : OpenAI, Anthropic, Microsoft, Hugging Face
- **AI Research** : ArXiv, Papers With Code, DeepMind
- **Experts & Analysis** : Gary Marcus, Simon Willison
- **Reddit Communities** : r/MachineLearning, r/OpenAI, r/Anthropic...

## 📊 Utilisation

### Importer le Workflow n8n

Le fichier `workflow-simplified.json` contient le workflow courant (25 nodes, enrichi Gemini) prêt à l'emploi :
1. Dans n8n : **+ → ⋯ → Import from File**
2. Sélectionnez `workflow-simplified.json`
3. Configurez les credentials PostgreSQL et Discord
4. Activez le workflow !

> `old.json` est l'ancienne version (61 nodes, 11 feeds hardcodés) conservée à titre de référence.

### Commandes Principales

```bash
# Démarrer le système
./scripts/start.sh

# Voir le statut et les statistiques
./scripts/status.sh

# Consulter les logs en temps réel
./scripts/logs.sh n8n        # Logs n8n
./scripts/logs.sh postgres   # Logs PostgreSQL
./scripts/logs.sh rsshub     # Logs RSSHub
./scripts/logs.sh all        # Tous les logs

# Faire un backup
./scripts/backup.sh

# Redémarrer
./scripts/restart.sh

# Arrêter
./scripts/stop.sh
```

### Interface n8n

Accéder à : `http://VOTRE_IP:5678`

**Workflows inclus :**
1. **Veille IA Master** : Collecte et envoi des articles (toutes les 2h)
2. **Purge Articles** : Nettoyage automatique > 90 jours (quotidien à 3h)

## 🔐 Sécurité

- ✅ Tous les mots de passe générés automatiquement (32+ caractères)
- ✅ Authentification Basic Auth sur n8n
- ✅ Base de données PostgreSQL isolée
- ✅ Fichier `.env` exclu du git
- ✅ Logs avec rotation automatique

### Recommandations Production

```bash
# Configurer un firewall
sudo ufw enable
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 5678/tcp  # n8n (ou via reverse proxy uniquement)

# Mettre en place un reverse proxy (Traefik/Nginx) avec SSL
```

## 📈 Monitoring

### Statistiques en Temps Réel

```bash
./scripts/status.sh
```

Affiche :
- État des containers
- Nombre d'articles total/envoyés
- Articles des dernières 24h/7 jours
- Nombre de sources/catégories
- Utilisation disque

### Dashboard PostgreSQL

```bash
docker compose exec postgres psql -U n8n veille_ia
```

```sql
-- Vue des statistiques
SELECT * FROM article_stats;

-- Statistiques par source
SELECT * FROM get_source_stats();

-- Articles récents
SELECT title, source, category, published_at
FROM rss_articles
ORDER BY published_at DESC
LIMIT 10;
```

## 🛠️ Maintenance

### Backups Automatiques

Les backups sont créés quotidiennement via cron. Pour configurer :

```bash
# Éditer crontab
crontab -e

# Ajouter cette ligne (backup quotidien à 4h du matin)
0 4 * * * cd /chemin/vers/veille-ia && ./scripts/backup.sh >> logs/backup.log 2>&1
```

### Purge Manuelle

```bash
# Se connecter à PostgreSQL
docker compose exec postgres psql -U n8n veille_ia

# Purger articles > 90 jours
SELECT purge_old_articles();
```

### Mise à Jour

```bash
# Mettre à jour les images Docker
docker compose pull

# Redémarrer avec nouvelles images
docker compose up -d

# Vérifier
./scripts/status.sh
```

## 📚 Documentation Complète

- [**INSTALL.md**](docs/INSTALL.md) - Installation détaillée pas-à-pas
- [**MAINTENANCE.md**](docs/MAINTENANCE.md) - Guide de maintenance
- [**TROUBLESHOOTING.md**](docs/TROUBLESHOOTING.md) - Résolution de problèmes

## 🤝 Contribution

Les contributions sont les bienvenues ! N'hésitez pas à ouvrir une issue ou une pull request.

## 📄 Licence

MIT License

## 💡 Support

- 🐛 **Bugs** : Ouvrir une issue GitHub
- 💬 **Questions** : Discussions GitHub
- 📧 **Contact** : votre@email.com

## 🎯 Roadmap

- [x] Résumés automatiques via Gemini (score + confidence + summary + takeaway)
- [x] Support multi-webhook Discord (Tech News / Companies / Reddit / Others)
- [x] Déclenchement par mention Discord Bot + lock Redis
- [x] Sources RSS centralisées dans `rss_sources.json`
- [ ] Déplacer backup / purge / status vers GitHub Actions (CI cron)
- [ ] Interface web de consultation des articles
- [ ] Export CSV/JSON des articles
- [ ] Alertes prioritaires pour breaking news
- [ ] Support LinkedIn via scraper
- [ ] Dashboard Grafana préconfiguré
- [ ] Filtres personnalisés par utilisateur

## ⭐ Remerciements

- [n8n](https://n8n.io/) - Automatisation workflow
- [RSSHub](https://rsshub.app/) - Génération feeds RSS
- [PostgreSQL](https://www.postgresql.org/) - Base de données
- Toutes les sources RSS utilisées

---

**Made with ❤️ for the AI Community**
