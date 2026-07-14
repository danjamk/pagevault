#!/usr/bin/env bash
#
# Seed a running local Worker with a realistic client engagement, then print where to look.
#
#   make dev     # in one terminal
#   make demo    # in another
#
# Everything here is synthetic. Nothing touches a real deployment.

set -euo pipefail

BASE="${PAGEVAULT_URL:-http://127.0.0.1:8787}"
TOKEN="${PAGEVAULT_API_TOKEN:-local-dev-token}"
AUTH="Authorization: Bearer ${TOKEN}"
JSON="Content-Type: application/json"

if ! curl -s --max-time 2 -o /dev/null "${BASE}/"; then
  echo "✗ No Worker on ${BASE}."
  echo "  Run 'make dev' in another terminal first."
  exit 1
fi

api() { curl -s --max-time 15 -X "$1" "${BASE}$2" -H "$AUTH" -H "$JSON" ${3:+-d "$3"}; }

echo "→ Creating a client portal…"
api POST /api/portals '{
  "slug": "acme",
  "name": "Acme Corp",
  "kind": "restricted",
  "description": "Data platform engagement. Deliverables and decision records, newest first."
}' > /dev/null || true

api POST /api/portals/acme/members '{"add": ["cto@acme.com", "vp-eng@acme.com"]}' > /dev/null

echo "→ Publishing a nine-month engagement…"

# A real interactive artifact — Chart.js from a CDN, exactly what Claude produces. If the
# sandbox is working, this renders inside an iframe with an opaque origin and cannot reach
# the API, read your cookies, or touch the shell around it.
CHART_HTML=$(cat <<'HTML'
<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>body{font:15px/1.6 system-ui;margin:2rem;max-width:52rem}h1{letter-spacing:-.02em}
.note{background:#f0ece0;padding:1rem;border-radius:6px;color:#4a3a28}</style></head>
<body>
<h1>Q3 Engineering Review</h1>
<p>Deployment frequency rose through the quarter as the QA restructure landed.</p>
<canvas id="c" height="120"></canvas>
<p class="note"><strong>This is a live Chart.js artifact.</strong> It runs JavaScript and pulls
a library from a CDN — and it is sealed inside a sandboxed iframe with an opaque origin. It
cannot read your session, call the PageVault API, or reach the page around it.</p>
<script>
new Chart(document.getElementById('c'), {
  type: 'line',
  data: { labels: ['Jul','Aug','Sep'], datasets: [{
    label: 'Deploys / week', data: [4, 11, 23],
    borderColor: '#34507a', backgroundColor: 'rgba(52,80,122,.11)', fill: true, tension: .3 }]},
  options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
});
</script>
</body></html>
HTML
)

# confirm:true so re-running the demo updates in place rather than being refused.
#
# Without it, a second `make demo` gets a 409: publishing over an existing (portal, title)
# requires explicit confirmation, because an agent must not be able to clobber a client
# deliverable in one call. That guard is correct — the demo just has to opt in to it, the
# same way a human would after seeing the diff.
publish() {
  jq -n --arg t "$1" --arg s "$2" --arg h "$3" --argjson tags "$4" \
       --argjson owner "${5:-false}" --argjson pub "${6:-false}" --arg p "${7:-acme}" \
    '{portal:$p, title:$t, summary:$s, html:$h, tags:$tags, ownerOnly:$owner, public:$pub, confirm:true}' \
  | curl -s --max-time 20 -X POST "${BASE}/api/docs" -H "$AUTH" -H "$JSON" -d @-
}

publish "Data Warehouse Architecture Review" \
  "Evaluated Debezium vs Fivetran for CDC on V2. Chose Debezium — lower cost, and we already run Kafka." \
  "<h1>Architecture Review</h1><p>We evaluated <b>Debezium</b> and <b>Fivetran</b> for change data capture on V2. We chose Debezium: lower cost at our volume, and we already operate Kafka.</p><p>The retire/wrap/rebuild roadmap is attached.</p>" \
  '["type:architecture","decision"]' > /dev/null

publish "Q3 Engineering Review" \
  "Velocity, incident load, and where the QA restructure landed." \
  "$CHART_HTML" '["type:report"]' > /dev/null

publish "2027 Platform Roadmap" \
  "Not ready for the client yet." \
  "<h1>Draft</h1><p>Do not send.</p>" '["type:roadmap"]' true > /dev/null

# A capability link — one document, no login, and it burns no Access seat.
CAP_URL=$(publish "How We Work" "Engagement model and cadence." \
  "<h1>How we work</h1><p>Weekly cadence, monthly deep-dive.</p>" '[]' false true \
  | jq -r '.publicUrl')

# A PUBLIC PORTAL — a whole collection with no login at all, served from /pub, a path
# Cloudflare Access never sees. This is the "the marketing site is a PageVault deployment"
# idea, and it is the thing sharehtml structurally cannot do: their link mode still sits
# behind Access, so every viewer burns a seat.
echo "→ Creating a public portal (the marketing-site pattern)…"
api POST /api/portals '{
  "slug": "notes",
  "name": "Notes",
  "kind": "public",
  "description": "Public writing. No login, no seat, no wall."
}' > /dev/null || true

PUB_URL=$(publish "Why HTML is the best universal document format" \
  "It renders everywhere and needs no reader." \
  "<h1>Why HTML is the best universal document format</h1><p>It renders everywhere, it needs no reader, and it can carry its own interactivity.</p>" \
  '[]' false false "notes" \
  | jq -r '.url')

echo
echo "─────────────────────────────────────────────────────────────────"
echo "  THE CLIENT PORTAL — this is the only page a client ever sees"
echo
echo "    ${BASE}/v/acme"
echo
echo "  Newest first, grouped by month. Open 'Q3 Engineering Review':"
echo "  a live Chart.js artifact, running JavaScript, sealed in a"
echo "  sandboxed iframe it cannot escape."
echo
echo "  You are seeing the OWNER view (AUTH_MODE=none locally), so the"
echo "  '2027 Platform Roadmap' draft is visible and badged. A real"
echo "  client would not see that row at all."
echo
echo "  A capability link — one document, no login, no seat burned:"
echo
echo "    ${CAP_URL}"
echo
echo "  A PUBLIC PORTAL — a whole collection, served from /pub, which"
echo "  Cloudflare Access never sees. No login wall, no seat consumed,"
echo "  no matter how many people read it. This is how the marketing"
echo "  site can BE a PageVault deployment."
echo
echo "    ${BASE}/pub/notes"
echo "    ${PUB_URL}"
echo "─────────────────────────────────────────────────────────────────"
echo
echo "  Connect Claude to it:"
echo
echo "    claude mcp add --transport http pagevault ${BASE}/mcp \\"
echo "      --header \"Authorization: Bearer ${TOKEN}\""
echo
echo "  Then, in a new Claude Code session, try:"
echo "    \"what did we decide about CDC on V2?\"      → search_portal + read_document"
echo "    \"list my portals\"                           → list_portals"
echo "    \"publish this as 'Q3 Engineering Review'\"   → refuses; asks you to confirm"
echo
