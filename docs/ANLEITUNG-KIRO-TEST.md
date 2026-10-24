# Anleitung: Die Extension in Kiro testen

Diese Anleitung ist für den ersten Test der Extension in Kiro. Ich (Claude) kann Kiro in meiner
Umgebung nicht starten. Deshalb brauche ich von dir ein paar Rückmeldungen. Wenn du alle Schritte
durchgehst, dauert das etwa 20–30 Minuten, davon ein paar Minuten Wartezeit beim ersten Download
des Container-Images.

Du musst nichts programmieren. Du brauchst:

- Kiro, installiert und lauffähig
- **Docker** (Docker Desktop unter Windows/macOS, Docker Engine unter Linux), gestartet
- Zugriff auf das GitHub-Repository `lldeters/DevPod` (zum Herunterladen der Extension)

---

## Schritt 1: Docker prüfen

Öffne ein Terminal (Windows: PowerShell, macOS/Linux: Terminal) und führe aus:

```sh
docker version
```

- **Gut:** Die Ausgabe hat zwei Abschnitte, `Client:` **und** `Server:`.
- **Schlecht:** Es erscheint nur `Client:` und eine Fehlermeldung wie _„Cannot connect to the Docker
  daemon“_. Dann ist Docker nicht gestartet. Starte Docker Desktop (oder unter Linux
  `sudo systemctl start docker`) und prüfe erneut.
- **Linux:** Wenn `permission denied` erscheint, muss dein Benutzer in die Gruppe `docker`
  (`sudo usermod -aG docker $USER`, danach ab- und wieder anmelden).

---

## Schritt 2: Die Extension herunterladen

Die Extension wird bei jedem Push automatisch gebaut. Du holst dir die fertige Datei so:

1. Öffne im Browser die Seite **Actions** des Repositories:
   <https://github.com/lldeters/DevPod/actions>
2. Klicke oben auf den **neuesten Lauf** (Name: _CI_, Branch
   `claude/kiro-dev-containers-extension-lo0h1y`, grüner Haken).
3. Scrolle auf der Seite nach unten bis zum Abschnitt **Artifacts** und klicke auf
   **`devcontainers-kiro-vsix`**. Es wird eine ZIP-Datei heruntergeladen.
4. Entpacke die ZIP-Datei. Darin liegt **`devcontainers-kiro.vsix`**. Merke dir den Speicherort.

> Alternative ohne GitHub-Download: Mit installiertem Node.js (Version 20 oder neuer) und Git:
> `git clone https://github.com/lldeters/DevPod`, dann im Ordner `npm ci`, `npm run build -- --production`
> und `npx vsce package`. Es entsteht ebenfalls eine `.vsix`-Datei.

---

## Schritt 3: Die Extension in Kiro installieren

1. Starte Kiro.
2. Öffne die Befehlspalette: **Strg+Umschalt+P** (macOS: **Cmd+Umschalt+P**).
3. Tippe `Install from VSIX` und wähle **„Extensions: Install from VSIX…“**.
4. Wähle die Datei `devcontainers-kiro.vsix` aus.
5. Wenn Kiro nach einem Neustart/Reload fragt, bestätige.

**Prüfen:** Öffne wieder die Befehlspalette und tippe `Kiro Dev Containers`. Es sollten mehrere
Befehle erscheinen (Reopen in Container, Show Diagnostics, …). Wenn keine erscheinen, ist die
Extension nicht installiert oder nicht aktiv. Dann kopiere bitte die Fehlermeldung (falls Kiro
eine zeigt) und schicke sie mir.

---

## Schritt 4: Remote-Unterstützung freischalten (einmalig)

Die Extension nutzt eine Schnittstelle von Kiro, die für Extensions standardmäßig gesperrt ist.
Du erlaubst sie einmal ausdrücklich.

1. Befehlspalette → **„Kiro Dev Containers: Enable Remote Support (proposed API)“**.
2. Es erscheint ein Fenster, das dir **genau sagt, welche Datei geändert wird** (eine
   `argv.json` in deinem Kiro-Ordner, vermutlich `~/.kiro/argv.json`) und was eingetragen wird.
   Klicke **„Update argv.json“**.
3. Klicke danach auf **„Quit Now“**, oder beende Kiro selbst **komplett**
   (macOS: **Cmd+Q**; nicht nur das Fenster schließen) und starte Kiro neu.

> **Falls das nicht klappt**, kannst du es von Hand machen: Befehlspalette →
> **„Preferences: Configure Runtime Arguments“**. Es öffnet sich die richtige `argv.json`.
> Füge dort innerhalb der geschweiften Klammern diese Zeile hinzu (mit Komma, falls davor schon
> etwas steht) und starte Kiro komplett neu:
>
> ```json
> "enable-proposed-api": ["lldeters.devcontainers-kiro"]
> ```

---

## Schritt 5: Diagnose kopieren (das ist die wichtigste Rückmeldung)

1. Befehlspalette → **„Kiro Dev Containers: Show Diagnostics (copy to clipboard)“**.
2. Es öffnet sich ein Tab mit einem JSON-Text. Der Inhalt liegt auch schon **in deiner
   Zwischenablage**.
3. **Füge den kompletten Text in deine Antwort an mich ein** (Strg+V / Cmd+V).

Der Text enthält: Kiro-Version, Betriebssystem, die Server-Informationen aus Kiros interner
Konfiguration (`product.json`), ob die Freischaltung aus Schritt 4 wirkt, sowie die Versionen von
Docker und der Dev-Container-CLI. Er enthält **keine Passwörter oder Schlüssel** (solche Einträge
werden herausgefiltert), und dein Benutzername im Pfad wird durch `~` ersetzt.

Worauf ich dort schaue:

| Feld                                       | Gut, wenn …                                             |
| ------------------------------------------ | ------------------------------------------------------- |
| `remoteSupport.enabled`                    | `true` (sonst steht der Grund in `problem`)             |
| `argvJson.listsThisExtension`              | `true`                                                  |
| `containerEngine.version`                  | eine Versionsnummer (kein `error`)                      |
| `devcontainerCli.version`                  | `0.89.0`                                                |
| `product.values.serverDownloadUrlTemplate` | vorhanden; **fehlt** es, brauche ich die anderen Felder |

---

## Schritt 6: Ein Testprojekt anlegen

Du brauchst einen Ordner mit einer Dev-Container-Konfiguration.

**macOS / Linux** (Terminal):

```sh
mkdir -p ~/kiro-devcontainer-test/.devcontainer
cat > ~/kiro-devcontainer-test/.devcontainer/devcontainer.json <<'EOF'
{
  "name": "Kiro Test",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "postCreateCommand": "echo created > /tmp/dck-marker"
}
EOF
```

**Windows** (PowerShell):

```powershell
mkdir $HOME\kiro-devcontainer-test\.devcontainer
Set-Content $HOME\kiro-devcontainer-test\.devcontainer\devcontainer.json '{ "name": "Kiro Test", "image": "mcr.microsoft.com/devcontainers/base:ubuntu", "postCreateCommand": "echo created > /tmp/dck-marker" }'
```

Öffne den Ordner `kiro-devcontainer-test` in Kiro (**Datei → Ordner öffnen…**).

**Wichtig: Dem Ordner vertrauen.** Kiro öffnet neue Ordner zuerst im **„Restricted Mode“**. Du
erkennst das am Banner oben („Restricted Mode is intended for safe code browsing. Trust this
folder to enable all features.“) und am Eintrag „Restricted Mode“ unten links. In diesem Modus ist
die Extension **absichtlich ausgeschaltet**: Ihre Befehle und Einstellungen sind unsichtbar, und
die Einstellungssuche nach `dev.containers` findet nichts. Das ist ein Schutz, weil ein Dev
Container Skripte aus dem Projekt ausführt.

1. Klicke im Banner auf **„Manage“**.
2. Bestätige, dass du dem Ordner vertraust (ein Button, der sinngemäß „Trust folder & enable all
   features“ heißt). Das ist dein eigener Testordner, du kannst ihm vertrauen. Bei fremden Projekten
   solltest du das nur tun, wenn du ihnen traust.
3. Danach sollte unten links „Restricted Mode“ verschwinden. Falls die Befehle oder Einstellungen
   nicht sofort erscheinen: Befehlspalette → **„Developer: Reload Window“**.

---

## Schritt 7: Im Container öffnen

1. _(Optional, nicht nötig für den ersten Versuch.)_ Stelle die Protokollstufe auf ausführlich,
   damit ich bei Problemen mehr sehe: **Einstellungen** (Strg+, / Cmd+,) → suche
   `dev.containers.logLevel` → wähle **`debug`**.
   Findest du die Einstellung nicht, ist die Extension in Kiro nicht installiert oder nicht
   aktiv (siehe die Tabelle am Ende). Übergehe den Schritt dann zunächst. Alternativ trägst du sie
   von Hand ein: Befehlspalette → **„Preferences: Open User Settings (JSON)“** und füge innerhalb der
   geschweiften Klammern `"dev.containers.logLevel": "debug"` ein (mit Komma, falls davor etwas steht).
2. Kiro zeigt unten rechts evtl. von selbst die Frage _„This folder contains a dev container
   configuration. Reopen it in a container?“_. Klicke **„Reopen in Container“**.
   Sonst: Befehlspalette → **„Kiro Dev Containers: Reopen in Container“**.
3. Es erscheint eine Fortschrittsanzeige. **Beim ersten Mal dauert das einige Minuten**, weil das
   Container-Image geladen wird. Du kannst die Anzeige mit „Cancel“ abbrechen.

### Was dann passieren kann

**A) Fehlermeldung: „This IDE does not say where its remote server can be downloaded …“**
Das ist der **wahrscheinlichste erste Halt** und kein Fehler deinerseits. Es bedeutet: Kiro
nennt keine Adresse, von der der Server für den Container geladen werden kann. Schicke mir die
Diagnose aus Schritt 5, ich ermittle daraus die passende Adresse, und du trägst sie dann in der
Einstellung `dev.containers.serverDownloadUrlTemplate` ein (ich sage dir genau, was).

**B) Fehlermeldung mit „download failed“ und einer Adresse (z. B. 404)**
Die Adresse stimmt nicht oder der Server-Build existiert nicht. Schicke mir die Meldung samt
Adresse.

**C) Es klappt: Das Fenster verbindet sich neu, unten links steht „Dev Container: …“**
Super. Dann prüfe die Punkte in Schritt 8.

**D) Eine andere Fehlermeldung**
Kopiere sie wörtlich oder mache einen Screenshot (siehe Schritt 9).

---

## Schritt 8: Wenn es geklappt hat – bitte prüfen

Hake ab, was funktioniert, und schreibe mir, was nicht:

- [ ] Der Explorer zeigt dein Projekt (Ordner `.devcontainer`).
- [ ] Ein Terminal (**Terminal → Neues Terminal**) läuft im Container. Prüfe mit
      `cat /tmp/dck-marker`, es sollte `created` ausgeben, und mit `whoami` (Benutzer `vscode`).
- [ ] Du kannst eine Datei anlegen und speichern.
- [ ] Eine Erweiterung lässt sich im Container installieren (Extensions-Ansicht).
- [ ] Eine **Kiro-Agent-Sitzung** (Chat/Specs) funktioniert im Container-Fenster.
- [ ] Befehlspalette → **„Kiro Dev Containers: Rebuild Container“** erstellt den Container neu
      und verbindet wieder.
- [ ] Klick auf **„Dev Container“** unten links → **„Reopen Folder Locally“** bringt dich zurück.

---

## Schritt 9: Was du mir schicken sollst

Bitte schicke mir **in dieser Reihenfolge**:

1. **Die Diagnose** aus Schritt 5 (komplett eingefügt).
2. **Was bei Schritt 7 passiert ist**: A, B, C oder D, bei Fehlern die **genaue Meldung** (Text
   oder Screenshot).
3. **Das Protokoll** (nur wenn etwas nicht geklappt hat): Menü **Ansicht → Ausgabe**, oben rechts
   im Dropdown **„Kiro Dev Containers“** wählen, Text markieren (Strg+A / Cmd+A), kopieren und
   einfügen. Es kann lokale Ordnernamen enthalten; ersetze sie, wenn du sie nicht teilen willst.
4. Die abgehakte Liste aus Schritt 8 (falls es geklappt hat).

---

## Schritt 10: Neue Funktionen testen – Extensions, Einstellungen und Ports

Dieser Schritt gilt für den **neueren Build** der Extension. Er kann Extensions und Einstellungen
aus der `devcontainer.json` im Container anwenden und Ports an deinen Rechner weiterleiten.

### 10a: Neue Version installieren

1. Hole dir auf <https://github.com/lldeters/DevPod/actions> aus dem **neuesten grünen Lauf** das
   Artefakt `devcontainers-kiro-vsix` (wie in Schritt 2) und entpacke es.
2. Befehlspalette → **„Extensions: Install from VSIX…“** → die neue Datei wählen. Die alte Version
   wird ersetzt. Danach **Kiro neu laden** (Befehlspalette → „Developer: Reload Window“).
   Die Freischaltung aus Schritt 4 bleibt bestehen.

### 10b: Neues Testprojekt

Lege einen **zweiten** Ordner an, damit nichts vom ersten Test hineinspielt.

**macOS / Linux:**

```sh
mkdir -p ~/kiro-devcontainer-test2/.devcontainer
cat > ~/kiro-devcontainer-test2/.devcontainer/devcontainer.json <<'EOF'
{
  "name": "Kiro Test 2",
  "image": "mcr.microsoft.com/devcontainers/javascript-node:22",
  "forwardPorts": [3000],
  "portsAttributes": { "3000": { "label": "Test-App", "onAutoForward": "notify" } },
  "customizations": {
    "vscode": {
      "extensions": ["esbenp.prettier-vscode"],
      "settings": { "editor.tabSize": 3 }
    }
  }
}
EOF
```

**Windows (PowerShell):**

```powershell
mkdir $HOME\kiro-devcontainer-test2\.devcontainer
Set-Content $HOME\kiro-devcontainer-test2\.devcontainer\devcontainer.json '{ "name": "Kiro Test 2", "image": "mcr.microsoft.com/devcontainers/javascript-node:22", "forwardPorts": [3000], "portsAttributes": { "3000": { "label": "Test-App", "onAutoForward": "notify" } }, "customizations": { "vscode": { "extensions": ["esbenp.prettier-vscode"], "settings": { "editor.tabSize": 3 } } } }'
```

Öffne den Ordner `kiro-devcontainer-test2` in Kiro, **vertraue ihm** (Schritt 6) und wähle
**„Reopen in Container“**. Der erste Start lädt ein neues Image (einige Minuten).

### 10c: Prüfen

- [ ] **Extension:** Öffne die Extensions-Ansicht (Strg/Cmd+Umschalt+X). Im Container-Fenster
      steht im Abschnitt für den Container (**„Dev Container“**) die Erweiterung
      **„Prettier – Code formatter“**, evtl. erst nach etwa einer halben Minute.
- [ ] **Einstellung:** Öffne eine neue leere Datei (Strg/Cmd+N). Unten rechts in der Statusleiste
      sollte **„Spaces: 3“** stehen. Alternativ: Einstellungen (Strg/Cmd+,) → Tab **„Remote
      [Dev Container …]“** → `editor.tabSize` ist **3**.
- [ ] **Port aus `forwardPorts`:** Öffne das Panel **Ports** (Befehlspalette → „Ports: Focus on
      Ports View“). Dort steht Port **3000** mit dem Namen **„Test-App“** und der Adresse
      `localhost:3000`.
- [ ] **Der Port funktioniert:** Starte im Terminal des Container-Fensters:
      `node -e "require('http').createServer((q,r)=>r.end('Hallo aus dem Container')).listen(3000)"`
      Öffne dann **im Browser auf deinem Rechner** <http://localhost:3000>. Es sollte
      **„Hallo aus dem Container“** erscheinen. Beende den Server mit Strg+C.
- [ ] **Automatische Erkennung:** Starte einen Server auf einem Port, der **nicht** in der
      Konfiguration steht:
      `node -e "require('http').createServer((q,r)=>r.end('Port 4000')).listen(4000)"`
      Im Ports-Panel sollte **4000** von selbst auftauchen (evtl. mit Hinweis). Dann
      <http://localhost:4000> im Browser öffnen.

Im Protokoll (Ansicht → Ausgabe → „Kiro Dev Containers“) sollten Zeilen stehen wie
`Extensions for the container: esbenp.prettier-vscode` und
`Forwarding localhost:3000 in the container to localhost:3000`.

### 10d: Was ich von dir brauche

Hake die Punkte aus 10c ab und schreib mir bei jedem, der nicht klappt, **was du siehst**. Das
Protokoll ist hier besonders hilfreich. Wenn die Extension nicht erscheint, ist das wichtig zu
wissen: Dann prüfe ich, ob Kiros Server den Startparameter akzeptiert.

---

## Entscheidung: Name und Publisher (kann warten)

Für den Test musst du **nichts** entscheiden. Später, wenn die Extension auf Open VSX
veröffentlicht werden soll, brauchst du:

- **Anzeigename**: aktuell _„Dev Containers for Kiro (Community)“_
- **Extension-ID**: aktuell `devcontainers-kiro`
- **Publisher**: aktuell `lldeters` (dein GitHub-Name, als Platzhalter). Auf Open VSX ist das ein
  Namespace, den du dort mit einem Konto anlegen und beanspruchen müsstest.

Wenn du andere Werte willst, sag mir einfach, welche. Ich benenne dann alles um. Beachte: Ändert
sich die Extension-ID, muss Schritt 4 danach einmal wiederholt werden.

Den Namen „Dev Containers“ allein sollten wir nicht verwenden, weil er die Microsoft-Extension
bezeichnet. Der Zusatz _Community_ und der Hinweis „nicht verbunden mit Microsoft oder Amazon“
bleiben deshalb drin.

---

## Wenn etwas hakt – schnelle Hilfe

| Problem                                                                               | Was tun                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keine „Kiro Dev Containers“-Befehle, oder die Einstellungen `dev.containers.*` fehlen | Extensions-Ansicht (Strg/Cmd+Umschalt+X) → _Installed_: Ist „Dev Containers for Kiro (Community)“ aufgeführt und **nicht** deaktiviert? Läuft Kiro im „Restricted Mode“ (Ordner nicht als vertrauenswürdig eingestuft), vertraue dem Ordner (Befehl „Workspaces: Manage Workspace Trust“): Die Extension läuft aus Sicherheitsgründen nicht in nicht vertrauenswürdigen Ordnern. Danach Kiro neu laden. Ist sie gar nicht aufgeführt, wiederhole Schritt 3 |
| „Remote support is not enabled“                                                       | Schritt 4 wiederholen und Kiro **komplett** beenden und neu starten                                                                                                                                                                                                                                                                                                                                                                                        |
| „Could not run docker“ / „service is not reachable“                                   | Docker starten (Schritt 1)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sehr lange Wartezeit bei „Starting Dev Container“                                     | Beim ersten Mal normal (Image-Download). Nach ~10 Min ohne Fortschritt: Protokoll schicken                                                                                                                                                                                                                                                                                                                                                                 |
| Kiro friert beim Neustart ein                                                         | Task-Manager/Aktivitätsanzeige: alle Kiro-Prozesse beenden, neu starten                                                                                                                                                                                                                                                                                                                                                                                    |

Wenn du bei einem Schritt nicht weiterkommst, schreib mir einfach, **bei welchem Schritt** du bist
und was du siehst. Ein Screenshot hilft meistens am meisten.
