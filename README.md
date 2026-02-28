# Control

Operational command dashboard built with React + Vite for quote creation, trip execution, fleet management, CRM intelligence, GM brief telemetry, and data vault operations.

## Stack

- React 19 + TypeScript + Vite
- Tailwind CSS
- React Router (`HashRouter`)
- Firebase (optional, for cross-device sync)
- Google Maps JS APIs (for map, autocomplete, routing, heatmap)

## What the app does

- **GM Brief (`/brief`)**: live operational snapshot, 24h mission distribution, traffic telemetry, and mission heatmap.
- **Calculator (`/`)**: quote + route planning with pickup/destination/stops, traffic-aware ETAs, fare computation, and save-to-trip flow.
- **Trips (`/trips`)**: mission log with filtering, deep-link opening (`/trips?id=<tripId>`), requote destination/stops, message actions, and cancelled-trip archive/restore.
- **Drivers (`/drivers`)**: fleet onboarding, status/availability control, unit analytics, fuel-range tracking, and WhatsApp shortcuts.
- **CRM (`/crm`)**: customer intelligence, fleet/finance views, contact import, and Vault backup/restore/clear actions.
- **Settings (`/settings`)**: pricing parameters, operator WhatsApp, and message templates.

## Local development

### Prerequisites

- Node.js 20+
- npm

### Install and run

```bash
npm install
npm run dev
```

Dev server runs on `http://0.0.0.0:3000`.

### Build / preview

```bash
npm run build
npm run preview
```

## Configuration

### 1) Google Maps (required for map/routing features)

Set these values in `.env.local`:

- `VITE_GOOGLE_MAPS_API_KEY`
- `VITE_GOOGLE_MAPS_MAP_ID` (optional)
- `VITE_GOOGLE_MAPS_MAP_ID_DARK` (optional)

Enable at least these APIs on that key:

- Maps JavaScript API
- Places API
- Geocoding API
- Routes API

The app loads Maps with libraries: `places`, `marker`, and `visualization`.

### 2) Firebase cloud sync (optional)

Without Firebase env values, the app remains fully local (localStorage only).

Create `.env.local` from `.env.example`:

```bash
cp .env.example .env.local
```

Required variables:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

Optional variables (with defaults):

- `VITE_FIREBASE_SYNC_COLLECTION` (`control-sync`)
- `VITE_FIREBASE_SYNC_DOC_ID` (`shared`)

Firebase setup expectations:

- Enable **Authentication -> Anonymous**
- Enable **Firestore Database**
- Allow authenticated reads/writes for the sync doc path

Example Firestore rule for default collection:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /control-sync/{docId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

## Data model and persistence

- Local primary storage uses browser `localStorage` keys for trips, deleted trips, drivers, customers, alerts, and settings.
- Optional cloud sync mirrors full-system payloads to Firestore and applies remote updates when signatures differ.
- Backup format version currently emitted by app: `2.1.0`.

## Imports/exports

- Vault supports full system backup export/import (with optional settings restore).
- Contact import supports JSON and CSV with validation/normalization.
- Cancelled trips can be archived and restored from Trips view.

## Project layout

```text
components/   Layout + shared UI + modal/cards
context/      App store/state and sync orchestration
pages/        GMBrief, Calculator, Trips, Drivers, CRM, Settings
services/     Storage, sync, parsing, traffic, placeholders, WhatsApp, imports
```
