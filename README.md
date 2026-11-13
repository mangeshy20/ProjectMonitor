# Project Monitor

A project tracking dashboard that runs on a Google Sheet. No backend, no database, no login.

**Live demo:** [projectmonitorz.pages.dev](https://projectmonitorz.pages.dev/)

## Features

- Project list with step, progress, status and due date
- Step pipeline from Planning to Completed
- Updates with @mentions and a full change history
- API tracking for each project
- Live sync, light and dark themes, works on phones

## Setup

1. **Google Sheet:** create a Sheet, name the first tab **Projects**, and share it as **Anyone with the link → Viewer**. Copy the Sheet ID from the URL.
2. **Server script:** open **Extensions → Apps Script**, paste `Code.gs`, and deploy as a **Web app** (Execute as: Me, Who has access: Anyone). Copy the `/exec` URL.
3. **Config:** put the Sheet ID and `/exec` URL into `config.js`, along with your app name, logo and colour.
4. **Host:** upload the folder to any static host, such as Cloudflare Pages, Netlify or GitHub Pages.

See [SETUP.md](SETUP.md) for the full guide.

## Important

- There is no login. Anyone with the dashboard link can add, edit, delete and clear data.
- Admin opens by double-clicking the app name.
- After changing `Code.gs`, deploy it as a **new version** of the same deployment so the `/exec` URL stays the same.
