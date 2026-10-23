# 📦 Guide d'Installation Détaillé

Guide complet pour installer le système de veille IA sur n'importe quel environnement.

## 📋 Table des Matières

1. [Prérequis](#prérequis)
2. [Installation Docker](#installation-docker)
3. [Installation du Système](#installation-du-système)
4. [Configuration](#configuration)
5. [Premier Démarrage](#premier-démarrage)
6. [Configuration n8n](#configuration-n8n)
7. [Vérifications](#vérifications)
8. [Sécurisation](#sécurisation)

---

## Prérequis

### Matériel Recommandé

| Composant | Minimum | Recommandé |
|-----------|---------|------------|
| CPU | 1 core | 2 cores |
| RAM | 2 GB | 4 GB |
| Stockage | 10 GB | 20 GB |
| Bande passante | 100 Mbps | 500 Mbps |

### Systèmes d'Exploitation Supportés

- ✅ Ubuntu 20.04 / 22.04 / 24.04 LTS
- ✅ Debian 11 / 12
- ✅ CentOS 8+ / Rocky Linux 8+
- ✅ Fedora 36+
- ✅ Raspberry Pi OS (64-bit)

### Comptes Nécessaires

- ✅ Serveur Discord (avec droits admin) et une application Discord pour le bot
- ✅ Compte Reddit (pour créer une app API « script »)
- ✅ Clé API Gemini ([AI Studio](https://aistudio.google.com/apikey))
- ✅ Accès SSH au serveur
- ⚠️ Compte GitHub (optionnel, pour versionner)

---

## Installation Docker

### Ubuntu / Debian

```bash
# Mise à jour du système
sudo apt update && sudo apt upgrade -y

# Installation des dépendances
sudo apt install -y curl git ca-certificates gnupg

# Installation Docker
curl -fsSL https://get.docker.com | sh

# Ajouter l'utilisateur au groupe docker
sudo usermod -aG docker $USER

# Installation Docker Compose plugin
sudo apt install -y docker-compose-plugin

# Vérification
docker --version
docker compose version

# IMPORTANT : Déconnexion/reconnexion nécessaire !
exit
# Reconnectez-vous en SSH
```

### CentOS / Rocky Linux / Fedora

```bash
# Mise à jour
sudo dnf update -y

# Installation Docker
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Démarrer Docker
sudo systemctl start docker
sudo systemctl enable docker

# Ajouter utilisateur au groupe
sudo usermod -aG docker $USER

# Vérification
docker --version
docker compose version
```

### Raspberry Pi (64-bit)

```bash
# Installation via script officiel
curl -fsSL https://get.docker.com | sh

# Ajouter pi au groupe docker
sudo usermod -aG docker pi

# Installation Docker Compose
sudo apt install -y docker-compose-plugin

# Redémarrer
sudo reboot
```

---

## Installation du Système

### Méthode 1 : Clonage Git (Recommandé)

```bash
# Se placer dans le répertoire home
cd ~

# Cloner le repository
git clone https://github.com/VOTRE-USERNAME/veille-ia.git
cd veille-ia

# Donner les droits d'exécution aux scripts
chmod +x scripts/*.sh

# Lancer l'installation automatique
./scripts/setup.sh
```

### Méthode 2 : Téléchargement Manuel

```bash
# Télécharger l'archive
wget https://github.com/VOTRE-USERNAME/veille-ia/archive/refs/heads/main.zip

# Décompresser
unzip main.zip
mv veille-ia-main veille-ia
cd veille-ia

# Droits d'exécution
chmod +x scripts/*.sh

# Installation
./scripts/setup.sh
```

### Méthode 3 : Installation Manuelle

```bash
# Créer le répertoire
mkdir -p ~/veille-ia
cd ~/veille-ia

# Créer la structure
mkdir -p data/{postgres,n8n} backups logs scripts docs

# Copier les fichiers depuis votre machine locale
# Ou les créer manuellement en suivant le README
```

---

## Configuration

### 1. Créer les Webhooks et le Bot Discord

**Webhooks** : un par salon de publication (quatre au total). Pour chaque salon :

1. Ouvrir votre serveur Discord
2. Clic droit sur le salon → **Modifier le salon**
3. **Intégrations** → **Webhooks** → **Nouveau Webhook**
4. Nommer : "Veille IA"
5. **Copier l'URL** (format : `https://discord.com/api/webhooks/...`)

**Bot** : il reçoit les mentions et répond « Rien de nouveau ». Les articles partent par les webhooks. Dans le [portail développeur Discord](https://discord.com/developers/applications) :

1. **New Application**, puis onglet **Bot** → **Reset Token** → copier le token (affiché une seule fois) : c'est `DISCORD_BOT_TOKEN`
2. Toujours dans **Bot**, activer **MESSAGE CONTENT INTENT**
3. **OAuth2** → **URL Generator** : scope `bot`, permissions *View Channels*, *Send Messages*, *Read Message History*, puis inviter le bot sur votre serveur

### 2. Éditer le Fichier .env

```bash
# Ouvrir l'éditeur
nano .env

# Ou utiliser vim
vim .env
```

**Modifications essentielles :**

```bash
# 1. TOKEN DU BOT et UN WEBHOOK PAR SALON
DISCORD_BOT_TOKEN=VOTRE_TOKEN_BOT
DISCORD_WEBHOOK_TECH_NEWS=https://discord.com/api/webhooks/VOTRE_ID/VOTRE_TOKEN
DISCORD_WEBHOOK_COMPANIES=https://discord.com/api/webhooks/VOTRE_ID/VOTRE_TOKEN
DISCORD_WEBHOOK_REDDIT=https://discord.com/api/webhooks/VOTRE_ID/VOTRE_TOKEN
DISCORD_WEBHOOK_OTHERS=https://discord.com/api/webhooks/VOTRE_ID/VOTRE_TOKEN

# 2. QUI PEUT MENTIONNER LE BOT : identifiants Discord séparés par des virgules
#    Liste vide = toutes les mentions sont ignorées
DISCORD_ALLOWED_AUTHORS=ID_UTILISATEUR_1,ID_UTILISATEUR_2

# 3. CLÉ API GEMINI (https://aistudio.google.com/apikey)
GEMINI_API_KEY=VOTRE_CLE_GEMINI

# 4. (Optionnel) Changer le port n8n si 5678 est déjà utilisé
N8N_PORT=5678

# 5. (Optionnel) Ajuster la timezone
TZ=Europe/Paris
```

Pour obtenir un identifiant Discord : activer le **Mode développeur** (Paramètres utilisateur → Avancé), puis clic droit sur votre profil → **Copier l'identifiant**.

**Les mots de passe sont déjà générés** automatiquement par `setup.sh` ! ✅

Sauvegarder :
- Nano : `Ctrl+O`, `Enter`, `Ctrl+X`
- Vim : `Esc`, `:wq`, `Enter`

### 3. Vérifier la Configuration

```bash
# Lister les variables requises vides ou encore au modèle YOUR_ (aucune valeur affichée)
for v in DISCORD_BOT_TOKEN DISCORD_WEBHOOK_TECH_NEWS DISCORD_WEBHOOK_COMPANIES DISCORD_WEBHOOK_REDDIT DISCORD_WEBHOOK_OTHERS DISCORD_ALLOWED_AUTHORS GEMINI_API_KEY; do
  grep -qE "^$v=.+" .env && ! grep -qE "^$v=.*YOUR_" .env || echo "$v non configuré"
done

# Vérifier que les mots de passe sont générés
grep PASSWORD .env | grep -v "CHANGEME"

# Si "CHANGEME" apparaît encore, relancer setup
./scripts/setup.sh
```

Une variable signalée « non configuré » déclenche un avertissement au démarrage (voir ci-dessous). Un salon dont le webhook n'est pas configuré n'est simplement pas publié : ses articles restent en attente en base, sans erreur visible.

---

## Premier Démarrage

### Démarrage des Services

```bash
# Lancer tous les services
./scripts/start.sh
```

Le script se place dans le répertoire du projet, puis exécute ces étapes dans l'ordre :

1. **Contrôle de `.env`** : si le fichier est absent, il affiche `❌ Fichier .env introuvable !` et `   Lancez d'abord: ./scripts/setup.sh`, puis s'arrête (code de sortie 1).
2. **Contrôle de sept variables** : `DISCORD_WEBHOOK_TECH_NEWS`, `DISCORD_WEBHOOK_COMPANIES`, `DISCORD_WEBHOOK_REDDIT`, `DISCORD_WEBHOOK_OTHERS`, `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_AUTHORS` et `GEMINI_API_KEY`. Une variable est signalée si elle est vide ou contient encore `YOUR_`. Les quatre `DISCORD_WEBHOOK_*` sont aussi signalées si leur valeur n'a pas la forme d'une URL de webhook Discord (`https://discord.com/api/webhooks/<id>/<token>`). Chaque variable signalée produit une ligne d'avertissement ; la valeur n'est jamais affichée.
3. **Confirmation** : s'il y a au moins une variable signalée, le script demande `Continuer quand même ? (y/N)`. Seule la touche `y` ou `Y` poursuit le démarrage. Toute autre touche, Entrée comprise, arrête le script (code de sortie 1) sans lancer Docker.
4. **Lancement** : `docker compose up -d`. Si cette commande échoue, le script s'arrête.
5. **Attente** : 30 secondes fixes (`sleep 30`), sans contrôle de l'état des services.
6. **Affichage** : `docker compose ps`, puis `✅ Système démarré !`, l'URL d'accès et les consignes de connexion. Ce message est affiché même si un container n'est pas `running` : vérifiez l'état donné par `docker compose ps`.

**Sortie quand aucune variable n'est signalée** (les lignes `[sortie de …]` remplacent la sortie de Docker, non reproduite ici) :

```
🚀 Démarrage du Système de Veille IA...

🐳 Démarrage des containers Docker...
[sortie de docker compose up -d]

⏳ Attente de l'initialisation (30 secondes)...

📊 Statut des services:
[sortie de docker compose ps]

✅ Système démarré !

🔗 URLs d'accès:
   n8n Interface: http://localhost:5678

🔐 n8n Login:
   Première fois: Créez votre compte sur la page /setup
   Ensuite: Utilisez votre email/mot de passe personnel

📝 Voir les logs: ./scripts/logs.sh [service]
📊 Voir le status: ./scripts/status.sh
```

**Variable signalée** (exemple : `DISCORD_BOT_TOKEN` vide, réponse `n`) :

```
⚠️  WARNING: DISCORD_BOT_TOKEN n'est pas configuré dans .env
   Les fonctionnalités liées à ces variables ne fonctionneront pas.

Continuer quand même ? (y/N)
```

**Fichier `.env` absent :**

```
❌ Fichier .env introuvable !
   Lancez d'abord: ./scripts/setup.sh
```

L'URL affichée est toujours `http://localhost:5678`, même si vous avez changé `N8N_PORT` : ouvrez alors le port choisi. Sans variable à signaler, il n'y a aucune question : la stack démarre directement, comme ci-dessus.

### Vérifier le Démarrage

```bash
# Voir le statut complet
./scripts/status.sh

# Voir les logs en temps réel
./scripts/logs.sh n8n

# Voir tous les logs
./scripts/logs.sh all
```

---

## Configuration n8n

### 1. Accéder à l'Interface

**URL :** `http://localhost:5678`

Le port est publié sur `127.0.0.1` : n8n n'est joignable que depuis la machine hôte. Sur un VPS, utilisez un tunnel SSH (voir [Sécurisation](#sécurisation)).

**Premier accès :** créez le compte propriétaire (email et mot de passe) sur la page `/setup`. Il n'existe pas d'identifiant par défaut.

### 2. Premiers Pas

1. **Se connecter** avec le compte créé à l'étape précédente
2. Vous arrivez sur le dashboard n8n vide
3. **Installer le nœud communautaire** : **Settings** → **Community Nodes** → **Install**, saisir `n8n-nodes-discord-trigger`, puis confirmer. Ce paquet fournit le type de nœud et le credential « Discord Bot Trigger », requis par le nœud « Discord Bot mention1 ».

### 3. Ajouter les Credentials

#### PostgreSQL

1. Menu gauche → **Settings** (⚙️) → **Credentials**
2. Cliquer **"+ Add Credential"**
3. Chercher **"Postgres"**
4. Remplir :
   ```
   Host: postgres
   Database: veille_ia
   User: n8n
   Password: (dans .env, ligne POSTGRES_PASSWORD)
   Port: 5432
   SSL: Disable
   ```
   **Note:** Utiliser port 5432 ici (communication interne entre containers). Le port externe vers l'hôte est 5433.
5. **Test Connection** → Success ✅
6. **Save**

Ce credential sert à tous les nœuds Postgres du workflow : Insert Candidates, Claim Unscored, Save Scores, Purge Old Articles, Claim Top Articles.

#### Discord Bot Trigger

1. **Settings** → **Credentials** → **"+ Add Credential"**
2. Chercher **"Discord Bot Trigger"**
3. Renseigner le token du bot (la valeur de `DISCORD_BOT_TOKEN`)
4. **Save**

Ce credential est utilisé par le nœud "Discord Bot mention1".

#### Reddit OAuth2

1. Créer une app sur <https://www.reddit.com/prefs/apps> : **create another app**, type **script**, URI de redirection `http://localhost` (non utilisée). Noter le **client ID** (sous le nom de l'app) et le **secret**.
2. Dans n8n : **Settings** → **Credentials** → **"+ Add Credential"** → chercher **"OAuth2 API"**
3. Remplir :
   ```
   Name: Reddit OAuth2
   Grant Type: Client Credentials
   Access Token URL: https://www.reddit.com/api/v1/access_token
   Client ID: (client ID de l'app Reddit)
   Client Secret: (secret de l'app Reddit)
   Authentication: Header
   ```
4. **Save**

Le secret reste dans le credential chiffré de n8n, jamais dans `.env`. Ce credential est utilisé par le nœud "Reddit Fetch".

### 4. Importer le Workflow Principal

1. Cliquer sur **"+"** en haut (nouveau workflow)
2. Menu **"⋯"** (3 points) → **"Import from File"**
3. Sélectionner `workflow-simplified.json` (à la racine du dépôt)
4. Le workflow s'affiche automatiquement

### 5. Configurer le Workflow

1. **Double-cliquer** sur le nœud "Every 30 Minutes" et vérifier l'intervalle : 30 minutes
2. **Save**

3. **Double-cliquer** sur le nœud "Reddit Fetch" et sélectionner le credential **Reddit OAuth2**
4. **Save**

5. **Double-cliquer** sur chaque nœud Postgres (Insert Candidates, Claim Unscored, Save Scores, Purge Old Articles, Claim Top Articles)
6. Sélectionner le credential PostgreSQL créé
7. **Save**

8. **Double-cliquer** sur le nœud "Discord Bot mention1"
9. Sélectionner le credential **Discord Bot Trigger**
10. Remplacer les identifiants du serveur et des salons (champs `guildIds` et `channelIds`) par les vôtres : ceux du workflow livré viennent d'une autre installation
11. **Save**

12. **Save** le workflow complet (bouton en haut à droite)

Les flux RSS ne se règlent pas dans n8n : ils viennent de `rss_sources.json`.

### 6. Tester le Workflow

1. Cliquer sur **"Execute Workflow"** (triangle ▶️) depuis le nœud "Every 30 Minutes"
2. Attendre la fin de l'exécution (collecte, scoring Gemini, purge)
3. Observer l'exécution nœud par nœud
4. Vérifier en base que les articles sont scorés :
   ```bash
   docker compose exec postgres psql -U n8n veille_ia -c "SELECT count(*) FROM rss_articles WHERE gemini_confidence IS NOT NULL;"
   ```
5. **Mentionner le bot** dans un salon configuré, depuis un compte listé dans `DISCORD_ALLOWED_AUTHORS` : il poste les meilleurs articles, ou répond « Rien de nouveau » 🎉

Si aucun article :
- C'est normal s'il n'y a pas d'article publié dans les 48 dernières heures, avec une confiance ≥ 85 et un score ≥ 60
- Une mention d'un compte absent de `DISCORD_ALLOWED_AUTHORS` est ignorée, sans réponse

### 7. Activer le Workflow

**En haut à droite** : Toggle "Inactive" → **"Active"**

La collecte et le scoring se lanceront automatiquement toutes les 30 minutes. Les mentions Discord, elles, reçoivent une réponse à la demande.

---

## Vérifications

### Checklist Post-Installation

- [ ] Docker et Docker Compose installés
- [ ] Containers démarrés (postgres, n8n)
- [ ] n8n accessible sur http://localhost:5678
- [ ] Connexion PostgreSQL OK
- [ ] Webhooks Discord configurés (4 salons) et `DISCORD_ALLOWED_AUTHORS` renseigné
- [ ] Credentials Postgres, Discord Bot Trigger et Reddit OAuth2 configurés
- [ ] Workflow importé et sauvegardé
- [ ] Test manuel réussi (articles scorés, mention du bot)
- [ ] Workflow activé (toggle ON)

### Tests de Fonctionnement

```bash
# 1. Vérifier que les containers tournent
docker compose ps
# Tous doivent être "running"

# 2. Tester PostgreSQL
docker compose exec postgres psql -U n8n veille_ia -c "SELECT COUNT(*) FROM rss_articles;"
# Devrait retourner un nombre (0 si aucun article encore)

# 3. Voir les statistiques
./scripts/status.sh
```

### Vérifier les Logs

```bash
# Logs PostgreSQL
./scripts/logs.sh postgres

# Logs n8n (chercher erreurs)
./scripts/logs.sh n8n | grep -i error
```

---

## Sécurisation

### Configurer le Firewall

```bash
# Installer ufw (si pas déjà installé)
sudo apt install -y ufw

# Autoriser SSH
sudo ufw allow 22/tcp

# Activer le firewall
sudo ufw enable

# Vérifier
sudo ufw status
```

### Changer les Ports par Défaut (Optionnel)

Dans `.env` :

```bash
# Changer le port n8n
N8N_PORT=8080  # Au lieu de 5678

# Puis redémarrer
docker compose down
docker compose up -d
```

### Mettre en Place un Reverse Proxy (Production)

Pour la production, configurez :
- Reverse proxy (Traefik ou Nginx)
- SSL avec Let's Encrypt
- Nom de domaine custom

### Accès distant par tunnel SSH

n8n n'est pas exposé sur le réseau (port publié sur `127.0.0.1`). Depuis votre poste :

```bash
ssh -L 5678:localhost:5678 utilisateur@VPS_IP
```

Puis ouvrir `http://localhost:5678` dans votre navigateur.

---

## 🎉 Félicitations !

Votre système de veille IA est installé et opérationnel !

### Prochaines Étapes

1. ✅ **Lire** [QUICKSTART.md](../QUICKSTART.md) pour utilisation rapide
2. ✅ **Personnaliser** vos workflows dans l'interface n8n
3. ✅ **Configurer** les backups automatiques ([MAINTENANCE.md](MAINTENANCE.md))
4. ✅ **Explorer** les sources RSS disponibles (`rss_sources.json`)

### Support

- 🐛 Problème ? → [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- 💬 Question ? → Ouvrir une issue GitHub
- 📖 Documentation complète → [README.md](../README.md)

---

**Installation terminée en ~10 minutes** ⚡
