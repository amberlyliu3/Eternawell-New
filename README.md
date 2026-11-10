# Eternawell-New

Site designs for EternaWell Medicine. Cloudflare publishes the `site/` folder (see `wrangler.jsonc` and the hosting notes below).

| URL | Version |
|---|---|
| `/` | Version picker |
| `/v6/` | Editorial multi-page site with photography placeholders |
| `/v7/` | v6 in a bright warm palette with AA contrast, stock photos and fill-in provider bios |
| `/v8/` | EternaWell Medicine: the doctor's requirements (four services, booking slot, Bellevue details, privacy policies), brighter palette, latest |

Other folders:
- `src/v6/` to `src/v8/` + `tools/build.sh` — v6 to v8 are generated from shared templates. Edit pages or the clinic details at the top of the script, then run `bash tools/build.sh v8`. v8 keeps its build-time clinic details in `src/v8/config.sh`; the build also runs `tools/editable.py`, which marks text and photos for the admin editor
- Photos: each placeholder is a `<figure class="ph">` in `src/v8/pages/`. Put an `<img src="..." alt="...">` inside it and the placeholder styling hides itself. Images marked `data-stock` are free Unsplash stand-ins to swap for real photography; the Services hover previews come from each row's `data-img`
- Fill-in blanks in v8 (doctor's bio, screening tests, legal text): replace each highlighted `<span class="todo">[...]</span>` in `src/v8/pages/` with the real text (drop the span), and put the doctor's portrait `<img>` in the About page figure
- `concepts/` — editable sources for the early glass and particle concept pages (artifact format, no `<html>` wrapper)
- `notes/` — site review and redesign suggestions (not published)

Three.js 0.160.0 is vendored in `site/vendor/`, so the site has no runtime CDN dependency besides Google Fonts.

## Hosting on Cloudflare

`wrangler.jsonc` deploys `worker/index.js` with `site/` as static files; `site/_headers` sets the same headers as `netlify.toml`. Cloudflare rebuilds on every push to `main` (build command empty, deploy command `npx wrangler deploy`).

The Worker runs first for `/v8/*`, `/api/*`, `/admin/*` and `/media/*`:
- **Online booking** on the v8 Book page (`site/v8/assets/booking.js`), no patient account needed.
- **Admin area** at `/admin/` (`site/admin/`): bookings, website text and photo editing, availability (weekly hours, blocked days such as EZCall work days, visit types) and clinic details.
- Everything is stored in one SQLite-backed Durable Object (`Store`), so there is no separate database to set up.
- The admin password is the `ADMIN_PASSWORD` secret: Cloudflare dashboard → Workers & Pages → eternawell-new → Settings → Variables and Secrets → Add → type Secret.
- Edits made in the admin are stored on Cloudflare and applied when pages are served; they are not written back to this repo.

Local testing: install Node, put `ADMIN_PASSWORD=<any test value>` in `.dev.vars` (git-ignored), then run `npx wrangler dev`.

The newsletter form uses Netlify Forms, which does nothing on Cloudflare; connect it to an email service before relying on it there.
