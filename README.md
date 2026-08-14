# LANVIA

> **Your files. Your network. Nowhere else.**

LANVIA est une application peer-to-peer locale composée de deux clients qui implémentent **le même protocole** :

* **LANVIA Desktop** — Electron, TypeScript strict, React et Vite, Windows 10/11 en priorité ;
* **LANVIA Mobile** — Flutter/Dart null-safe, Android 10+.

Il n'existe ni serveur LANVIA distant, ni compte, ni relais Internet. Chaque installation héberge elle-même les services de découverte, de contrôle et de transfert.

## Source de vérité du protocole

`protocol/lanvia-protocol.json` est la source machine-readable. `protocol/protocol.md` est la spécification normative. Le générateur :

```bash
node scripts/generate-protocol.mjs
```

produit :

* `desktop/src/shared/constants/protocol.generated.ts`
* `mobile/lib/core/constants/protocol_generated.dart`

Les constantes générées portent le SHA-256 du fichier source. Les tests vérifient ce hash : modifier un port seulement dans un client ne peut donc pas passer silencieusement.

| Rôle | Transport | Port par défaut |
|---|---|---:|
| Contrôle | WebSocket | **53211** |
| Transfert binaire | HTTP | **53212** |
| Discovery fallback | UDP | **53213** |

Service mDNS/DNS-SD : **`_lanvia._tcp`**.

## Architecture

```text
                         même LAN / hotspot
  ┌───────────────────────────────────────────────────────────┐
  │                                                           │
  │  Desktop peer                              Android peer   │
  │  ├─ mDNS browser/advertiser   <------>      NsdManager    │
  │  ├─ UDP :53213                <------>      RawDatagram   │
  │  ├─ WS server+client :53211   <------>      WebSocket     │
  │  └─ HTTP server+client :53212 <------>      HttpServer    │
  │                                                           │
  └───────────────────────────────────────────────────────────┘
```

Le WebSocket ne transporte que les enveloppes JSON de contrôle : hello, pairing, texte, négociation/progression de transfert, pause/reprise, erreurs et ping/pong. Les octets d'un fichier passent par HTTP local. Le destinataire lance le GET après acceptation ; la reprise utilise `Range`/`206`.

Voir [docs/architecture.md](docs/architecture.md) pour les flux Discovery, WebSocket, pairing, transfert, les modèles de données, les stratégies Android/Electron et les phases de test.

## Fonctionnalités implémentées

* identité UUID persistante et nom modifiable ;
* mDNS + vrai broadcast UDP dirigé/global + réponse UDP unicast ;
* connexion manuelle IP/port ;
* serveur et client WebSocket sur chaque appareil ;
* déduplication des sockets, ping/pong et reconnexion 1/2/4/8/16 s ;
* pairing confirmé localement, trusted devices, suppression et blocage ;
* messages persistants avec états `sending/sent/delivered/failed` ;
* transfert HTTP après acceptation, capacité aléatoire, progression, vitesse et ETA ;
* SHA-256 avant envoi et après réception ;
* pause/reprise par Range, annulation et fichier `.lanvia.part` ;
* fallback de port de transfert annoncé (`53212` occupé → port réel propagé à UDP/mDNS/WS) ;
* chat enrichi commun (`**gras**`, `*italique*`, `__souligné__`, `~~barré~~`, `` `code` ``), copie et défilement automatique ;
* noms de fichiers neutralisés, destination contrainte et aucun lancement automatique ;
* historique local sans enregistrer les octets de fichier en base ;
* UI dark-first violette, cartes média/fichier, drag & drop Desktop ;
* notifications Android, actions Accept/Reject et foreground service pendant l'arrière-plan/transfert ;
* tray Desktop, thème, dossier, ports et options de démarrage ;
* diagnostics IP/interface/broadcast/ports/mDNS/UDP/WS/devices et logs expurgés.

## Arborescence

```text
LANVIA/
├── protocol/
│   ├── lanvia-protocol.json
│   ├── protocol.md
│   └── examples/
├── docs/architecture.md
├── scripts/generate-protocol.mjs
├── desktop/
│   ├── package.json
│   ├── src/main/          # sockets, fichiers, store, crypto, tray
│   ├── src/preload/       # API contextBridge allow-listée
│   ├── src/renderer/      # React uniquement
│   ├── src/shared/
│   └── tests/
├── mobile/
│   ├── pubspec.yaml
│   ├── lib/
│   ├── android/           # NsdManager + interface/broadcast + service
│   └── test/
└── integration-tests/desktop-android.md
```

## Prérequis

### Desktop

* Node.js 20+
* npm 10+
* Windows 10/11 pour le packaging et le test cible

### Android

* Flutter stable avec Dart 3.4+
* Android SDK 35
* JDK 17 pour Android Gradle Plugin 8.7
* appareil Android 10+ avec USB debugging pour le développement

## Développement Desktop

```bash
cd desktop
npm install
npm run dev
```

Autres commandes :

```bash
npm test             # Vitest, y compris deux peers WS et HTTP Range
npm run typecheck    # main/preload/renderer TypeScript strict
npm run build        # bundles Electron/Vite
npm run start        # preview du build
npm run package:win  # installeur NSIS dans desktop/release/
```

Au premier lancement Windows, accepter LANVIA uniquement sur les **réseaux privés** si Windows Firewall le demande. LANVIA n'éteint jamais le firewall.

## Développement Android

```bash
cd mobile
flutter pub get
flutter analyze
flutter test
flutter run
```

APK :

```bash
flutter build apk --release
```

Le projet fourni produit un APK de développement installable avec la configuration de signature locale Flutter. Pour une distribution, créer une keystore de production, conserver ses secrets hors du dépôt et remplacer la signature de debug dans `android/app/build.gradle`.

### Stockage Android

Le dossier par défaut est `LANVIA` sous l'espace externe propre à l'application (`getExternalStorageDirectory`). Cela fonctionne sous Android 10+ sans permission globale de stockage. LANVIA ne demande ni `MANAGE_EXTERNAL_STORAGE`, ni les anciennes permissions READ/WRITE. L'ouverture d'un fichier terminé reste une action explicite de l'utilisateur.

### Intégration Android native

`MainActivity.kt` fournit deux ponts strictement locaux :

* `NsdManager` pour annoncer/résoudre `_lanvia._tcp` ;
* énumération réelle des interfaces IPv4 et adresses broadcast.

`LanviaTransferService.kt` garde le processus disponible lorsque l'application passe en arrière-plan ou qu'un transfert accepté est actif. La notification foreground est visible ; elle n'est pas utilisée comme service caché permanent.

## Flux utilisateur

1. Ouvrir LANVIA sur les deux appareils.
2. Attendre `Available` ou utiliser **Connect manually**.
3. Ouvrir le device, cliquer **Connect** puis **Pair**.
4. Accepter sur l'autre appareil.
5. Envoyer `Hello from LANVIA`.
6. Utiliser `+`, un picker ou le drag & drop Desktop.
7. Accepter le fichier sur le destinataire.
8. Observer progression, vitesse et ETA ; le destinataire vérifie le SHA-256 avant de renommer le `.part`.

## Discovery et hotspots

LANVIA tente les deux voies simultanément : mDNS et UDP. Il ne suppose jamais que le multicast fonctionne.

### Même Wi-Fi

Les deux appareils doivent avoir des IP dans un réseau permettant la communication client-à-client. Certains Wi-Fi invités activent l'AP isolation : utiliser un réseau privé ou un hotspot contrôlé.

### Hotspot Android

Le téléphone hôte et le PC peuvent communiquer si le constructeur n'isole pas les clients. Le broadcast dirigé et global est envoyé. Si le hotspot filtre tout broadcast, relever l'IP dans **Network diagnostics** et utiliser **Connect manually**.

### Hotspot Windows

Vérifier le profil réseau privé, l'IP de l'interface hotspot et l'autorisation Windows Firewall. La connexion manuelle reste disponible.

## Diagnostics

L'écran **Network diagnostics** expose :

* IP locale, interface, masque/préfixe et broadcast ;
* bind Control/Transfer/Discovery et port réel ;
* statut `_lanvia._tcp` ;
* statut UDP broadcast ;
* nombre de WebSockets et appareils visibles ;
* erreurs de bind, permissions et indices firewall.

Exemples de logs :

```text
[DISCOVERY] UDP fallback listening on 0.0.0.0:53213
[DISCOVERY] Device found: Kevin Phone at 192.168.43.1:53211 via udp
[WS] Connected to Kevin Phone (trusted)
[TRANSFER] Transfer request sent: video.mp4 (125000000 bytes)
```

Les tokens de confiance/transfert, le contenu des messages et le contenu des fichiers ne sont pas loggés.

## Dépannage

### `Port unavailable`

Un autre processus utilise le listener. Fermer l'autre instance, choisir des ports valides dans Settings puis redémarrer LANVIA. Les ports réels choisis sont annoncés ; le peer n'utilise jamais ses propres ports comme hypothèse distante.

Windows :

```powershell
Get-NetTCPConnection -LocalPort 53211,53212 -ErrorAction SilentlyContinue
Get-NetUDPEndpoint -LocalPort 53213 -ErrorAction SilentlyContinue
```

### Aucun appareil

1. comparer les IP et préfixes dans Diagnostics ;
2. confirmer que les appareils sont sur le même Wi-Fi/hotspot ;
3. vérifier UDP 53213 et mDNS ;
4. vérifier l'isolation des clients du routeur ;
5. autoriser LANVIA sur réseau privé dans Windows Firewall ;
6. tester l'IP avec **Connect manually**.

### WebSocket refusé

Confirmer que Control est `running`, que l'adresse utilisée est celle du LAN et que le port annoncé est ouvert. Une découverte réussie ne prouve pas que TCP entrant est autorisé.

### Hash mismatch

Le `.lanvia.part` n'est pas publié comme fichier terminé. Relancer le transfert ; si l'erreur se répète, vérifier le stockage, les changements réseau et les logs des deux peers.

## Sécurité

Desktop applique `contextIsolation: true`, `nodeIntegration: false`, renderer sandboxé, CSP restrictive et preload minimal. Le renderer n'obtient aucun module Node ni canal IPC arbitraire. Les médias terminés passent par un protocole Electron contrôlé qui mappe uniquement un `transferId` connu.

Toutes les sources de fichier sont des fichiers réguliers validés. Les destinations utilisent un basename neutralisé et restent sous le dossier configuré. Un transfert exige un pairing, une acceptation et une capacité aléatoire expirante. Taille, état, destinataire, longueur et hash sont vérifiés.

**Limite v1 :** WS et HTTP sont en clair sur le LAN. Le token de pairing est un contrôle d'accès, pas une défense contre un attaquant capable de sniffer le réseau. Utiliser un LAN privé fiable. Une version future pourra négocier du chiffrement authentifié sans changer les états de transfert.

Audit npm runtime :

```bash
cd desktop
npm audit --omit=dev
```

## Tests

Desktop :

* protocole et golden packets ;
* identité ;
* packet UDP et calcul broadcast ;
* handshake réel Desktop ↔ Desktop ;
* HTTP capability, refus avant acceptation et Range 206 ;
* SHA-256, noms et confinement des chemins.

Mobile :

* hash de la source de protocole ;
* parsing/enveloppes et packet discovery ;
* identité persistante ;
* sérialisation message ;
* machine d'état transfert ;
* SHA-256 et noms sûrs.

Le test physique ordonné est dans [integration-tests/desktop-android.md](integration-tests/desktop-android.md). Il impose : discovery → WebSocket → pairing → texte → fichier, puis les cinq topologies demandées. Les lignes nécessitant un téléphone/Windows réel restent explicitement `NOT RUN` tant qu'elles n'ont pas été exécutées ; le projet ne présente pas un test simulé comme une preuve radio/firewall.

## Validation de cette copie

Dans l'environnement de construction de cette copie :

* `npm run typecheck` : réussi ;
* `npm test` : **6 fichiers / 12 tests réussis** ;
* `npm run build` : réussi, y compris preload sandbox CJS et renderer Vite ;
* audit npm des dépendances runtime : 0 vulnérabilité connue ;
* Flutter n'était pas installé : `flutter analyze`, `flutter test`, l'APK et la matrice physique doivent être exécutés avec le toolchain/appareils décrits ci-dessus.

Cette distinction est volontaire : un build Desktop vérifié ne remplace pas un essai Android/hotspot réel.
