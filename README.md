# Thetis Gateway Extension — Full Featured

Extension **indépendante** qui transforme Pi en bot Discord et/ou WhatsApp avec des conversations isolées par canal, gestion des images, visibilité des actions en temps réel, et démarrage automatique au boot.

## Fonctionnalités

- **Historique par canal** — chaque salon Discord / chat WhatsApp a son propre historique persistant pour le routage des réponses (voir "Limites" pour le partage du contexte LLM)
- **Images** — les images envoyées sur Discord ou WhatsApp sont transmises à Pi pour analyse ; les images générées par Pi sont renvoyées
- **Actions visibles en temps réel** — quand Pi exécute un outil (`bash`, `read`, `edit`, etc.), l'action et son résultat apparaissent immédiatement sur Discord/WhatsApp (comme dans le TUI)
- **Historique limité par canal** — chaque canal conserve ses N derniers messages (défaut : 100) en local, persistés entre les sessions. Les commandes `/new` et `/reset` vident l'historique du canal actif.
- **File d'attente** — si Pi est occupé, les messages sont mis en file d'attente par canal sans perte
- **Priorité TUI** — dès que vous tapez dans le terminal Pi, les réponses restent dans le TUI
- **Démarrage au boot** — deux services systemd user séparés (Discord et WhatsApp) pour lancer Pi + gateway automatiquement au démarrage du système
- **Questions interactives** — support natif du tool `gateway_question` avec boutons Discord et listes WhatsApp
- **Confirmation memory cross-extension** — quand `thetis-memory` demande une confirmation pour une action sensible (suppression, déplacement, réorganisation), le gateway affiche des boutons Discord ou un menu WhatsApp interactif

## Installation

```bash
# Installation via pi (recommandé)
pi install git:github.com/SubZzzzzz/thetis-gateway

# Ou temporairement pour tester
pi -e git:github.com/SubZzzzzz/thetis-gateway
```

Puis relancer Pi ou faire `/reload`.

### Installation manuelle (développement)

```bash
git clone https://github.com/SubZzzzzz/thetis-gateway.git ~/.pi/agent/git/github.com/SubZzzzzz/thetis-gateway
cd ~/.pi/agent/git/github.com/SubZzzzzz/thetis-gateway
npm install
```

## Configuration rapide

### Interactive (recommandé)

Dans Pi :
```
/gateway setup
```

Wizard qui demande :
- Token du bot Discord (optionnel — appuyer Entrée garde le précédent)
- **IDs utilisateurs Discord autorisés** (obligatoire si Discord activé)
- Activer WhatsApp (oui/non)
- **Numéros de téléphone WhatsApp autorisés** (obligatoire si WhatsApp activé)
- Nom de session WhatsApp (défaut: `thetis-gateway`)
- Taille max de l'historique par canal (défaut: `100`)

> 💡 **Conseil** : appuyez simplement sur **Entrée** pour conserver la valeur actuelle d'un champ.

La config est sauvegardée dans `~/.pi/agent/extensions-data/thetis-gateway/config.json`.

### Manuelle

Créer `~/.pi/agent/extensions-data/thetis-gateway/config.json` :

```json
{
  "autoStart": true,
  "discord": {
    "enabled": true,
    "token": "YOUR_BOT_TOKEN",
    "allowedUserIds": ["YOUR_DISCORD_USER_ID"]
  },
  "whatsapp": {
    "enabled": true,
    "sessionName": "thetis-gateway",
    "allowedPhoneNumbers": ["33612345678"]
  }
}
```

> **Sécurité obligatoire** : si une plateforme est activée (`enabled: true`), vous **devez** renseigner au moins un utilisateur autorisé. Sans cela, **aucun utilisateur** ne pourra interagir avec le bot sur cette plateforme.

**Token Discord** — peut aussi être passé par la variable d'environnement `DISCORD_BOT_TOKEN`.

**Permissions recommandées** (hygiène de base) :
```bash
chmod 700 ~/.pi/agent/extensions-data/thetis-gateway
chmod 600 ~/.pi/agent/extensions-data/thetis-gateway/config.json
```
Le fichier `config.json` contient le token en clair. Sur une machine mono-utilisateur ce n'est pas critique, mais c'est une bonne hygiène de restreindre sa lecture.

**Autorisation** :
- **Discord** : par `userId` (champ `allowedUserIds`). Trouvez votre ID dans Discord (Mode développeur → clic droit sur votre nom → Copier l'identifiant).
- **WhatsApp** : par numéro de téléphone international (champ `allowedPhoneNumbers`), ex: `33612345678` (sans le `+`).
- Si la liste est vide pour une plateforme activée, tous les messages sont silencieusement ignorés.

## Démarrage

Les gateways sont conçus pour tourner en arrière-plan via **deux services systemd séparés** (un pour Discord, un pour WhatsApp). Ils ne démarrent pas dans le TUI : utilisez `/gateway-boot` pour les contrôler.

### Architecture à deux services

Le système utilise deux services systemd indépendants pour isoler les contextes :

- **`thetis-gateway-discord.service`** — Gère uniquement Discord
- **`thetis-gateway-whatsapp.service`** — Gère uniquement WhatsApp

Chaque service lance sa propre instance Pi RPC avec un contexte agent isolé. Cela permet :
- Contextes conversationnels séparés (Discord et WhatsApp ne partagent pas d'historique)
- Contrôle indépendant (peut redémarrer l'un sans affecter l'autre)
- Meilleure gestion des ressources

Le choix du gateway à démarrer est contrôlé par la variable d'environnement `GATEWAY_PLATFORM` définie automatiquement par chaque service.

```
/gateway-boot install   # Installer les deux services systemd user
/gateway-boot start     # Démarrer les services activés dans config.json
/gateway-boot stop      # Arrêter les deux services
/gateway-boot status    # État des deux services (journal systemd)
/gateway-boot linger    # Activer le démarrage au boot (avant login)
```

**Principe** : les services lancent Pi en mode **RPC** (`pi --mode rpc`) en arrière-plan. Si `autoStart` est `true`, les gateways démarrent automatiquement à l'intérieur du service. Discord et WhatsApp peuvent alors interagir avec Pi sans terminal ouvert.

#### Commandes de gestion du boot

| Commande | Description |
|----------|-------------|
| `/gateway-boot install` | Installe et active les deux services systemd user |
| `/gateway-boot remove` | Supprime les deux services |
| `/gateway-boot start` | Démarre les services activés dans config.json (Discord et/ou WhatsApp selon la config) |
| `/gateway-boot stop` | Arrête les deux services |
| `/gateway-boot status` | État des deux services (journal systemd) |
| `/gateway-boot linger` | Active le démarrage au boot (loginctl) |

#### Manuellement (sans Pi)

```bash
# Installer les deux services
~/.pi/agent/git/github.com/SubZzzzzz/thetis-gateway/scripts/install-boot.sh install

# Démarrer au boot même avant login
loginctl enable-linger $USER

# Démarrer les services
systemctl --user start thetis-gateway-discord
systemctl --user start thetis-gateway-whatsapp

# Voir les logs
journalctl --user -u thetis-gateway-discord -f
journalctl --user -u thetis-gateway-whatsapp -f
```

#### Fichiers des services

- **Services** :
  - `~/.config/systemd/user/thetis-gateway-discord.service`
  - `~/.config/systemd/user/thetis-gateway-whatsapp.service`
- **Wrapper** : `~/.pi/agent/git/github.com/SubZzzzzz/thetis-gateway/scripts/pi-rpc-wrapper.sh`
- **Logs** :
  - Discord : `journalctl --user -u thetis-gateway-discord`
  - WhatsApp : `journalctl --user -u thetis-gateway-whatsapp`

## WhatsApp — Authentification

Au premier démarrage, un **QR code** s'affiche. L'emplacement dépend du mode de Pi :

| Mode | Emplacement du QR |
|------|-------------------|
| **TUI (interactif)** | **Widget au-dessus de l'éditeur** dans le TUI (intégré au render, jamais tronqué) + image PNG envoyée dans le canal actif (Discord/WhatsApp) |
| **RPC (systemd/boot)** | Logs systemd (stderr) + image PNG envoyée dans le canal actif |

Scannez-le avec l'application WhatsApp de votre téléphone (**Appareils liés → Lier un appareil**). Les credentials sont sauvegardés localement ; vous ne devrez le refaire qu'en cas de déconnexion forcée.

Pour suivre le QR en mode boot :
```bash
journalctl --user -u thetis-gateway-whatsapp -f
```

### Self-chat (un seul utilisateur, le owner)

Si le bot est lié à **votre propre compte WhatsApp** et que seul votre numéro est autorisé dans `allowedPhoneNumbers`, vous pouvez discuter avec le bot dans une conversation avec vous-même (« note à soi-même »). C'est le mode recommandé pour un assistant personnel auto-hébergé : personne d'autre ne peut interagir avec le bot.

**Comment ça marche** :
- Vous envoyez un message → le bot le reçoit, le traite, et vous répond dans la même conversation
- Le filtre `fromMe` (qui rejette normalement les messages émis par le compte lié) est levé pour permettre le self-chat
- La sécurité reste garantie par `isWhatsAppAuthorized` qui n'accepte que les JIDs des numéros présents dans `allowedPhoneNumbers`
- Les **echos** des réponses du bot (Baileys répercute chaque `sendMessage` sortant comme un événement `messages.upsert`) sont filtrés via un Set d'IDs récents (TTL 60s) pour éviter tout double-traitement

Si vous voulez **empêcher** le self-chat et n'accepter que les messages provenant d'autres numéros, gardez le `fromMe` filtre original en place : seul un contact autorisé (autre que vous) pourra déclencher le bot.

### Gestion du QR code et des credentials

Deux sous-commandes sont disponibles pour gérer le cycle de vie de l'authentification WhatsApp sans avoir à manipuler les fichiers à la main :

| Commande | Description |
|----------|-------------|
| `/gateway qr` | (Re)lance la connexion WhatsApp. Si des credentials valides existent, reconnexion automatique. Sinon, un QR code s'affiche dans le terminal **et** est envoyé comme image dans le canal actif (Discord/WhatsApp) pour pouvoir le scanner à distance. |
| `/gateway reset-whatsapp` (alias: `reset-wa`) | **Destructif** : supprime le dossier de credentials Baileys (`.baileys_auth_<sessionName>`) puis relance la connexion. Force l'affichage d'un nouveau QR. Utile après un *logged out*, pour relier un nouvel appareil, ou pour récupérer un état d'auth corrompu. |

> 💡 Les QR codes sont également **envoyés comme image** dans le canal actif (Discord/WhatsApp) en complément de l'affichage terminal — pratique quand Pi tourne en arrière-plan sur un serveur sans écran.

## Mode Discord

Le gateway Discord fonctionne **uniquement en messages privés (DM)**. Le bot n'écoute que les conversations privées 1-à-1 avec les utilisateurs autorisés. Aucun message de salon de serveur n'est traité.

## Commandes

### Commandes disponibles partout (TUI + Discord + WhatsApp)

Ces commandes fonctionnent depuis le terminal Pi **et** depuis Discord/WhatsApp. Le résultat est renvoyé sur la plateforme d'où vient la commande.

| Commande | Description | Gateway |
|----------|-------------|---------|
| `/gateway qr` | (Re)lancer la connexion WhatsApp et afficher un QR code | ✅ |
| `/gateway reset-whatsapp` | Supprimer les credentials WhatsApp et forcer un nouveau QR | ✅ |
| `/gateway-boot start` | Démarrer les services systemd activés | ✅ |
| `/gateway-boot stop` | Arrêter les services systemd | ✅ |
| `/gateway-boot status` | Voir l'état des services | ✅ |

### Commandes TUI uniquement

Ces commandes nécessitent une interaction (prompts) et ne fonctionnent que depuis le terminal Pi :

| Commande | Description | Gateway |
|----------|-------------|---------|
| `/gateway setup` | Wizard de configuration interactive | ❌ |
| `/gateway-boot install` | Installer les deux services systemd | ❌ |
| `/gateway-boot remove` | Supprimer les deux services | ❌ |
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

### Questions interactives (`gateway_question`)

Quand Pi pose une question avec des options prédéfinies :
- **Discord** : sondage avec boutons interactifs (max 25 options + bouton "Autres...")
- **WhatsApp** : message liste avec les options + "Autres..."

L'utilisateur sélectionne une option ou écrit une réponse personnalisée. La réponse est relayée immédiatement à Pi.

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

Chaque canal a son historique sauvegardé dans `~/.pi/agent/extensions-data/thetis-gateway/threads/` :
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

### Affichage du QR code dans le TUI

Le QR code WhatsApp s'affiche comme un **widget au-dessus de l'éditeur** dans le TUI. Le widget est implémenté comme un `Container` de pi-tui avec un `Text` par ligne (plutôt qu'un `string[]`) pour contourner la limite `MAX_WIDGET_LINES = 10` de `setWidget` qui tronquait les QR codes de plus de 10 lignes. Le widget est effacé automatiquement dès que la connexion est établie (`connection === "open"`) ou en cas de logged-out.

### Reconnexion automatique WhatsApp

Si la connexion WhatsApp tombe (réseau instable, serveur temporairement indisponible) :
- Le gateway retente jusqu'à **50 fois** avec un **backoff exponentiel** (5s, 15s, 45s… jusqu'à 5 min max entre chaque tentative)
- Au-delà, il passe en **erreur fatale** (visible avec `/gateway-boot status`)
- Pour réessayer : redémarre le service avec `/gateway-boot stop` puis `/gateway-boot start`, ou utilise `/gateway qr`
- En cas de **logged out** (session expirée ou déconnectée depuis le téléphone) : pas de retry automatique — utilisez `/gateway reset-whatsapp` pour effacer les credentials puis rescanner le QR (ou `/gateway qr` pour forcer un nouveau cycle de connexion si l'état d'auth est encore récupérable)

### Fallback intents Discord (MessageContent)

Discord requiert un "privileged intent" pour lire le contenu textuel des messages. Si tu ne l'as pas activé dans le [Developer Portal](https://discord.com/developers/applications) (Bot → Privileged Gateway Intents → Message Content Intent) :
- Le gateway détecte l'erreur `disallowed intents` et se reconnecte **sans cet intent**
- Le bot reste en ligne mais **ne peut plus lire le texte des messages** (seulement les embeds, attachments et métadonnées)
- Une notification s'affiche dans le TUI avec la marche à suivre
- Recommandé : active l'intent dans le portal puis redémarre le service avec `/gateway-boot stop` puis `/gateway-boot start`

## Intégration Thetis Memory

Si `thetis-memory` est installé :
- Les outils `memory` et `learn_wizard` fonctionnent normalement à travers le gateway
- Les résultats des outils sont relayés au canal actif comme n'importe quel autre outil
- **Les actions sensibles** (`memory/delete`, `memory/move`, `memory/reorganize`) déclenchent une confirmation interactive via le gateway : boutons Discord ou menu WhatsApp

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Deux services systemd séparés (contextes isolés)                    │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ thetis-gateway-discord.service                                │ │
│  │ ┌─────────────────────────────────────────────────────────┐   │ │
│  │ │ pi --mode rpc --name "gateway-discord"                  │   │ │
│  │ │ GATEWAY_PLATFORM=discord                                │   │ │
│  │ │ ┌────────────────────────────────────────────────────┐ │   │ │
│  │ │ │ thetis-gateway extension (Discord only)           │ │   │ │
│  │ │ │ ┌─────────┐  ┌─────────────────┐                 │ │   │ │
│  │ │ │ │ Discord │  │ Thread manager  │                 │ │   │ │
│  │ │ │ │ client  │  │ (per-channel)   │                 │ │   │ │
│  │ │ │ └─────────┘  └─────────────────┘                 │ │   │ │
│  │ │ └──────────────────────────────────────────────────┘ │   │ │
│  │ └─────────────────────────────────────────────────────────┘ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ thetis-gateway-whatsapp.service                               │ │
│  │ ┌─────────────────────────────────────────────────────────┐   │ │
│  │ │ pi --mode rpc --name "gateway-whatsapp"                 │   │ │
│  │ │ GATEWAY_PLATFORM=whatsapp                               │   │ │
│  │ │ ┌────────────────────────────────────────────────────┐ │   │ │
│  │ │ │ thetis-gateway extension (WhatsApp only)          │ │   │ │
│  │ │ │ ┌─────────┐  ┌─────────────────┐                 │ │   │ │
│  │ │ │ │WhatsApp │  │ Thread manager  │                 │ │   │ │
│  │ │ │ │ client  │  │ (per-channel)   │                 │ │   │ │
│  │ │ │ └─────────┘  └─────────────────┘                 │ │   │ │
│  │ │ └──────────────────────────────────────────────────┘ │   │ │
│  │ └─────────────────────────────────────────────────────────┘ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
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
- [`qrcode-terminal`](https://github.com/gtanner/qrcode-terminal) — affichage QR WhatsApp en terminal
- [`qrcode`](https://www.npmjs.com/package/qrcode) — génération de l'image PNG du QR envoyée dans le canal actif

## Fichiers

```
thetis-gateway/                          # Repo git (code uniquement)
├── index.ts              # Extension principale
├── package.json          # Dépendances
├── README.md             # Documentation
├── LICENSE               # Licence MIT
├── .gitignore            # Fichiers ignorés par Git
├── .env.example          # Variables d'environnement
├── systemd/
│   ├── pi-gateway-discord.service  # Service Discord
│   └── pi-gateway-whatsapp.service # Service WhatsApp
├── scripts/
│   ├── pi-rpc-wrapper.sh  # Wrapper mode RPC (accepte discord/whatsapp)
│   └── install-boot.sh    # Installation des deux services systemd
└── test-*.js / diagnose-*.js  # Scripts de debug

~/.pi/agent/extensions-data/thetis-gateway/   # Données persistantes (hors repo git)
├── config.json           # Configuration runtime
├── threads/              # Historique des conversations (auto, ignoré par Git)
├── files/                # Fichiers uploadés
└── .baileys_auth_<sessionName>/  # Credentials WhatsApp
```

> **Note** : les données persistantes (config, threads, auth WhatsApp) sont stockées dans `~/.pi/agent/extensions-data/thetis-gateway/` en dehors du repo git. Cela permet de survivre aux mises à jour via `pi update --extension` qui exécute `git clean -fdx`. Une migration automatique est effectuée au premier chargement si des données existent encore dans l'ancien emplacement.

## Licence

MIT — © Achille Robbe
