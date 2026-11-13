# Project Monitor

A lightweight project tracking dashboard that runs on a Google Sheet. See every project at a glance, where it stands, and what happened to it. There is no backend to host, no database, and nobody needs to log in.

**Live demo:** [projectmonitorz.pages.dev](https://projectmonitorz.pages.dev/)

## Features

- **Project list** with step, progress, status, due date and latest update, sortable by any column
- **Step pipeline** (Planning → Design → Review → Development → Testing → Deployment → Completed) showing how many projects have reached each step; click a step to filter
- **One-click "Move to next step"** that also updates the progress percentage
- **Updates with @mentions**: post messages on a project and tag teammates
- **Full history**: every change is logged with who made it, what changed and why
- **API tracking**: list each project's API integrations with a status (Not started, Building, Testing, Live, Issue), a review state and a review note
- **"What's new" feed** across all projects, with an unread count
- **Live sync**: changes from other people appear within a few seconds
- **Instant saves**: changes show immediately and are written to the Sheet in the background
- **Shareable links** to a project, e.g. `#project=PRJ-0003/history`
- **Admin panel** to edit team names and clear data
- **White label**: set your own name, logo, favicon and accent colour in one file
- **Light and dark themes** that follow the device setting
- **Responsive**: works on phones, tablets and desktops
- **No build step**: plain HTML, CSS and JavaScript with no dependencies

## How it works

```
Browser (index.html + script.js)
        │
        │  reads and writes as JSON
        ▼
Google Apps Script web app (Code.gs)
        │
        ▼
Google Sheet (Projects, Logs, APIs, Admin tabs)
```

The dashboard is a static site. The Apps Script web app is attached to your Google Sheet and runs as the Sheet's owner, so visitors never sign in. If the script can't be reached, the dashboard falls back to reading the Sheet through its share link.

## Files

| File | What it is |
|---|---|
| `config.js` | Your settings. This is the only file you need to edit. |
| `index.html`, `script.js`, `style.css` | The dashboard. |
| `Code.gs` | The server script. You paste it into your Google Sheet once. |
| `SETUP.md` | The setup guide in more detail. |

## Setup

### 1. Make the Google Sheet

1. Create a new Google Sheet and name the first tab **Projects**.
2. Click **Share**, then set **General access** to **Anyone with the link → Viewer**.
3. Copy the Sheet ID from the address bar. It's the part between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/THIS-PART/edit`

The other tabs (**Logs**, **Admin**, **APIs**) are created automatically the first time they're needed.

### 2. Add the server script

1. In the Sheet, open **Extensions → Apps Script**.
2. Delete what's there, paste all of `Code.gs`, and save.
3. Click **Deploy → New deployment**, choose **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone
4. Click **Deploy**, allow the permissions, and copy the **Web app URL**. It ends in `/exec`.

### 3. Fill in `config.js`

| Setting | What to put |
|---|---|
| `APP_NAME` | Your dashboard's name, e.g. `'Acme Projects'` |
| `APP_DESCRIPTION` | One line shown in search results and link previews |
| `LOGO_URL` | Your logo, e.g. `'logo.png'` or a full `https://` link. Leave `''` for the built-in icon. |
| `FAVICON_URL` | The browser tab icon. Leave `''` to use the logo. |
| `ACCENT_COLOR` | Your brand colour, e.g. `'#e4572e'`. Dark mode gets a lighter shade automatically. |
| `SPREADSHEET_ID` | The ID from step 1 |
| `SHEET_NAME` | The tab that holds the projects (default `'Projects'`) |
| `SCRIPT_URL` | The Web app URL from step 2 |
| `TEAM`, `MANAGERS`, `DEVELOPERS` | Starting names. You can change them later in the dashboard. |

To use the same starting names for a brand-new Sheet, also change the three `defaults:` lists near the top of `Code.gs`.

### 4. Put it online

Upload the folder to any static host, such as Cloudflare Pages, Netlify, GitHub Pages or Vercel. Then share the link.

To try it locally first:

```bash
python -m http.server
```

Then open http://localhost:8000.

## Using the dashboard

- **Add a project:** click **Add a project** in the top bar.
- **Open a project:** click its row to see Details, Updates and APIs.
- **Post an update:** open a project, click **Give an update**, and type `@` to tag someone.
- **Admin:** double-click (or double-tap) the app name in the top bar. From there you can edit the team lists or clear data.
- **Empty Sheet:** the dashboard shows example projects. Click **Use these examples** to save them into the Sheet, or add your own project and they disappear.

## Sheet structure

| Tab | Contents |
|---|---|
| **Projects** | One row per project: ID, Project Name, Client / Department, Project Manager, Start Date, Due Date, Completion Date, Stage, Progress (%), Status, Priority, Budget, Remarks, Last Updated, Developer |
| **Logs** | The history: Timestamp, Project ID, Project Name, Action, Changes, Reason / Note, By |
| **APIs** | One row per API integration: API ID, Project ID, API Name, Status, Review, Review Note, Developer, Environment, Reviewed By, Last Updated |
| **Admin** | The team lists, one column each: Team names, In charge, Developers |

Project IDs (`PRJ-0001`, `PRJ-0002`, …) are assigned by the script and never reused, even after a project is deleted. Extra columns you add to the Projects tab are left untouched.

## Updating the server script

When `Code.gs` changes, paste the new code into Apps Script, then go to **Deploy → Manage deployments → Edit → New version**. This keeps the same `/exec` URL, so `config.js` doesn't need to change.

## Security

This dashboard has no login, by design. Keep these points in mind:

- Anyone who has the dashboard link can add, edit and delete projects, and can open the Admin panel.
- The "Who are you?" name is picked from a list and is not verified.
- The Google Sheet is readable by anyone who has its link.

It suits small, trusted teams. Don't store confidential data in it, and share the link only with people who should be able to make changes.

## Tech

- HTML, CSS and vanilla JavaScript
- Google Apps Script
- Google Sheets as the data store
- [Manrope](https://fonts.google.com/specimen/Manrope) typeface
