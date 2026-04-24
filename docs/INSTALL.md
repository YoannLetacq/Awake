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

- ✅ Serveur Discord (avec droits admin)
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
mkdir -p data/{postgres,n8n,prometheus,grafana} backups logs scripts docs

# Copier les fichiers depuis votre machine locale
# Ou les créer manuellement en suivant le README
```

---

## Configuration

### 1. Créer le Webhook Discord

**Sur Discord :**

1. Ouvrir votre serveur Discord
2. Clic droit sur le salon → **Modifier le salon**
3. **Intégrations** → **Webhooks** → **Nouveau Webhook**
4. Nommer : "Veille IA"
5. **Copier l'URL** (format : `https://discord.com/api/webhooks/...`)

### 2. Éditer le Fichier .env

```bash
# Ouvrir l'éditeur
nano .env

# Ou utiliser vim
vim .env
```

**Modifications essentielles :**

```bash
# 1. COLLER VOTRE WEBHOOK DISCORD
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1234567890/ABCDEFG...

# 2. (Optionnel) Changer le port n8n si 5678 est déjà utilisé
N8N_PORT=5678

# 3. (Optionnel) Ajuster la timezone
TZ=Europe/Paris
```

**Les mots de passe sont déjà générés** automatiquement par `setup.sh` ! ✅

Sauvegarder :
- Nano : `Ctrl+O`, `Enter`, `Ctrl+X`
- Vim : `Esc`, `:wq`, `Enter`

### 3. Vérifier la Configuration

```bash
# Vérifier que DISCORD_WEBHOOK_URL est défini
grep DISCORD_WEBHOOK_URL .env

# Vérifier que les mots de passe sont générés
grep PASSWORD .env | grep -v "CHANGEME"

# Si "CHANGEME" apparaît encore, relancer setup
./scripts/setup.sh
```

---

## Premier Démarrage

### Démarrage des Services

```bash
# Lancer tous les services
./scripts/start.sh

# Le script va :
# 1. Vérifier .env
# 2. Démarrer Docker Compose
# 3. Attendre 30 secondes (initialisation)
# 4. Afficher les URLs et credentials
```

**Sortie attendue :**

```
🚀 Démarrage du Système de Veille IA...

🐳 Démarrage des containers Docker...
[+] Running 3/3
 ✔ Container veille-postgres  Started
 ✔ Container veille-rsshub     Started
 ✔ Container veille-n8n        Started

⏳ Attente de l'initialisation (30 secondes)...

📊 Statut des services:
NAME                STATUS          PORTS
veille-postgres     running         5432/tcp
veille-n8n          running         0.0.0.0:5678->5678/tcp
veille-rsshub       running         0.0.0.0:1200->1200/tcp

✅ Système démarré !

🔗 URLs d'accès:
   n8n Interface: http://localhost:5678
   RSSHub: http://localhost:1200

🔐 Credentials n8n:
   User: admin
   Pass: xT9kL2mP4nR7qW
```

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

**URL :** `http://VOTRE_IP_SERVEUR:5678`

- Si local : `http://localhost:5678`
- Si VPS : `http://123.45.67.89:5678`

**Identifiants :**
- User : `admin`
- Pass : (affiché lors du démarrage)

### 2. Premiers Pas

1. **Se connecter** avec admin/password
2. Vous arrivez sur le dashboard n8n vide

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

#### Discord Webhook

1. **Settings** → **Credentials** → **"+ Add Credential"**
2. Chercher **"Discord Webhook"**
3. **Webhook URL** : (votre URL Discord)
4. **Save**

### 4. Importer le Workflow Principal

**Option A : Import Automatique (si fichier fourni)**

1. Cliquer sur **"+"** en haut (nouveau workflow)
2. Menu **"⋯"** (3 points) → **"Import from File"**
3. Sélectionner `workflows/veille-ia-master.json`
4. Le workflow s'affiche automatiquement

**Option B : Création Manuelle**

Créez le workflow manuellement dans l'interface n8n en suivant la structure décrite ci-dessus.

### 5. Configurer le Workflow

1. **Double-cliquer** sur le nœud "Schedule Trigger" (premier)
2. Vérifier : `0 */2 * * *` (toutes les 2h)
3. **Save**

4. **Double-cliquer** sur chaque nœud "RSS Feed Read"
5. Vérifier les URLs (dans `rss_sources.json`)
6. **Save** chacun

7. **Double-cliquer** sur le nœud "Postgres"
8. Sélectionner le credential PostgreSQL créé
9. **Save**

10. **Double-cliquer** sur le nœud "Discord Webhook"
11. Sélectionner le credential Discord créé
12. **Save**

13. **Save** le workflow complet (bouton en haut à droite)

### 6. Tester le Workflow

1. Cliquer sur **"Execute Workflow"** (triangle ▶️)
2. Attendre 10-30 secondes
3. Observer l'exécution nœud par nœud
4. **Vérifier Discord** : des articles devraient apparaître ! 🎉

Si aucun article :
- C'est normal si pas d'articles publiés dans les 2 dernières heures
- Désactivez temporairement le filtre temporel pour tester

### 7. Activer le Workflow

**En haut à droite** : Toggle "Inactive" → **"Active"**

Le workflow se lancera automatiquement toutes les 2 heures !

---

## Vérifications

### Checklist Post-Installation

- [ ] Docker et Docker Compose installés
- [ ] Containers démarrés (postgres, n8n, rsshub)
- [ ] n8n accessible sur http://IP:5678
- [ ] Connexion PostgreSQL OK
- [ ] Webhook Discord configuré
- [ ] Workflow importé et sauvegardé
- [ ] Test manuel réussi (articles sur Discord)
- [ ] Workflow activé (toggle ON)

### Tests de Fonctionnement

```bash
# 1. Vérifier que les containers tournent
docker compose ps
# Tous doivent être "running"

# 2. Tester PostgreSQL
docker compose exec postgres psql -U n8n veille_ia -c "SELECT COUNT(*) FROM rss_articles;"
# Devrait retourner un nombre (0 si aucun article encore)

# 3. Tester RSSHub
curl http://localhost:1200
# Devrait retourner la page d'accueil HTML

# 4. Voir les statistiques
./scripts/status.sh
```

### Vérifier les Logs

```bash
# Logs PostgreSQL
./scripts/logs.sh postgres

# Logs n8n (chercher erreurs)
./scripts/logs.sh n8n | grep -i error

# Logs RSSHub
./scripts/logs.sh rsshub
```

---

## Sécurisation

### Configurer le Firewall

```bash
# Installer ufw (si pas déjà installé)
sudo apt install -y ufw

# Autoriser SSH
sudo ufw allow 22/tcp

# Autoriser n8n (si accès externe nécessaire)
sudo ufw allow 5678/tcp

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

### Limiter l'Accès n8n par IP (Optionnel)

```bash
# Autoriser uniquement votre IP
sudo ufw allow from VOTRE_IP to any port 5678

# Ou utiliser un VPN
```

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
