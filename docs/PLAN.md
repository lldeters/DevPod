# Plan: „Dev Containers“ als Kiro-IDE-Extension (Apache-2.0)

## Context

Kiro ist ein Code-OSS-Fork (zuletzt gemeldet: VS Code 1.103.x) und bezieht Extensions aus **Open VSX**. Microsofts `ms-vscode-remote.remote-containers` ist dort nicht verfügbar und lizenzrechtlich an offizielle VS-Code-Builds gebunden. Kiro hat bislang keine offizielle Remote-Unterstützung: WSL/SSH sind in `kirodotdev/Kiro#17` als Feature-Request offen, Nutzer behelfen sich mit `jeanp413/open-remote-*`.

Ziel: Eine saubere, vollständig offene Extension, die den Funktionsumfang von Dev Containers für Kiro bereitstellt. Das Repo `lldeters/devpod` ist aktuell leer (nur Apache-2.0-`LICENSE`, ein Initial-Commit), es gibt also keinen Bestandscode, an den man sich anpassen müsste.

### Rechtlicher Rahmen (bindend für die Umsetzung)

- Die Microsoft-Extension ist **proprietär und nicht im Quelltext verfügbar**. Ihre Lizenz verbietet Reverse Engineering. Ein 1:1-Nachbau per Dekompilieren des VSIX scheidet daher aus.
- Wir bauen **clean-room** gegen öffentliche Quellen: die Dev-Container-Spezifikation (`devcontainers/spec`, CC-BY-4.0/MIT), die Referenzimplementierung `@devcontainers/cli` (**MIT**, aktuell 0.89.0) und die öffentliche Funktionsbeschreibung.
- „Genau so“ heißt deshalb: **gleicher Funktionsumfang und gleiche UX-Konzepte, eigener Code**. Namen, Icons und Texte von Microsoft werden nicht übernommen. Name mit Zusatz „unofficial / community“. Das ist keine Rechtsberatung.
- MIT-Code (z. B. Muster aus `open-remote-ssh`, `dev-containers-oss`) darf mit Attribution in ein Apache-2.0-Projekt einfließen, die Quellen kommen dann in `NOTICE`. Die AGPL-Variante `open-remote-devcontainer` wird nicht angefasst.

### Bereits vorhandene offene Ansätze (zur Abgrenzung)

| Projekt                              | Lizenz   | Lücke                                                              |
| ------------------------------------ | -------- | ------------------------------------------------------------------ |
| `s-h-a-d-o-w/dev-containers-oss`     | MIT      | kleinerer Funktionsumfang, keine Config-Erzeugung, kein Kiro-Fokus |
| `MythreyaK/open-remote-devcontainer` | AGPL-3.0 | kein Compose, keine Features, keine benannten Configs              |
| `DDorch/codium-devcontainer`         | MIT      | SSH-basiert, schlanker Funktionsumfang                             |

Unser Mehrwert: Vollständigkeit (Compose, Features, Templates, Volumes, Credentials, …), saubere Architektur, Kiro-Spezifika, Tests.

## Entscheidungen (Empfehlung)

1. **Engine = `@devcontainers/cli`**, als gepinnte Abhängigkeit mitgeliefert (Override per Setting). Die Spec-Logik (Features, Merge, Lifecycle, Compose) wird nicht neu implementiert; das ist vollständiger und wartbarer als ein eigener Nachbau.
2. **Anbindung an Kiro über einen eigenen Remote-Authority-Resolver** (`vscode-remote://dev-container+…`). Das braucht Proposed APIs (`resolvers`, `contribViewsRemote`, `remoteIndicator`). Kiro muss die Extension dafür in `argv.json` unter `enable-proposed-api` freischalten (derselbe Weg wie bei `open-remote-wsl`). Ein Setup-Kommando richtet das mit Zustimmung ein und prüft die Kompatibilität.
3. **Schichten**: `core/` (reines TS, ohne `vscode`-Import, voll unit-testbar) → `remote/` (Resolver, Server-Installation, Tunnel) → `ui/` (Commands, Views, Quick Picks). Eine Engine-Abstraktion (Docker/Podman) hinter einem Interface.
4. **Tooling**: TypeScript strict, pnpm, esbuild, vitest, ESLint + Prettier, `@vscode/vsce` + `ovsx` zum Packen/Veröffentlichen, GitHub Actions. Sprache von Code und Doku: Englisch; UI-Strings über `vscode-nls`-ähnliche Bundles (en, de).
5. **Keine Telemetrie.**
6. **Kiro-Zusatz**: `customizations.kiro` (Extensions/Settings) wird zusätzlich zu `customizations.vscode` ausgewertet, mit definierter Priorität. Die `.kiro/`-Ordner (Specs, Steering, Hooks) liegen im Workspace und funktionieren ohne Sonderlogik.

## Größtes technisches Risiko: Server im Container (Phase 0, blockierend)

Der Resolver braucht im Container einen zu Kiro passenden Remote-Extension-Host-Server. Offen ist: Welche Server-Artefakte liefert Kiro (`~/.kiro-server` in Issue-Berichten deutet auf einen eigenen Datenordner hin), und wie bekommt man sie in den Container (Download-URL-Template aus Kiros `product.json`, Passung von `commit`/`quality`)? Fallback: ein zum Basisstand passender Code-OSS-REH-Build (wie VSCodium ihn liefert) mit `serverValidation: skip/force`. Das ist fragil und wird nur genutzt, falls Kiro nichts bereitstellt.

Ebenfalls zu klären: Laufen Kiros eingebaute Agent-Extensions (Specs, Steering, MCP, Hooks) im Remote-Extension-Host des Containers korrekt?

**Dafür brauche ich von dir** (kann ich in dieser Cloud-Umgebung nicht selbst ermitteln): den Inhalt der Kiro-`product.json` (Linux: unter `/usr/share/kiro/resources/app/product.json` bzw. dem Installationspfad; macOS: `Kiro.app/Contents/Resources/app/product.json`), die Kiro-Version, und ob `open-remote-ssh`/`open-remote-wsl` bei dir mit Kiro läuft.

## Funktionsumfang und Phasen

| Phase                     | Inhalt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 – Fundament & Spike** | Repo-Gerüst, CI, `NOTICE`/Third-Party-Lizenzen, Server-Spike (siehe oben), Proposed-API-Check gegen Kiros VS-Code-Basis                                                                                                                                                                                                                                                                                                                                                                           |
| **1 – MVP**               | `devcontainer.json`-Erkennung (alle Spec-Pfade, mehrere Configs wählbar), _Reopen in Container_, _Rebuild_ (mit/ohne Cache), _Reopen Locally_, image- und Dockerfile-Szenarien, Lifecycle-Hooks inkl. `waitFor`, `remoteUser`/`containerUser`/`updateRemoteUserUID`, `remoteEnv`/`containerEnv`/`userEnvProbe`, Container-Log, Docker **und** Podman, Fortschritts-UI                                                                                                                             |
| **2 – Kernfunktionen**    | Docker Compose (`dockerComposeFile`, `service`, `runServices`), Features (OCI/lokal/Tarball, Lockfile, `outdated`/`upgrade`), Templates + _Add Dev Container Configuration Files_, Features-Picker, Port-Forwarding (`forwardPorts`, `portsAttributes`, `otherPortsAttributes`), Extensions/Settings aus `customizations`, _Attach to Running Container_ inkl. Attached-Container-Configs, Remote-Indicator-Menü, Remote-Explorer-Ansicht, _Clean Up Dev Containers_                              |
| **3 – Parität**           | _Clone Repository in Container Volume_ (inkl. PR/Branch), benannte Volumes, Workspace-Dateien in Containern, Git-Config- und Credential-Helper-Weitergabe, SSH-/GPG-Agent-Weitergabe, Dotfiles, `mounts`/`workspaceMount`/`runArgs`/`capAdd`/`privileged`/`init`/`securityOpt`, `hostRequirements`, `secrets`, Remote-Docker-Host (Docker-Kontext, `ssh://`), WSL2-Docker, `devcontainer.json`-Editor-Support (Schema, Completion/Hover für Features), Open-in-Container-URL-Handler (`kiro://…`) |
| **4 – Politur & Release** | i18n (en/de), Walkthrough/Getting Started, Doku + Screenshots, Barrierefreiheit, Härtung (Eingabe-Escaping, Secrets in Logs), Packaging, Veröffentlichung auf Open VSX                                                                                                                                                                                                                                                                                                                            |

Settings-Namespace analog zum Original-Konzept (`dev.containers.*`, z. B. `dockerPath`, `dockerComposePath`, `dockerSocketPath`, `copyGitConfig`, `dotfiles.*`, `defaultExtensions`, `defaultFeatures`, `logLevel`), allerdings unter **eigener Extension-ID**, damit nichts mit Microsofts Extension kollidiert.

Bekannte Nicht-Ziele: Windows-Container, Codespaces-Anbindung, Funktionen, die zwingend Microsofts proprietären VS-Code-Server oder Marketplace-Dienste voraussetzen.

## Repo-Struktur (Ziel)

```
/LICENSE (vorhanden)  /NOTICE  /README.md  /CONTRIBUTING.md  /SECURITY.md
/package.json  /tsconfig.json  /esbuild.mjs  /vitest.config.ts
/src/core/        Config-Discovery, JSONC, Variablen, CLI-Wrapper, Engine-Interface (docker/podman)
/src/remote/      Resolver, Server-Installer, Tunnel/Exec, Port-Forwarding
/src/ui/          Commands, Views, Quick Picks, Statusanzeige, Setup (argv.json)
/src/credentials/ Git/SSH/GPG-Weitergabe, Dotfiles
/test/unit  /test/integration (echtes Docker, nur CI)  /test/fixtures
/docs/            PLAN.md (diese Planung), Architektur, Feature-Matrix, Manual-Test-Checkliste
/.github/workflows/  ci.yml, release.yml
```

## Verifikation

Einschränkung dieser Cloud-Umgebung: **kein Kiro, kein Docker-Daemon, `open-vsx.org` und mehrere Doku-Hosts sind per Proxy gesperrt.** Node 22, pnpm und npm-Zugriff sind vorhanden.

- **Hier (jederzeit):** Typecheck, Lint, vitest-Unit-Tests für `core/` (Config-Discovery, JSONC, Variablen-Substitution, CLI-Argumentbau, Engine-Mocks), Build und VSIX-Packaging.
- **GitHub Actions (echtes Docker):** Integrationstests der `core/`-Schicht gegen die gepinnte `@devcontainers/cli`-Version, u. a. image, Dockerfile, Compose, Features, Lifecycle-Reihenfolge.
- **Auf deinem Rechner mit Kiro (manuell):** Checkliste in `docs/`: Extension installieren, `enable-proposed-api` setzen, Beispielprojekt öffnen, _Reopen in Container_, Terminal/Debug/Agent im Container, Rebuild, Ports, Clone-in-Volume. Ergebnisse gibst du mir zurück, daraus entstehen Fixes.
- Ehrliche Aussage in jedem Zwischenstand, was getestet ist und was nicht. Die Kiro-Integration gilt erst nach deinem manuellen Test als verifiziert.

## Nach Freigabe

1. Phase 0 + 1 in dieser Session umsetzen (Gerüst, CI, `core/`, MVP-Resolver soweit ohne Kiro-Server prüfbar), auf Branch `claude/kiro-dev-containers-extension-lo0h1y` committen und pushen. Kein PR, außer du verlangst einen.
2. `docs/PLAN.md` mit diesem Plan ins Repo legen.
3. Phase 2–4 in getrennten Schritten, jeweils nach deinem Feedback aus dem Kiro-Test.

## Annahmen, die du beim Freigeben korrigieren kannst

- Arbeitsname: **„Dev Containers for Kiro (Community)“**, Extension-ID `devcontainers-kiro`, Publisher noch offen.
- Engine ist der mitgelieferte `@devcontainers/cli`, kein Eigenbau.
- Code und Doku Englisch, UI zweisprachig (en/de).
- Reihenfolge der Phasen wie oben; Phase 0 darf sich ändern, wenn die `product.json` etwas anderes zeigt.

---

## Umsetzungsstand und Abweichungen vom Plan (Phase 0 + 1)

Beim Umsetzen hat sich Folgendes gezeigt; der Plan wurde entsprechend angepasst:

- **`devcontainer stop` / `down` gibt es in `@devcontainers/cli` 0.89.0 nicht** (die README
  erwähnt sie, `--help` der installierten Version nicht). Stoppen und Löschen läuft später über die
  Container-Engine.
- **`read-configuration` braucht eine erreichbare Container-Engine** (es sucht per Label nach einem
  bestehenden Container). Für hermetische Tests dient ein Docker-Stub über `--docker-path`.
- **Der Workspace-Pfad im Container wird von der CLI bestimmt**, nicht selbst berechnet: Die CLI
  mountet die Git-Root, ein Unterordner landet z. B. unter `/workspaces/<repo>/<sub>`. Deshalb gibt
  es keine eigene Variablen-Substitution in `core/`.
- **npm statt pnpm**: robuster mit `vsce` und dem Mitpacken der CLI ins VSIX.
- **TypeScript 5.9 / ESLint 9 / Vitest 3** gepinnt; `latest` (TypeScript 7) wird von
  `typescript-eslint` noch nicht unterstützt.
- **Nicht umgesetzt (bewusst)**: `serverValidation`-Setting. Seine Semantik ist an VSCodium
  gebunden; es wird erst nach dem Server-Spike entschieden.
- **Weiterhin offen (Phase 0, blockierend)**: Verifikation gegen echtes Kiro – siehe
  `docs/TESTING.md` und die Liste der Annahmen in `docs/ARCHITECTURE.md`.
