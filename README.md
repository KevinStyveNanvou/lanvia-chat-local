## Utilisation

> **LANVIA a été développé à 100 % avec l'assistance d'une intelligence artificielle (IA).**
> Le projet est fourni avec une application Desktop pour Windows et une application mobile pour Android, implémentant le même protocole de communication local.

### Applications

Le projet contient deux applications :

* **Application mobile Android** : située dans le dossier `LANVIA-app-release-android-10-or-more.apk`
* **Application Desktop Windows** : située dans le dossier `LANVIA-Setup.exe`

Les versions compilées sont également disponibles dans les releases du projet lorsqu'elles sont publiées.

### Installation

#### Android

Installez l'APK LANVIA sur votre appareil Android.

L'application est compatible avec **Android 10 et versions ultérieures**.

#### Windows

Installez **LANVIA-Setup-1.0.1.exe** sur votre ordinateur Windows.

LANVIA Desktop cible principalement **Windows 10 et Windows 11**.

### Première utilisation

LANVIA fonctionne entièrement sur le réseau local. **Aucun compte, serveur distant ou connexion Internet n'est nécessaire pour échanger des messages ou des fichiers.**

Pour connecter deux appareils :

1. Ouvrez LANVIA sur les deux appareils.
2. Connectez les deux appareils au **même réseau Wi-Fi** ou au même hotspot.
3. Attendez que les appareils apparaissent automatiquement dans LANVIA.
4. Si l'appareil n'apparaît pas, utilisez **Connect manually** avec son adresse IP.
5. Ouvrez l'appareil détecté et sélectionnez **Connect**.
6. Sélectionnez ensuite **Pair**.
7. Acceptez la demande de pairing sur l'autre appareil.
8. Une fois les appareils associés, vous pouvez échanger des messages et transférer des fichiers.

### Exemple

```text
Téléphone Android
       │
       │
       │ même Wi-Fi / hotspot
       │
       ▼
Ordinateur Windows
```

Une fois les appareils connectés et associés, vous pouvez :

* envoyer des messages ;
* envoyer des fichiers ;
* suivre la progression des transferts ;
* mettre un transfert en pause et le reprendre ;
* annuler un transfert ;
* vérifier l'intégrité des fichiers avec SHA-256.

### Important

LANVIA est conçu pour fonctionner sur un **réseau local de confiance**.

La version actuelle utilise WebSocket et HTTP **en clair sur le réseau local**. Le pairing constitue un contrôle d'accès, mais ne protège pas contre un attaquant capable d'intercepter le trafic réseau.

Pour cette raison, utilisez de préférence un réseau Wi-Fi privé ou un hotspot contrôlé.

---

## Guide du développeur

LANVIA est un projet **peer-to-peer local** composé de deux clients qui doivent respecter le même protocole :

```text
LANVIA/
├── desktop/              # Application Windows - Electron/React/TypeScript
├── mobile/               # Application Android - Flutter/Dart
├── protocol/             # Source de vérité du protocole
├── docs/                 # Documentation technique
├── scripts/              # Scripts de génération
├── integration-tests/    # Tests d'intégration Desktop ↔ Android
└── README.md
```

### 1. Architecture générale

LANVIA ne possède pas de serveur central.

Chaque appareil fonctionne simultanément comme **client et serveur** pour les différents services :

```text
                    RÉSEAU LOCAL
                         │
        ┌────────────────┴────────────────┐
        │                                 │
        ▼                                 ▼
  LANVIA Desktop                    LANVIA Mobile
  Electron + React                  Flutter + Dart
        │                                 │
        ├── mDNS                         ├── NsdManager
        ├── UDP                          ├── UDP
        ├── WebSocket                   ├── WebSocket
        └── HTTP                        └── HTTP
```

Les ports par défaut sont :

| Service            | Protocole |    Port |
| ------------------ | --------- | ------: |
| Contrôle           | WebSocket | `53211` |
| Transfert          | HTTP      | `53212` |
| Discovery fallback | UDP       | `53213` |

Le service mDNS utilise :

```text
_lanvia._tcp
```

### 2. Source de vérité du protocole

**Ne modifiez pas indépendamment le protocole dans Desktop et Mobile.**

La source de vérité est :

```text
protocol/lanvia-protocol.json
```

La spécification lisible par un développeur est :

```text
protocol/protocol.md
```

Après modification du protocole, régénérez les constantes :

```bash
node scripts/generate-protocol.mjs
```

Cela produit automatiquement les fichiers utilisés par les deux clients :

```text
desktop/src/shared/constants/protocol.generated.ts
mobile/lib/core/constants/protocol_generated.dart
```

Cette architecture permet de maintenir Desktop et Android synchronisés.

### 3. Développement Desktop

Prérequis :

* Node.js 20+
* npm 10+
* Windows 10/11 pour les tests et le packaging

Installation :

```bash
cd desktop
npm install
```

Lancer en développement :

```bash
npm run dev
```

Tests :

```bash
npm test
```

Vérification TypeScript :

```bash
npm run typecheck
```

Build :

```bash
npm run build
```

Prévisualisation :

```bash
npm run start
```

Création de l'installateur Windows :

```bash
npm run package:win
```

L'installateur est généré dans :

```text
desktop/release/
```

### 4. Développement Android

Prérequis :

* Flutter stable
* Dart 3.4+
* Android SDK 35
* JDK 17
* Android 10+

Installation des dépendances :

```bash
cd mobile
flutter pub get
```

Analyse :

```bash
flutter analyze
```

Tests :

```bash
flutter test
```

Lancement sur un appareil :

```bash
flutter run
```

Génération de l'APK :

```bash
flutter build apk --release
```

L'APK généré peut ensuite être installé sur un appareil Android compatible.

### 5. Développement du protocole

Lorsqu'une fonctionnalité réseau est ajoutée, il faut vérifier les deux implémentations :

```text
Desktop
   ↕
Même protocole
   ↕
Android
```

Une modification du protocole doit être effectuée dans :

```text
protocol/lanvia-protocol.json
```

puis régénérée avec :

```bash
node scripts/generate-protocol.mjs
```

Il faut ensuite exécuter les tests correspondants sur Desktop et Mobile.

### 6. Organisation du code

#### Desktop

```text
desktop/src/
├── main/       # réseau, fichiers, store, crypto, tray
├── preload/    # API exposées au renderer
├── renderer/   # interface React
└── shared/     # constantes et éléments partagés
```

Le renderer React ne doit pas accéder directement aux API Node.js.

#### Mobile

```text
mobile/
├── lib/        # application Flutter
├── android/    # intégration Android native
└── test/       # tests
```

La couche Android native prend notamment en charge :

* `NsdManager` pour mDNS ;
* les interfaces réseau et adresses broadcast ;
* le service de transfert en arrière-plan.

### 7. Tests

Avant de considérer une modification comme terminée, exécutez au minimum les tests correspondant à la partie modifiée.

Desktop :

```bash
cd desktop
npm run typecheck
npm test
npm run build
```

Android :

```bash
cd mobile
flutter analyze
flutter test
```

Pour les tests réels Desktop ↔ Android, consultez :

```text
integration-tests/desktop-android.md
```

Le test physique doit notamment vérifier :

```text
Discovery
   ↓
WebSocket
   ↓
Pairing
   ↓
Message
   ↓
Transfert de fichier
   ↓
SHA-256
```

### 8. Règles importantes pour les contributeurs

* Ne modifiez pas directement les fichiers générés du protocole.
* Toute modification du protocole doit partir de `protocol/lanvia-protocol.json`.
* Testez les changements réseau sur les deux plateformes.
* Ne désactivez pas les protections de sécurité Electron.
* Ne loguez jamais les tokens, le contenu des messages ou le contenu des fichiers.
* Ne supposez jamais que mDNS fonctionne sur tous les réseaux.
* Conservez le fonctionnement en fallback UDP.
* Les fichiers transférés doivent rester confinés au dossier configuré.
* Ne lancez jamais automatiquement un fichier reçu.
* Vérifiez le SHA-256 après réception.

### 9. Dépannage réseau pendant le développement

Si aucun appareil n'est découvert :

1. Vérifiez que les deux appareils sont sur le même Wi-Fi ou hotspot.
2. Vérifiez leurs adresses IP.
3. Vérifiez que le réseau autorise la communication entre les clients.
4. Vérifiez mDNS.
5. Vérifiez le port UDP `53213`.
6. Vérifiez les ports WebSocket et HTTP.
7. Sur Windows, autorisez LANVIA sur les **réseaux privés** dans le pare-feu.
8. Essayez finalement **Connect manually** avec l'adresse IP du peer.

Sous Windows :

```powershell
Get-NetTCPConnection -LocalPort 53211,53212 -ErrorAction SilentlyContinue
Get-NetUDPEndpoint -LocalPort 53213 -ErrorAction SilentlyContinue
```

### 10. Philosophie du projet

LANVIA privilégie une architecture :

* **locale** ;
* **peer-to-peer** ;
* **sans serveur central** ;
* **sans compte utilisateur** ;
* **sans relais Internet** ;
* **cross-platform** ;
* basée sur un **protocole commun Desktop/Android**.

Toute nouvelle fonctionnalité réseau doit préserver cette philosophie et rester compatible avec les deux clients.
