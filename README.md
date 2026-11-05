# excali-notes

Excalidraw notes organised by topic. React/TypeScript frontend, Spring Boot 3.5 backend, every drawing stored in Postgres.

## Requirements

- Docker Desktop running with Docker Compose
- Java 21
- Node.js 22.12+ and npm

## Run

From the project root:

```sh
docker compose up -d
```

In a second terminal:

```sh
cd backend
./mvnw spring-boot:run
```

Check the database connection:

```sh
curl http://localhost:8080/api/health
```

In a third terminal:

```sh
cd frontend
npm install
npm run dev
```

Open the URL printed by Vite (normally http://localhost:5173). Vite proxies `/api` to http://localhost:8080.

Build the frontend with `npm run build` from `frontend/`.
Stop Postgres with `docker compose down`; the named `pgdata` volume retains its data.

## Tests

Frontend unit tests for the autosave queue (no extra dependencies, uses Node's test runner):

```sh
cd frontend
npm test
```

Lint with `npm run lint`. The backend has no automated tests yet; `./mvnw verify` only compiles and packages it.

## What's implemented

- **Topics and notes.** The sidebar lists topics. Open a topic to see its notes, newest first. Create and delete both; deleting a topic deletes its notes. Topic names must be unique.
- **Storage.** Each note's whole Excalidraw scene, including embedded images as data URLs, is stored as one `jsonb` column (`notes.scene`). Tables are created by Hibernate (`ddl-auto: update`).
- **REST API** (all under `/api`):
  - `GET/POST /topics`, `DELETE /topics/{id}`
  - `GET/POST /topics/{id}/notes`
  - `GET /notes/{id}`, `PATCH /notes/{id}` (rename), `DELETE /notes/{id}`
  - `PUT /notes/{id}/scene` (raw scene JSON)
  - `GET /health`
- **Autosave** (`frontend/src/saveQueue.ts`):
  - Saves 1 s after the drawing stops changing. Hover and selection changes don't count.
  - Sends one request at a time and keeps only the newest unsaved scene per note, so an older save can't overwrite a newer one.
  - If a save fails, the scene stays queued and retries automatically (1 s, 2 s, 5 s, 10 s, then every 30 s). It also retries when the browser comes back online, or when you click "Retry now".
  - Switching notes saves first. If that save fails, you're asked before moving on, and the changes keep retrying. Reopening that note shows the unsaved copy.
  - The footer shows the state: Unsaved changes / Saving… / Saved / Save failed.
- **Closing the tab.** Small unsaved scenes are sent as `keepalive` requests when the page is hidden; the browser usually, but not always, delivers them. If a save is still in flight or the scene is over about 60 KB (typically one with images), the browser shows its "Leave site?" warning instead.

## Known limitations

- Rename exists in the API but has no UI yet.
- Two tabs editing the same note overwrite each other; the last save wins.
- Very large scenes (many images) are sent in full on every save.
