# excali-notes

A minimal Excalidraw + React/TypeScript + Spring Boot 3.5 + Postgres starter for live coding.

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

## On stream

- [ ] Topic/Note entities with the scene stored as JSONB
- [ ] REST endpoints
- [ ] `onChange` debounce save
- [ ] Load via `initialData`
- [ ] Topics sidebar
- [ ] Image storage
