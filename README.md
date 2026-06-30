# spinal-organ-connector-schindler-traffic

Connecteur Spinal pour l'API Schindler « People & Goods Data » : récupère les
statistiques de trafic des ascenseurs et les écrit avec historique dans le BOS.

## Ce qu'il fait

- Découvre les ascenseurs dans le BOS et lit leur `equipmentNumber`.
- Crée un `BmsDevice` par ascenseur dans un réseau virtuel dédié.
- Récupère 3 vues : par temps, par étage, par niveau de service.
- Écrit les valeurs en time-series (avec backfill d'historique au démarrage).

## Structure créée dans le BOS

```
Virtual Network
└── <equipmentNumber> (device)
    ├── endpoints globaux (passengerCount, averageWaitingTime, …)
    ├── endpoints service level (waitingTime_0_30_percentage, …)
    └── floors
        └── floor_<n>
            └── floor_<n>_passengerCount, floor_<n>_averageWaitingTime, …
```

## Installation

```bash
npm install
npm run build
cp .env.example .env   # puis renseigner les valeurs
node index.js
```

Avec pm2 :

```bash
pm2 start ecosystem.config.js
```

## Configuration (`.env`)

- **Hub** : `SPINAL_USER_ID`, `SPINAL_PASSWORD`, `SPINALHUB_IP`, `SPINALHUB_PORT`, `DIGITALTWIN_PATH`
- **Réseau** : `NETWORK_NAME`, `VIRTUAL_NETWORK_NAME`
- **Découverte BOS** : `BOS_CONTEXT_NAME`, `BOS_CATEGORY_NAME`, `BOS_GROUP_NAME`, `EQUIPMENT_ATTR_CATEGORY`, `EQUIPMENT_ATTR_NAME`
- **API Schindler** : `SCHINDLER_BASE_URL`, `SCHINDLER_TOKEN_URL`, `SCHINDLER_CLIENT_ID`, `SCHINDLER_CLIENT_SECRET`
- **Historique** : `HISTORY_DURATION_MINUTES`, `RESOLUTION_MINUTES`, `PULL_INTERVAL`

> `RESOLUTION_MINUTES` doit être multiple de 5 et diviseur de 1440
> (5, 10, 15, 20, 30, 60, 120, 240, 360, 480, 720, 1440).

## Sandbox

Le mode sandbox (`SCHINDLER_BASE_URL=…/traffic/v1-sandbox`) renvoie toujours les
mêmes données de démo, quels que soient l'ascenseur et la période.
