# File Catalog

A self-contained NAS file indexer with a web-based search UI and built-in volume scanner. Built for UNRAID but runs anywhere Docker is available.

## Features

- Browse and scan NAS shares directly from the web UI
- Search by filename, path, or both
- Filter by file type (video, audio, images, documents)
- Copy Windows UNC paths to clipboard with one click
- Delete volumes from the UI
- Zero external dependencies — SQLite database stored in a mapped volume

## Quick Start (UNRAID)

### 1. Create the app directory

```bash
mkdir -p /mnt/user/appdata/filecatalog
```

### 2. Copy the app files

Copy these files into `/mnt/user/appdata/filecatalog/`:
- `server.js`
- `index.html`
- `catalog.css`
- `app.js`
- `package.json`
- `Dockerfile`

### 3. Build the image

SSH into your UNRAID server and run:

```bash
cd /mnt/user/appdata/filecatalog
docker build -t filecatalog .
```

### 4. Start the container

```bash
docker run -d \
  --name filecatalog \
  --restart unless-stopped \
  -p 3030:3030 \
  -e API_HOST=YOUR_UNRAID_IP \
  -v /mnt/user/appdata/filecatalog/data:/data \
  -v /mnt/user:/mnt/user \
  filecatalog
```

Replace `YOUR_UNRAID_IP` with your UNRAID server's IP address (e.g. `192.168.1.100`).

### 5. Open the UI

Navigate to `http://YOUR_UNRAID_IP:3030` in your browser.

## Environment Variables

| Variable   | Default     | Description                                      |
|------------|-------------|--------------------------------------------------|
| `API_HOST` | `localhost` | IP or hostname the browser uses to reach the API |
| `PORT`     | `3030`      | Port the server listens on                       |
| `DB_PATH`  | `/data/filecatalog.db` | Path to the SQLite database file     |

## Scanning a Volume

1. Click **⟳ MANAGE** in the top right
2. Browse to the share you want to index
3. Enter a **Volume Name** (e.g. `MediaA`)
4. Enter the **UNC Path** for Windows copy support (e.g. `\\yourserver\MediaA`)
5. Click **START SCAN**

Progress updates in real time. Large volumes may take several minutes.

## Rebuilding After Updates

```bash
cd /mnt/user/appdata/filecatalog
docker build --no-cache -t filecatalog . && \
docker stop filecatalog && \
docker rm filecatalog && \
docker run -d \
  --name filecatalog \
  --restart unless-stopped \
  -p 3030:3030 \
  -e API_HOST=YOUR_UNRAID_IP \
  -v /mnt/user/appdata/filecatalog/data:/data \
  -v /mnt/user:/mnt/user \
  filecatalog
```

## Database

The SQLite database is stored at `/data/filecatalog.db` inside the container, mapped to `/mnt/user/appdata/filecatalog/data/` on the host. It is created automatically on first run — no setup required.

To inspect the database directly:
```bash
docker exec -it filecatalog sqlite3 /data/filecatalog.db
```

Or download it and open with [DB Browser for SQLite](https://sqlitebrowser.org/).

## Scheduled Rescans

To keep the index current, add a scheduled task that re-scans your volumes. On UNRAID this can be done with the **User Scripts** plugin:

```bash
#!/bin/bash
curl -s -X POST http://localhost:3030/api/scan \
  -H "Content-Type: application/json" \
  -d '{"path":"/mnt/user/Media","volume":"Media","uncPath":"\\\\yourserver\\Media"}'
```

## License

MIT
