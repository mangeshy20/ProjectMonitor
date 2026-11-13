# Project dashboard: setup

A project tracking dashboard that runs on a Google Sheet. It has projects, steps, updates with @tags, API tracking and history. Nobody needs to log in.

## What's in this folder

| File | What it is |
|---|---|
| `config.js` | **Your settings.** This is the only file you need to edit. |
| `index.html`, `script.js`, `style.css` | The dashboard. You don't need to edit these. |
| `Code.gs` | The server script. You paste it into your Google Sheet once. |

## 1. Make the Google Sheet

1. Create a new Google Sheet and name the first tab **Projects**.
2. Click **Share**, then set **General access** to **Anyone with the link → Viewer**.
3. Copy the Sheet ID from its address bar. It's the long part between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`THIS-PART`**`/edit`

The dashboard creates the other tabs (**Logs**, **Admin**, **APIs**) itself, the first time they're needed.

## 2. Add the server script

1. In the Sheet, open **Extensions → Apps Script**.
2. Delete what's there, paste all of `Code.gs`, and save.
3. Click **Deploy → New deployment**, choose **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone
4. Click **Deploy**, allow the permissions, and copy the **Web app URL**. It ends in `/exec`.

## 3. Fill in `config.js`

Open `config.js` in any text editor (Notepad works) and change these settings:

| Setting | What to put |
|---|---|
| `APP_NAME` | Your dashboard's name, e.g. `'Acme Projects'` |
| `LOGO_URL` | Your logo file, e.g. `'logo.png'` (put the file in this folder). Leave it `''` to use the built-in icon. |
| `FAVICON_URL` | The browser tab icon. Leave it `''` to use the logo. |
| `ACCENT_COLOR` | Your brand colour, e.g. `'#e4572e'`. Dark mode gets a lighter shade of it automatically. |
| `SPREADSHEET_ID` | The ID from step 1 |
| `SCRIPT_URL` | The Web app URL from step 2 |
| `TEAM`, `MANAGERS`, `DEVELOPERS` | Starting names. You can change them later in the dashboard. |

To use the same starting names for a brand-new Sheet, also change the three `defaults:` lists near the top of `Code.gs`.

## 4. Put it online

Upload the folder to any static web host, such as Netlify (drag and drop), GitHub Pages, Vercel or your own server. Then share the link.

To try it on your own computer first, run `python -m http.server` inside this folder and open http://localhost:8000.

## Using it

- **Admin:** double-click (or double-tap) the app name at the top. It opens **Team**, where you edit names for everyone, and **Clear data**.
- **Empty Sheet:** the dashboard shows example projects. Use **Add sample projects** to save them into the Sheet.
- **Updating `Code.gs` later:** paste the new code, then go to **Deploy → Manage deployments → Edit → New version**. That way the `/exec` URL stays the same.
