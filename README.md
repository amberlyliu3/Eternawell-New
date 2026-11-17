# Eternawell-New

Site designs for EternaWell Medicine. Cloudflare publishes the `site/` folder (see `wrangler.jsonc` and the hosting notes below).

| URL | Version |
|---|---|
| `/` | Version picker |
| `/v6/` | Editorial multi-page site with photography placeholders |
| `/v7/` | v6 in a bright warm palette with AA contrast, stock photos and fill-in provider bios |
| `/v8/` | EternaWell Medicine: the doctor's requirements (four services, booking slot, Bellevue details, privacy policies), brighter palette, latest |

Other folders:
- `src/v6/` to `src/v8/` + `tools/build.sh` — v6 to v8 are generated from shared templates. Edit pages or the clinic details at the top of the script, then run `bash tools/build.sh v8`. v8 keeps its build-time clinic details in `src/v8/config.sh`, and its Chinese pages in `src/v8/zh/` (built to `/v8/zh/`; each page links to its counterpart in the other language); the build also runs `tools/editable.py`, which marks text and photos for the admin editor
- Photos: each placeholder is a `<figure class="ph">` in `src/v8/pages/`. Put an `<img src="..." alt="...">` inside it and the placeholder styling hides itself. Images marked `data-stock` are free Unsplash stand-ins to swap for real photography; the Services hover previews come from each row's `data-img`
- Fill-in blanks in v8 (doctor's bio, screening tests, legal text): replace each highlighted `<span class="todo">[...]</span>` in `src/v8/pages/` with the real text (drop the span), and put the doctor's portrait `<img>` in the About page figure
- `concepts/` — editable sources for the early glass and particle concept pages (artifact format, no `<html>` wrapper)
- `notes/` — site review and redesign suggestions (not published)

Three.js 0.160.0 is vendored in `site/vendor/`, so the site has no runtime CDN dependency besides Google Fonts.

## Hosting on Cloudflare

`wrangler.jsonc` deploys `worker/index.js` with `site/` as static files; `site/_headers` sets the same headers as `netlify.toml`. Cloudflare rebuilds on every push to `main` (build command empty, deploy command `npx wrangler deploy`).

The Worker runs first for `/v8/*`, `/api/*`, `/admin/*` and `/media/*`:
- **Online booking** on the v8 Book page (`site/v8/assets/booking.js`), no patient account needed.
- **Messages**: the "Send the doctor a message" box in the v8 footer; messages appear in the admin's Messages tab.
- **Admin area** at `/admin/` (`site/admin/`): bookings, messages, website text and photo editing (English and Chinese pages separately), availability (weekly hours, blocked days such as EZCall work days, visit types) and clinic details.
- Everything is stored in one SQLite-backed Durable Object (`Store`), so there is no separate database to set up.
- **Google Calendar (optional)**: add the service account's JSON key file as the `GOOGLE_SERVICE_ACCOUNT_KEY` secret, share each calendar with the service account's email ("Make changes to events"), then add the calendars under Admin → Availability → Google Calendar. Any number of calendars can block online booking: every event counts (Busy or Free, all-day included), except cancelled or declined ones; new bookings are added to the one chosen as "Add new bookings to", and cancellations remove them. The admin Schedule shows bookings, blocked time and each calendar's busy time. `GOOGLE_API_BASE` / `GOOGLE_TOKEN_URL` exist only for local testing against a stand-in server; never set them in Cloudflare.
- **Apple Calendar / iCloud (optional)**: make an app-specific password at appleid.apple.com (Sign-In and Security → App-Specific Passwords), then add two secrets: `APPLE_ID` (the Apple ID email) and `APPLE_APP_PASSWORD`. In Admin → Availability → Apple Calendar, click **Find my calendars**, tick the ones whose events should block online booking (Busy / Free / All-day, like Google), optionally choose one for new bookings, and press Save. The site reads iCloud over CalDAV and only ever sends the password to `*.icloud.com`. Events added to iCloud always use minimal details (Apple doesn't sign HIPAA agreements). To disconnect, delete the app-specific password. `APPLE_CALDAV_URL` exists only for local testing against a stand-in server; never set it in Cloudflare.
- The admin password is the `ADMIN_PASSWORD` secret: Cloudflare dashboard → Workers & Pages → eternawell-new → Settings → Variables and Secrets → Add → type Secret.
- Edits made in the admin are stored on Cloudflare and applied when pages are served; they are not written back to this repo.

Local testing: install Node, put `ADMIN_PASSWORD=<any test value>` in `.dev.vars` (git-ignored), then run `npx wrangler dev`.

