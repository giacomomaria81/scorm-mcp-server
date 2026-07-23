# PASSATION — scorm-mcp-server

> Document de reprise. À lire en premier par toute nouvelle session (Cowork, Claude Code, etc.)
> qui reprend ce projet sans le contexte du chat d'origine.

## 1. Ce que c'est

Un **serveur MCP** qui convertit du **HTML autonome** (typiquement la sortie de Claude Design)
en **paquet SCORM 2004 4th Edition** (`.zip` / PIF), prêt à importer dans n'importe quel LMS.

Objectif métier : produire des contenus de formation (mobile-first, **100 % hors-ligne**) avec
un suivi de **complétion + progression**, sans dépendre d'un outil d'authoring propriétaire.

Principe central : **WRAP, don't rewrite.** Le HTML de l'auteur n'est jamais réécrit ; on se
contente (1) d'**inliner les assets** en data-URI pour l'offline, (2) d'**injecter un runtime**
qui parle à l'API du LMS, (3) de générer le **manifeste** + d'embarquer les **XSD ADL**.

## 2. État actuel (au moment de la passation)

**Fonctionnel et testé.** `npm test` est vert : **49 checks, 0 échec**.

| Suite | Checks | Ce qu'elle prouve |
|---|---|---|
| `test/converter.test.mjs` | 23 | Inlining offline complet (CSS, @import, srcset, styles inline, scripts, favicons, suppression preload/preconnect), DOCTYPE, jalons, **schemasBundled === 15** |
| `test/runtime.test.mjs` | 15 | Runtime exécuté (jsdom + mock API) : init, progression, complétion, reprise, `session_time` ISO 8601, découverte d'API, mode aperçu |
| `test/mcp.test.mjs` | 10 | Serveur MCP démarré via le SDK, outil `scorm_package` appelé de bout en bout, `.zip` écrit |
| `test/validate-schema.mjs` | 1 | **Conformité de schéma réelle** : `xmllint --schema imscp_v1p1.xsd` valide le manifeste |
| `test/scorm-again.test.mjs` *(bonus)* | 6 | SCO validé contre le **runtime strict scorm-again** : 0 erreur sur toutes les écritures du modèle de données |

**Validé aussi à la main** dans le lecteur navigateur (`scorm-test-harness.html`) :
100 % de progression, complétion `completed`, **25 appels API / 0 erreur**, cycle
`Initialize → SetValue → Commit → Terminate` correct, `suspend_data` qui accumule les jalons.

**✅ Validé en vrai LMS — SCORM Cloud, 21/06/2026.** Paquet importé sans erreur (reconnu *SCORM 2004 4th Ed.*, parser « your manifest looks great! »), lancé dans le sandbox, et suivi remonté au dashboard : **completion = complete, success = passed, temps suivi**. Le « dernier cran avant production » est franchi. **Re-validé en v1.3.0 le 18/07/2026** avec un module sans aucun appel forcé (5 jalons `view` + opt-in `data-scorm-success`) : **complete + passed produits par le runtime lui-même**.

Gotcha terrain : **écraser les fichiers d'un cours ne re-pointe pas une inscription existante** (elle rejoue l'ancien paquet) — pour re-tester un nouveau build, créer une **inscription neuve** (nouveau cours, ou *Reset Progress*).

## 3. Décisions d'architecture (à ne pas défaire sans raison)

- **SCORM 2004 4th Edition**, **un seul SCO**, **pas de sequencing.** (4th ed pour exposer le %
  via `cmi.progress_measure` ; 1.2 ne l'a pas.)
- **Jalons déclaratifs** : l'auteur marque des éléments avec `data-jalon="id"` +
  `data-trigger="view|click|ended"` (`view` par défaut, via IntersectionObserver). Le runtime
  calcule `progress_measure = jalons_atteints / total`, et `completion_status="completed"`
  quand tous sont atteints. Reprise via `cmi.suspend_data` + `cmi.location`.
  API programmatique : `window.SCORM2004.reach("id")`. Recommandé : 4–8 jalons / module.
- **Adaptateur côté contenu fait maison (classe pipwerks), PAS scorm-again.** Important :
  scorm-again est l'implémentation **côté LMS** de l'API (ce que le LMS expose). Le contenu qui
  part dans des LMS tiers a besoin d'un **chercheur d'API** robuste (remontée des frames jusqu'à
  500 + `opener` + `top`, tolérant au cross-origin). C'est ce qu'il y a dans `src/runtime.ts`.
  *scorm-again sert ici uniquement de **LMS de test** (harness + test bonus), pas dans le paquet.*
- **Manifeste minimal** : namespaces `imscp` + `adlcp` seulement (seul `adlcp:scormType` est
  étranger). On a volontairement retiré `adlseq`/`adlnav`/`imsss` (pas de sequencing) pour
  réduire la surface que `xmllint` doit charger.
- **XSD embarqués à la racine** (15 fichiers ADL) → `xsi:schemaLocation` résout en local,
  conformité offline. Le chemin des schémas est résolu **par rapport au module** (pas au cwd),
  donc ça marche quel que soit le dossier de lancement du serveur MCP.
- **Liens réseau supprimés** (`preload`/`modulepreload`/`prefetch`/`preconnect`/`dns-prefetch`) :
  inutiles dans un SCO offline, source de requêtes échouées.

## 4. Structure du projet

```
scorm-mcp-server/
├── src/
│   ├── index.ts        # serveur MCP (stdio), outil unique scorm_package
│   ├── converter.ts    # buildPackage(): inlining offline + manifeste + XSD + zip
│   └── runtime.ts       # SCORM_RUNTIME : adaptateur côté contenu + moteur de jalons (string JS)
├── dist/               # build compilé (tsc) — déjà présent
├── schemas/            # 15 XSD ADL SCORM 2004 4th Ed (embarqués dans chaque paquet)
├── test/
│   ├── converter.test.mjs      # contrat inlining + schemasBundled
│   ├── validate-schema.mjs     # conformité xmllint --schema
│   ├── runtime.test.mjs        # runtime contre mock API (jsdom)
│   ├── mcp.test.mjs            # serveur MCP de bout en bout (SDK client)
│   ├── scorm-again.test.mjs    # bonus : validation contre runtime strict scorm-again
│   ├── fixtures/               # module.html + a.css/b.css/dot.png/lib.js
│   └── sample-module.html
├── scorm-test-harness.html     # LECTEUR SCORM LOCAL (faux LMS navigateur, sans compte)
├── package.json
├── tsconfig.json
└── README.md
```

## 5. Build & test

```bash
npm install            # dépendances (cheerio, jszip, zod, @modelcontextprotocol/sdk ; dev: typescript, jsdom)
npm run build          # tsc -> dist/
npm test               # build + converter + runtime + mcp + validate-schema (49 checks)

# bonus (validation contre un vrai runtime strict) :
npm i -D scorm-again   # jsdom est déjà là
node test/scorm-again.test.mjs
```

Prérequis : **Node >= 20**, et **xmllint** disponible (`libxml2-utils`) pour `validate-schema.mjs`.

## 6. L'outil MCP : `scorm_package`

Entrées (zod, schéma strict) :
- `html` *(string)* **ou** `input_path` *(fichier .html sur disque)* — l'un des deux.
- `title` *(requis)* — titre du cours/manifeste.
- `language` — défaut `fr-FR`.
- `identifier` — défaut dérivé du titre.
- `base_url` — pour résoudre les chemins relatifs si le HTML vient du web.
- `output_dir` — défaut `~/scorm-packages`.

Sortie : `structuredContent` (chemin du .zip, nb de jalons, `schemas_bundled`, taille,
avertissements) + écriture du `.zip` sur disque.

Câblage Claude Desktop / Cowork (config MCP, exemple) :
```json
{
  "mcpServers": {
    "scorm": { "command": "node", "args": ["/CHEMIN/ABSOLU/scorm-mcp-server/dist/index.js"] }
  }
}
```

## 7. Comment tester un paquet (sans compte LMS)

1. Ouvrir `scorm-test-harness.html` via un petit serveur local
   (`python3 -m http.server 8000` puis `http://localhost:8000/scorm-test-harness.html`).
2. Y glisser un `.zip` généré.
3. Observer : progression %, complétion, et le journal de tous les appels LMS (0 erreur attendu).

## 8. Ce qui reste / pistes

- **Validation vrai LMS** (dernier cran) : Moodle (local `docker run bitnami/moodle`, ou
  MoodleCloud) et/ou SCORM Cloud (`cloud.scorm.com`) quand le compte sera actif. Vérifier
  l'import sans erreur + remontée complétion/% dans le dashboard.
- **Cas d'inlining non couvert** : graphes de modules ES (`<script type="module">` avec
  `import './x.js'`) et `importmap` — le runtime inline le script d'entrée mais ne résout pas
  ses imports relatifs. Claude Design émet en général un bundle unique ou des libs CDN UMD, donc
  c'est rare ; à terme, **émettre un avertissement explicite** dans ce cas.
- **Futur** : variante xAPI/cmi5 + LRS (suivi analytique fin). Délibérément reporté — l'archi
  actuelle se rabat proprement sur SCORM, qui couvre complétion + progression.

## 9. Notes de contexte

- **Édition concurrente (historique)** : `test/`, `fixtures/`, `schemas/` et `package.json` ont
  été écrits en parallèle (les *contrats* de test). `src/*.ts` est l'**implémentation** qui les
  satisfait. La division naturelle : les tests/fixtures/schémas définissent la cible, `src/` la
  remplit.
- **Intention** : artefact pensé pour être **propre et open-sourçable** — aucun contenu tiers ni
  donnée d'entreprise. Garder cette hygiène (pas de secrets, pas d'assets de marque internes).
