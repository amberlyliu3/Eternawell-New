#!/usr/bin/env bash
# Builds one site version from its templates: site/<version> from src/<version>.
# Change clinic details below (or in src/<version>/config.sh), then run:  bash tools/build.sh v8
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: bash tools/build.sh <version, e.g. v6>}"
SRC="src/$VERSION"
OUT="site/$VERSION"
[ -d "$SRC" ] || { echo "no templates in $SRC" >&2; exit 1; }
export ROOT="/$VERSION" BASE="/$VERSION"

# ---- Clinic details (placeholders from the original site; replace with real ones) ----
export PHONE_DISPLAY="(555) 123-4567"
export PHONE_TEL="+15551234567"
export EMAIL="hello@eternawell.example"
export ADDRESS_1="123 Wellness Way, Suite 200"
export ADDRESS_2="Austin, TX 78701"
export PORTAL_URL="https://www.optimantra.com/optimus/om/patient/login"
export SHOP_SKIN_URL="https://your-clinic-shop.example/skin-hair"
export SHOP_SUPP_URL="https://your-clinic-shop.example/hormone-supplements"
export MAP_URL="https://www.google.com/maps/search/?api=1&amp;query=${ADDRESS_1// /+}+${ADDRESS_2// /+}"
export EDITABLE=""
# A version can override any of the above in src/<version>/config.sh
[ -f "$SRC/config.sh" ] && . "$SRC/config.sh"

# ---- Shared icons ----
export ARROW='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 8h11M9 4l4 4-4 4"/></svg>'
export CHECK='<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10" cy="10" r="8.2"/><path d="M6.4 10.2l2.4 2.4 4.8-5"/></svg>'
export EXT='<svg class="ext-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 3h7v7M13 3L4 12"/></svg>'

# ---- 3D particle field, only on pages with "@field 1" ----
FIELD_CANVAS_ON='<canvas id="field" aria-hidden="true"></canvas>'
FIELD_SCRIPTS_ON="<script type=\"importmap\">{ \"imports\": { \"three\": \"/vendor/three.module.js\" } }</script>
<script type=\"module\" src=\"$ROOT/assets/field.js\"></script>"

# Builds one language: templates in $1 → pages in $2, linking to the other language under $3
build_lang() {
  LSRC="$1" LOUT="$2" ALT_BASE="$3"
  for page in "$LSRC"/pages/*.html; do
    name=$(basename "$page" .html)
    export PAGE="$name"
    export TITLE="$(sed -n 's/^@title //p' "$page")"
    export DESC="$(sed -n 's/^@desc //p' "$page")"
    export SHAPE="$(sed -n 's/^@shape //p' "$page")"
    export CLASS="$(sed -n 's/^@class //p' "$page")"
    if [ "$(sed -n 's/^@field //p' "$page")" = 1 ]; then
      export FIELD_CANVAS="$FIELD_CANVAS_ON" FIELD_SCRIPTS="$FIELD_SCRIPTS_ON"
    else
      export FIELD_CANVAS="" FIELD_SCRIPTS=""
    fi

    # The same page in the other language, for the language switch and hreflang links
    if [ "$name" = home ]; then export PAGE_PATH="/"; else export PAGE_PATH="/$name/"; fi
    export ALT_URL="$ALT_BASE$PAGE_PATH"

    if [ "$name" = home ]; then
      dest="$LOUT/index.html"
    else
      mkdir -p "$LOUT/$name"
      dest="$LOUT/$name/index.html"
    fi

    {
      cat "$LSRC/partials/head.html" "$LSRC/partials/header.html"
      grep -v '^@[a-z]' "$page"
      cat "$LSRC/partials/footer.html"
    } | CTA_FILE="$LSRC/partials/cta.html" perl -pe 'if (/^\s*\@\@CTA\@\@\s*$/) { local $/; open my $f, "<", $ENV{CTA_FILE} or die "missing $ENV{CTA_FILE}\n"; $_ = <$f>; }' \
      | perl -pe 's/\{\{(\w+)\}\}/exists $ENV{$1} ? $ENV{$1} : die "unknown placeholder {{$1}}\n"/ge; s/data-page="\Q$ENV{PAGE}\E"/data-page="$ENV{PAGE}" aria-current="page"/g' \
      > "$dest"
    echo "built $dest"
  done
}

# English is the main site; a version with src/<version>/zh/ also gets Chinese pages under /<version>/zh/
if [ -d "$SRC/zh" ]; then
  export LANG_CODE=en ALT_LANG=zh-Hans ALT_LABEL="中文" ALT_NAME="切换到中文" EN_BASE="/$VERSION" ZH_BASE="/$VERSION/zh"
  build_lang "$SRC" "$OUT" "/$VERSION/zh"
  export BASE="/$VERSION/zh" LANG_CODE=zh-Hans ALT_LANG=en ALT_LABEL="EN" ALT_NAME="Switch to English"
  build_lang "$SRC/zh" "$OUT/zh" "/$VERSION"
else
  build_lang "$SRC" "$OUT" ""
fi

[ "$EDITABLE" = 1 ] && python3 tools/editable.py "$OUT"
exit 0
