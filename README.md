# Thetis Gateway Extension — Full Featured

Extension **indépendante** qui transforme Pi en bot Discord et/ou WhatsApp avec des conversations isolées par canal, gestion des images, visibilité des actions en temps réel, et démarrage automatique au boot.

## Fonctionnalités

- **Conversations par canal** — chaque salon Discord / chat WhatsApp a son propre historique isolé, plus de collision entre utilisateurs
- **Images** — les images envoyées sur Discord ou WhatsApp sont transmises à Pi pour analyse ; les images générées par Pi sont renvoyées
- **Actions visibles en temps réel** — quand Pi exécute un outil (`bash`, `read`, `edit`, etc.), l'action et son résultat apparaissent immédiatement sur Discord/WhatsApp (comme dans le TUI)
- **Historique persistant** — l'historique de chaque canal est sauvegardé et restauré entre les sessions
- **File d'attente** — si Pi est occupé, les messages sont mis en file d'attente par canal sans perte
- **Priorité TUI** — dès que vous tapez dans le terminal Pi, les réponses restent dans le TUI
- **Démarrage au boot** — service systemd user pour lancer Pi + gateway automatiquement au démarrage du système

## Installation

```bash
# Copier dans les extensions globales de Pi
mkdir -p ~/.pi/agent/extensions
cp -r /chemin/vers/thetis-gateway ~/.pi/agent/extensions/

# Installer les dépendances Node
cd ~/.pi/agent/extensions/thetis-gateway
npm install
```

Puis relancer Pi ou faire `/reload`.

## Configuration rapide

### Interactive (recommandé)

Dans Pi :
```
/gateway setup
```
Wizard qui demande :
- Token du bot Discord (optionnel)
- Mode d'écoute Discord (`dm`, `mention`, `all`, `channels`)
- Activer WhatsApp (oui/non)
- Taille max de l'historique par canal (défaut 100)

La config est sauvegardée dans `~/.pi/agent/extensions/thetis-gateway/config.json`.

### Manuelle

Créer `~/.pi/agent/extensions/thetis-gateway/config.json` :

```json
{
  "autoStart": true,
  "maxHistoryPerThread": 100,
  "discord": {
    "enabled": true,
    "token": "YOUR_BOT_TOKEN",
    "mode": "mention",
    "allowedChannelIds": []
  },
  "whatsapp": {
    "enabled": true,
    "sessionName": "thetis-gateway"
  }
}
```

**Token Discord** — peut aussi être passé par la variable d'environnement `DISCORD_BOT_TOKEN`.

## Démarrage

### Manuel (dans Pi)

```
/gateway start          # Démarre tout
/gateway start discord  # Démarre Discord uniquement
/gateway start whatsapp # Démarre WhatsApp uniquement
```

Si `autoStart` est `true`, les gateways se connectent automatiquement au début de chaque session Pi.

### Automatique au boot (systemd)

```
/gateway-boot install   # Installer le service systemd user
/gateway-boot start     # Démarrer le service maintenant
/gateway-boot linger    # Activer le démarrage au boot (avant login)
```

**Principe** : le service lance Pi en mode **RPC** (`pi --mode rpc`) en arrière-plan. Le gateway démarre automatiquement grâce à `autoStart`. Discord et WhatsApp peuvent alors interagir avec Pi sans terminal ouvert.

#### Commandes de gestion du boot

| Commande | Description |
|----------|-------------|
| `/gateway-boot install` | Installe et active le service systemd user |
| `/gateway-boot remove` | Supprime le service |
| `/gateway-boot start` | Démarre le service |
| `/gateway-boot stop` | Arrête le service |
| `/gateway-boot status` | État du service (journal systemd) |
| `/gateway-boot linger` | Active le démarrage au boot (loginctl) |

#### Manuellement (sans Pi)

```bash
# Installer le service
~/.pi/agent/extensions/thetis-gateway/scripts/install-boot.sh install

# Démarrer au boot même avant login
loginctl enable-linger $USER

# Démarrer maintenant
systemctl --user start thetis-gateway

# Voir les logs
journalctl --user -u thetis-gateway -f
```

#### Fichiers du service

- **Service** : `~/.config/systemd/user/thetis-gateway.service`
- **Wrapper** : `~/.pi/agent/extensions/thetis-gateway/scripts/pi-rpc-wrapper.sh`
- **Logs** : `journalctl --user -u thetis-gateway`

## WhatsApp — Authentification

Au premier démarrage, un **QR code** s'affiche dans le terminal. Scannez-le avec l'application WhatsApp de votre téléphone (**Appareils liés → Lier un appareil**). Les credentials sont sauvegardés localement ; vous ne devrez le refaire qu'en cas de déconnexion forcée.

En mode **boot/RPC**, le QR code apparaît dans les logs systemd :
```bash
journalctl --user -u thetis-gateway -f
```

## Modes Discord

| Mode | Description |
|------|-------------|
| `dm` | Répond uniquement en message privé |
| `mention` | Répond quand le bot est mentionné |
| `all` | Répond dans tous les salons accessibles |
| `channels` | Répond uniquement dans les `allowedChannelIds` |

## Commandes

### Commandes disponibles partout (TUI + Discord + WhatsApp)

Ces commandes fonctionnent depuis le terminal Pi **et** depuis Discord/WhatsApp. Le résultat est renvoyé sur la plateforme d'où vient la commande.

| Commande | Description | Gateway |
|----------|-------------|---------|
| `/gateway status` | État des connexions et threads | ✅ |
| `/gateway threads` | Lister les conversations actives | ✅ |
| `/gateway clear [id]` | Vider l'historique d'un canal | ✅ |
| `/gateway start [discord\|whatsapp]` | Démarrer les gateways | ✅ |
| `/gateway stop [discord\|whatsapp]` | Arrêter les gateways | ✅ |
| `/gateway-boot start` | Démarrer le service systemd | ✅ |
| `/gateway-boot stop` | Arrêter le service systemd | ✅ |
| `/gateway-boot status` | Voir l'état du service | ✅ |

### Commandes TUI uniquement

Ces commandes nécessitent une interaction (prompts) et ne fonctionnent que depuis le terminal Pi :

| Commande | Description | Gateway |
|----------|-------------|---------|
| `/gateway setup` | Wizard de configuration interactive | ❌ |
| `/gateway-boot install` | Installer le service systemd | ❌ |
| `/gateway-boot remove` | Supprimer le service | ❌ |
| `/gateway-boot linger` | Activer le démarrage au boot | ❌ |

Depuis Discord/WhatsApp, vous recevrez un message indiquant comment exécuter la commande en terminal.

## Comportement détaillé

### Actions en temps réel (comme le TUI)

Quand Pi exécute un outil, vous le voyez immédiatement :

```
🔧 bash
```
cd /home/ubuntu/thetis && ls -la
```

✅ bash result:
total 8
drwxrwxr-x  2 ubuntu ubuntu 4096 Jul  8 19:15 .
```

Cela fonctionne pour **tous les outils** : `read`, `write`, `edit`, `bash`, `memory`, `learn_wizard`, etc.

### Fichiers & Images

- **Discord → Pi** : toutes les pièces jointes sont envoyées à Pi
  - Images → analyse visuelle (URL envoyée au modèle)
  - Fichiers texte (< 500 KB) → contenu téléchargé et inclus dans le message
  - Autres fichiers → mentionnés avec leur nom, type et taille
- **WhatsApp → Pi** : tous les médias (images, vidéos, documents) sont téléchargés
  - Images → analyse visuelle (base64)
  - Documents texte → contenu inclus dans le message
  - Autres fichiers → mentionnés avec leur type MIME
- **Pi → Discord** : images et fichiers créés par Pi (`write`, `edit`, images générées) envoyés comme pièces jointes
- **Pi → WhatsApp** : images envoyées via Baileys ; documents avec nom et type MIME

### Historique persistant

Chaque canal a son historique sauvegardé dans `~/.pi/agent/extensions/thetis-gateway/threads/` :
- `discord:#1234567890.json`
- `whatsapp:1234567890@s.whatsapp.net.json`

### File d'attente par canal

Si deux personnes écrivent en même temps dans deux canaux différents :
- Chaque canal a sa propre file d'attente
- Pi traite les messages dans l'ordre
- Les réponses sont renvoyées au bon canal

### Priorité TUI

Dès que vous écrivez dans le terminal Pi :
- `currentThreadId` passe à `null`
- Les réponses de l'assistant restent dans le TUI
- Les messages Discord/WhatsApp continuent d'être traités mais leurs réponses sont aussi affichées dans le TUI

## Intégration Thetis Memory

Si `thetis-memory` est installé, les outils `memory` et `learn_wizard` fonctionnent normalement à travers le gateway. Les résultats des outils sont relayés au canal actif comme n'importe quel autre outil.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  systemd user service (thetis-gateway.service)            │
│  ┌─────────────────────────────────────────────────┐    │
│  │  pi --mode rpc --no-session                     │    │
│  │  ┌─────────────────────────────────────────┐    │    │
│  │  │  thetis-gateway extension               │    │    │
│  │  │  ┌──────────┐  ┌──────────┐  ┌────────┐ │    │    │
│  │  │  │ Discord  │  │ WhatsApp │  │ Threads│ │    │    │
│  │  │  │ Client   │  │ Client   │  │ Manager│ │    │    │
│  │  │  └────┬─────┘  └────┬─────┘  └───┬────┘ │    │    │
│  │  │       │             │            │      │    │    │
│  │  │       └─────────────┴────────────┘      │    │    │
│  │  │              pi.sendUserMessage()        │    │    │
│  │  └─────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Autres commandes slash depuis les gateways

Les commandes Pi natives (`/learn`, `/skill:xxx`, `/model`, etc.) **ne sont pas interceptées** par le gateway. Quand vous les envoyez depuis Discord ou WhatsApp :
1. Le texte est transmis à Pi comme un message utilisateur normal
2. Pi traite la commande (expansion de skill, changement de modèle, etc.)
3. Si la commande génère une réponse de l'assistant → elle est relayée sur la plateforme
4. Si la commande est "silencieuse" (ex: `/model` sans confirmation texte) → vous ne verrez rien

En résumé : les commandes qui produisent du texte fonctionnent, celles qui modifient justement un état interne sans réponse texte sont invisibles depuis les gateways.

## Limites

- **WhatsApp vidéos/audio sortants** : non implémentés (Baileys nécessite un traitement spécifique)
- **Un seul agent actif** : Pi est monosession, donc les messages de tous les canaux partagent le même contexte agent (les threads servent uniquement à router les réponses)
- **RPC mode** : en mode boot sans client RPC, les notifications d'extension (`ctx.ui.notify`) sont perdues car personne n'est connecté pour les lire

## Dépendances

- [`discord.js`](https://discord.js.org/) — bot Discord
- [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) — client WhatsApp pure Node.js
- [`qrcode-terminal`](https://github.com/gtanner/qrcode-terminal) — affichage QR WhatsApp

## Fichiers

```
thetis-gateway/
├── index.ts              # Extension principale
├── package.json          # Dépendances
├── README.md             # Documentation
├── .env.example          # Variables d'environnement
├── systemd/
│   └── pi-gateway.service # Définition service systemd
├── scripts/
│   ├── pi-rpc-wrapper.sh  # Wrapper mode RPC
│   └── install-boot.sh    # Installation systemd
└── threads/              # Historique des conversations (auto)
```
