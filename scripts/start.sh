#!/bin/bash
# ==========================================
# DÉMARRER LE SYSTÈME DE VEILLE IA
# ==========================================

set -e

# Résoudre le répertoire du projet
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "🚀 Démarrage du Système de Veille IA..."
echo ""

# Vérifier que .env existe
if [ ! -f .env ]; then
    echo "❌ Fichier .env introuvable !"
    echo "   Lancez d'abord: ./scripts/setup.sh"
    exit 1
fi

# Read one variable from .env without sourcing the file or printing its value
env_value() {
    sed -n "s/^$1=//p" .env | tail -n 1 \
        | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# Discord and Gemini variables must be filled in; a webhook must match the Discord URL shape
WEBHOOK_RE='^https://(discord|discordapp)\.com/api/webhooks/[0-9]+/[0-9A-Za-z_-]+$'
MISSING_COUNT=0
for var in DISCORD_WEBHOOK_TECH_NEWS DISCORD_WEBHOOK_COMPANIES DISCORD_WEBHOOK_REDDIT DISCORD_WEBHOOK_OTHERS DISCORD_BOT_TOKEN DISCORD_ALLOWED_AUTHORS GEMINI_API_KEY; do
    value=$(env_value "$var")
    is_missing=0
    case "$value" in
        "" | *YOUR_*) is_missing=1 ;;
    esac
    if [[ $var == DISCORD_WEBHOOK_* ]] && [[ ! $value =~ $WEBHOOK_RE ]]; then
        is_missing=1
    fi
    if [ "$is_missing" -eq 1 ]; then
        echo "⚠️  WARNING: $var n'est pas configuré dans .env"
        MISSING_COUNT=$((MISSING_COUNT + 1))
    fi
done

if [ "$MISSING_COUNT" -gt 0 ]; then
    echo "   Les fonctionnalités liées à ces variables ne fonctionneront pas."
    echo ""
    read -p "Continuer quand même ? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Démarrer les services
echo "🐳 Démarrage des containers Docker..."
docker compose up -d

echo ""
echo "⏳ Attente de l'initialisation (30 secondes)..."
sleep 30

# Vérifier le statut
echo ""
echo "📊 Statut des services:"
docker compose ps

echo ""
echo "✅ Système démarré !"
echo ""
echo "🔗 URLs d'accès:"
echo "   n8n Interface: http://localhost:5678"
echo ""
echo "🔐 n8n Login:"
echo "   Première fois: Créez votre compte sur la page /setup"
echo "   Ensuite: Utilisez votre email/mot de passe personnel"
echo ""
echo "📝 Voir les logs: ./scripts/logs.sh [service]"
echo "📊 Voir le status: ./scripts/status.sh"
echo ""
