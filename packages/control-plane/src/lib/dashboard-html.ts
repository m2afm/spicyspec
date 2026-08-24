/**
 * The manager dashboard — one self-contained HTML page, no framework, no external asset.
 *
 * A team member opens it and sees, live: every spec with its status/stage/gate, the run
 * history with cost and the second-vendor honesty verdict per run, the gate trail, and the
 * one action a human owns — approving or rejecting a review, guarded by the per-session
 * CSRF token embedded here (prototype B32). It polls the read API; the approve button POSTs
 * with the token. Deliberately plain and legible on a phone (prototype B42: the dashboard
 * was once unreadable at 360px, which is exactly where a founder checks it).
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

export function renderDashboard(projectName: string, csrfToken: string): string {
  const title = escapeHtml(projectName);
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} - spicyspec</title>
<style>
  :root {
    --bg: #0b0d12; --panel: #141821; --line: #232a37; --text: #e6e9ef; --muted: #93a0b4;
    --accent: #6ea8fe; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f8fa; --panel:#fff; --line:#d0d7de; --text:#1f2328; --muted:#57606a; --accent:#0969da; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
  header { padding: 16px 20px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; }
  .muted { color: var(--muted); }
  main { padding: 16px 20px; display: grid; gap: 20px; max-width: 1100px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .scroll { overflow-x: auto; }
  button { font: inherit; padding: 5px 12px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
  button.approve { border-color: var(--ok); color: var(--ok); }
  button.reject { border-color: var(--bad); color: var(--bad); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  code { background: var(--bg); padding: 1px 5px; border-radius: 4px; }
  @media (max-width: 560px) { th:nth-child(n+4), td:nth-child(n+4) { display: none; } }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <span class="muted" id="sub">loading&hellip;</span>
  <span class="muted" style="margin-left:auto" id="clock"></span>
</header>
<main>
  <section><h2>Specs</h2><div class="scroll"><table id="specs"><tbody></tbody></table></div></section>
  <section><h2>Awaiting your review</h2><div id="review">&mdash;</div></section>
  <section><h2>Runs</h2><div class="scroll"><table id="runs"><tbody></tbody></table></div></section>
  <section><h2>Runners</h2><div id="runners" class="muted">&mdash;</div></section>
</main>
<script>
  const CSRF = ${JSON.stringify(csrfToken)};
  const gateClass = { approved: 'ok', open: 'warn', unknown: 'muted' };
  const honestClass = (h) => h === false ? 'bad' : h === true ? 'ok' : 'muted';
  // Store values are runner-written, not arbitrary-user, but every interpolated field is
  // escaped before it reaches innerHTML — a dashboard must never be an injection sink.
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const attr = (v) => encodeURIComponent(String(v));

  async function getJSON(u) { const r = await fetch(u, { cache: 'no-store' }); return r.json(); }

  async function review(id, approved) {
    const note = approved ? (prompt('Note (optional): journey walked?') ?? '') : (prompt('Reason for rejecting:') ?? '');
    const r = await fetch('/api/specs/' + encodeURIComponent(id) + '/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
      body: JSON.stringify({ approved, note, by: 'dashboard' }),
    });
    if (!r.ok) { alert('failed: ' + (await r.json()).error); return; }
    refresh();
  }

  function render(ov, runs) {
    document.getElementById('sub').textContent =
      Object.entries(ov.counts).map(([k, v]) => v + ' ' + k).join(' \u00b7 ') +
      '  \u2014  ' + ov.totals.runs + ' runs, $' + ov.totals.costUsd.toFixed(2) + ' notional';
    document.getElementById('clock').textContent = new Date(ov.generatedAt).toLocaleTimeString();

    document.querySelector('#specs tbody').innerHTML =
      '<tr><th>Spec</th><th>Status</th><th>Stage</th><th>Closing gate</th></tr>' +
      ov.specs.map((s) =>
        '<tr><td><code>' + esc(s.id) + '</code></td><td>' + esc(s.status) + '</td><td>' + esc(s.stage || '—') +
        '</td><td class="' + (gateClass[s.closingGate] || 'muted') + '">' + esc(s.closingGate) + '</td></tr>'
      ).join('');

    const rev = document.getElementById('review');
    rev.innerHTML = ov.awaitingReview.length
      ? ov.awaitingReview.map((id) =>
          '<div class="row" style="margin:6px 0"><code>' + esc(id) + '</code>' +
          '<button class="approve" data-id="' + attr(id) + '" data-ok="1">Approve</button>' +
          '<button class="reject" data-id="' + attr(id) + '" data-ok="0">Reject</button>' +
          '<span class="muted">walk the journey by clicking before you approve</span></div>'
        ).join('')
      : '<span class="muted">nothing waiting</span>';
    rev.querySelectorAll('button[data-id]').forEach((b) =>
      b.addEventListener('click', () => review(decodeURIComponent(b.dataset.id), b.dataset.ok === '1'))
    );

    document.querySelector('#runs tbody').innerHTML =
      '<tr><th>#</th><th>Exit</th><th>$</th><th>Tasks</th><th>Acct</th><th>Judge</th></tr>' +
      runs.slice().reverse().map((r) =>
        '<tr><td>' + esc(r.tick) + '</td><td>' + esc(r.exit || '—') + '</td><td>' +
        (r.costUsd == null ? '?' : '$' + r.costUsd.toFixed(2)) + '</td><td>' + esc(r.tasksClosed ?? '—') +
        '</td><td>' + esc(r.account || '—') + '</td><td class="' + honestClass(r.judgeHonest) + '">' +
        (r.judgedBy ? (r.judgeHonest === false ? 'dishonest' : 'ok') + ' (' + esc(r.judgedBy) + ')' : '—') +
        '</td></tr>'
      ).join('');
  }

  function renderRunners(runners) {
    const el = document.getElementById('runners');
    el.innerHTML = runners.length
      ? runners.map((r) =>
          '<div class="row" style="margin:4px 0"><code>' + esc(r.host) + '</code>' +
          '<span class="' + (r.stale ? 'bad' : 'ok') + '">' + (r.stale ? 'stale' : 'alive') + '</span>' +
          '<span class="muted">queue ' + esc(r.taskQueue) + ' · accounts ' + esc(r.accounts.join(', ')) +
          ' · beat ' + esc(new Date(r.heartbeatAt).toLocaleTimeString()) + '</span></div>'
        ).join('')
      : '<span class="muted">no runners registered</span>';
  }

  async function refresh() {
    try {
      render(await getJSON('/api/overview'), await getJSON('/api/runs?limit=40'));
      renderRunners(await getJSON('/api/runners'));
    }
    catch (e) { document.getElementById('sub').textContent = 'connection lost'; }
  }
  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
