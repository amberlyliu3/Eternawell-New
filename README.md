# Eternawell-Clinic

Homepage designs for Eternawell Medical. Netlify publishes the `site/` folder (see `netlify.toml`).

| URL | Version |
|---|---|
| `/` | Version picker |
| `/v1-original/` | Original landing page (dark teal, 3D blob) |
| `/v2-glass/` | Glass refraction concept |
| `/v3-particles/` | Scroll-morphing particles, lilac palette |
| `/v4-particles-sage/` | Scroll-morphing particles, sage palette |
| `/v5/` | Full multi-page site (Home, Services, About Us, Membership, Products, FAQ, Book) |
| `/v6/` | Editorial refinement of v5 with photography placeholders |
| `/v7/` | v6 in a bright warm palette with AA contrast, stock photos and fill-in provider bios, latest |

Other folders:
- `src/v5/`, `src/v6/`, `src/v7/` + `tools/build.sh` — v5 to v7 are generated from shared templates. Edit pages or the clinic details at the top of the script, then run `bash tools/build.sh v7`
- Photos: each placeholder is a `<figure class="ph">` in `src/v7/pages/`. Put an `<img src="..." alt="...">` inside it and the placeholder styling hides itself. In v7, images marked `data-stock` are free Unsplash stand-ins to swap for real photography; the Services hover previews come from each row's `data-img`
- Provider bios in v7: replace each highlighted `<span class="todo">[...]</span>` in `src/v7/pages/about.html` with the real text (drop the span), and put the portrait `<img>` in that profile's figure
- `concepts/` — editable sources for the v2 and v4 concept pages (artifact format, no `<html>` wrapper)
- `notes/` — site review and redesign suggestions (not published)

Three.js 0.160.0 is vendored in `site/vendor/`, so the site has no runtime CDN dependency besides Google Fonts.
