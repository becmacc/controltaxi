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

- Enable **Authentication -> Sign-in method -> Google**
- Enable **Firestore Database**
- Gate access using an allowlist collection (`allowed_users`)

### 3) Operator sign-in (recommended for production)

The app now supports Firebase Authentication login for all routes.

When to add Firebase Auth:

1. Before first production deploy that should be private.
2. Before giving access to operators on multiple devices.
3. Before enabling Finance/Vault for non-local users.

Firebase checklist:

- Go to **Firebase Console -> Authentication -> Sign-in method**.
- Enable **Google**.
- Keep only providers you need (for Google-only, disable Email/Password and Anonymous).
- Sign in once with each operator Google account so each user appears in **Authentication -> Users**.
- Create an allowlist in Firestore (steps below) so only approved UIDs can access data.

Core access behavior in app:

- All app routes require sign-in.
- Core-only sections (CRM and Settings) require core role/claim.
- Core access is granted to `admin` role, or explicit claim `coreAccess: true`.
- `admin` users have full app access (Control + Core); `ops` users are limited to Control pages.

Example Firestore rules (copy/paste) using `allowed_users` allowlist:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAuthed() {
      return request.auth != null;
    }

    function isApproved() {
      return isAuthed()
        && exists(/databases/$(database)/documents/allowed_users/$(request.auth.uid))
        && get(/databases/$(database)/documents/allowed_users/$(request.auth.uid)).data.enabled == true;
    }

    function isAdmin() {
      return isApproved()
        && get(/databases/$(database)/documents/allowed_users/$(request.auth.uid)).data.role == 'admin';
    }

    match /control-sync/{docId} {
      allow read, write: if isApproved();
    }
    match /control-sync/{docId}/payloadChunks/{chunkId} {
      allow read, write: if isApproved();
    }

    match /allowed_users/{uid} {
      allow read: if isAuthed() && (request.auth.uid == uid || isAdmin());
      allow write: if isAdmin();
    }

    match /access_requests/{uid} {
      allow create: if isAuthed()
        && request.auth.uid == uid
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.status == 'pending';
      allow read: if isAuthed() && (request.auth.uid == uid || isAdmin());
      allow update: if isAuthed() && (
        isAdmin()
        || (
          request.auth.uid == uid
          && resource.data.status != 'approved'
          && request.resource.data.uid == request.auth.uid
          && request.resource.data.status == 'pending'
        )
      );
      allow delete: if isAdmin();
    }

    match /{document=**} {
      allow read, write: if isApproved();
    }
  }
}
```

### 4) Firestore allowlist setup (`allowed_users`) — step by step

1. Go to **Firebase Console -> Authentication -> Users**.
2. Find your operator account and copy its **User UID**.
3. Go to **Firestore Database -> Data**.
4. Create collection: `allowed_users`.
5. Create document with **Document ID = that UID**.
6. Add fields:
   - `enabled` (boolean) = `true`
   - `role` (string) = `ops` (or `admin` / `viewer`)
   - `note` (string, optional) = operator name
7. Repeat steps 2–6 for each approved user.
8. Go to **Firestore Database -> Rules**, paste the rules above, click **Publish**.
9. Sign out/in on the app (refresh token), then verify:
   - approved UID can use the app,
   - non-approved UID gets blocked by rules.

Tip: Keep at least one known admin UID in `allowed_users` before publishing rules.

### 5) Request + approval workflow

- Non-approved users can sign in and submit a request from the blocked access screen.
- Requests are stored in `access_requests/{uid}` with status `pending`.
- Admin users can open **Settings -> Access Requests Queue** and click **Approve** or **Reject**.
- Approve writes/updates `allowed_users/{uid}` and marks the request as approved.

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
