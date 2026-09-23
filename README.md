# Extracteur CadnaA – Québec

Outil local (navigateur) pour sélectionner une zone au Québec et générer un ZIP de
shapefiles prêts à importer dans **CadnaA** : topographie, bâtiments avec hauteurs, routes.

## Ouvrir l'interface en ligne (sans installation)

[![Ouvrir dans GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/thibaultniamor-commits/cadnaa-quebec-extracteur?quickstart=1)

1. Cliquer sur le bouton ci-dessus. Il faut un compte GitHub gratuit, qui inclut 60 h de Codespaces par mois.
2. Attendre l'installation, environ 2 à 3 minutes la première fois.
3. L'interface s'ouvre dans un nouvel onglet. Sinon : onglet **Ports**, ligne 8000, icône 🌐.

Chaque personne obtient sa propre instance. Pensez à l'arrêter après usage
(<https://github.com/codespaces>).

## Démarrage en local

Windows, Python 3.11+ :

```bat
run.bat
```

Le premier lancement crée `.venv` et installe les dépendances, puis ouvre
<http://127.0.0.1:8000>.

1. Rechercher un lieu, dessiner un **rectangle** ou un **polygone** (modifiable à la souris).
2. Choisir les couches et options.
3. **Générer le ZIP**. Le téléchargement démarre automatiquement.
4. **Aperçu 3D (validation)** : terrain, bâtiments extrudés, routes, courbes de niveau et limite de zone.
   - Bâtiments colorés par source de hauteur (LiDAR, OSM, défaut) ou par hauteur.
   - Clic sur un bâtiment pour afficher `HAUTEUR`, `H_SRC`, `H_LIDAR`, `H_OSM`, `NIVEAUX`.
   - Exagération du relief réglable (les hauteurs des bâtiments restent réelles).
   - Le terrain affiché est allégé (300 × 300 mailles au maximum). Les shapefiles gardent la pleine résolution.

Ligne de commande (tests) :

```bat
.venv\Scripts\python.exe -m app.cli --bbox -71.232 46.810 -71.219 46.819 --interval 1
```

## Contenu du ZIP

| Fichier | Géométrie | Attributs principaux |
|---|---|---|
| `courbes_niveau.shp` | PolylineZ (Z = altitude) | `ALTITUDE` |
| `batiments.shp` | Polygone | `HAUTEUR` (m, relative), `H_SRC`, `H_LIDAR`, `H_OSM`, `NIVEAUX`, `ALT_SOL`, `TYPE`, `NOM` |
| `routes.shp` | Polyligne | `NOM`, `NO_RTE`, `CLASSE`, `CLS_AQ`, `CARACT`, `GESTION`, `VIT_DEF`, `LONG_M` |
| `zone_etude.shp` | Polygone | `SURF_KM2` |
| `mnt.asc` (option) | Grille ESRI ASCII | – |
| `LISEZMOI.txt` | – | Sources, licences, paramètres |

Projection : NAD83(CSRS) / MTM (zone choisie automatiquement selon la longitude, 3 à 10),
ou Lambert Québec (EPSG:32198). Encodage des attributs : CP1252 (fichier `.cpg` fourni).

## Sources de données

| Couche | Source | Accès |
|---|---|---|
| Topographie | RNCan **HRDEM 1 m** (LiDAR, DTM) ; complété par **MRDEM 30 m** hors couverture LiDAR | COG sur S3 + API STAC `datacube.services.geo.ca` |
| Bâtiments | Emprises **OpenStreetMap** (Overpass) | Hauteur = médiane (DSM − DTM) HRDEM, sinon tag `height`, sinon `building:levels` × 3 m, sinon valeur par défaut |
| Routes | **AQréseau+** (Adresses Québec, MRNF) | ArcGIS REST `servicescarto.mrnf.gouv.qc.ca` |

Licences : Licence du gouvernement ouvert – Canada (RNCan), ODbL (OSM), CC-BY 4.0 (Adresses Québec).

## Limites connues

- `VIT_DEF` est une vitesse **indicative** déduite de la classe de route. Aucun débit de trafic n'est fourni pour l'instant.
- Les hauteurs LiDAR datent du relevé : un bâtiment construit après le relevé prend la hauteur OSM ou la valeur par défaut (voir `H_SRC`).
- À la limite entre LiDAR 1 m et MRDEM 30 m, le terrain peut présenter une marche.
- Surface maximale : 100 km². La résolution du MNT est automatique (1 m jusqu'à 4 km², 2 m jusqu'à 25 km², 5 m au-delà).
- Le serveur du MRNF refuse les connexions TLS qui annoncent seulement `http/1.1` en ALPN (cas de `requests`). Ce service est donc interrogé via `urllib` (`app/net.py`).

## Structure

```
app/
  main.py       API FastAPI + tâches de fond
  pipeline.py   Orchestration, écriture des shapefiles, LISEZMOI
  topo.py       MNT (HRDEM/MRDEM) et courbes de niveau
  buildings.py  Bâtiments OSM + hauteurs LiDAR
  roads.py      Routes AQréseau+
  crs.py        Projections MTM / Lambert
  preview.py    Données de l'aperçu 3D (JSON)
  cli.py        Extraction en ligne de commande
  static/       Interface (Leaflet + Geoman) et aperçu 3D (three.js, viewer.js)
```
