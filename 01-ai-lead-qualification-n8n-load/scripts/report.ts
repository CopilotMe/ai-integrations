import type { ProcessResult } from '../src/pipeline/process-lead.js';

export interface ReportRow {
  label: string;
  note: string;
  result: ProcessResult | null;
  rejection: string | null;
}

export interface ReportInput {
  rows: ReportRow[];
  generatedAt: Date;
  providers: { llm: string; crm: string; notifier: string };
  totals: { contacts: number; deals: number; notifications: number };
}

/**
 * Renders the demo run as a single self-contained HTML file — no external CSS,
 * fonts or scripts, so it opens from disk and can be committed to the repo or
 * published as a GitHub Pages artefact.
 */
export function renderReport(input: ReportInput): string {
  const { rows, generatedAt, providers, totals } = input;
  const processed = rows.filter((r) => r.result).map((r) => r.result!);
  const count = (c: string) => processed.filter((r) => r.qualification.classification === c).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Lead Qualification — demo run</title>
<style>
  :root {
    --bg: #f7f7f5; --panel: #fff; --ink: #1a1a18; --muted: #6b6b66;
    --line: #e3e3de; --accent: #b5541f;
    --hot-bg: #fdeee6; --hot-ink: #a8410f; --warm-bg: #fdf5e0; --warm-ink: #8a6512;
    --cold-bg: #eaeff4; --cold-ink: #3f5a73; --rej-bg: #f2eaea; --rej-ink: #8a3b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a; --panel: #1e1e23; --ink: #ececea; --muted: #9a9a94;
      --line: #33333a; --accent: #e08454;
      --hot-bg: #3a2015; --hot-ink: #f0a077; --warm-bg: #362c14; --warm-ink: #e0bd72;
      --cold-bg: #1c2833; --cold-ink: #93b4d0; --rej-bg: #33201f; --rej-ink: #dd9a9a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem 4rem; background: var(--bg); color: var(--ink);
    font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  header { border-bottom: 2px solid var(--ink); padding-bottom: 1.25rem; margin-bottom: 2rem; }
  h1 { margin: 0 0 .35rem; font-size: 1.6rem; letter-spacing: -.02em; }
  .sub { color: var(--muted); font-size: .9rem; }
  .sub code { background: var(--panel); border: 1px solid var(--line); padding: .1rem .35rem; border-radius: 4px; font-size: .85em; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .75rem; margin-bottom: 2rem; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: .85rem 1rem; }
  .tile .n { font-size: 1.7rem; font-weight: 650; line-height: 1.1; letter-spacing: -.02em; }
  .tile .k { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; margin-top: .2rem; }
  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  table { width: 100%; border-collapse: collapse; min-width: 760px; }
  th { text-align: left; font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: .8rem 1rem; border-bottom: 1px solid var(--line); font-weight: 600; }
  td { padding: .9rem 1rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  .lead-name { font-weight: 600; }
  .lead-note { color: var(--muted); font-size: .82rem; margin-top: .2rem; max-width: 30ch; }
  .badge { display: inline-block; padding: .15rem .55rem; border-radius: 99px; font-size: .75rem; font-weight: 650; letter-spacing: .02em; white-space: nowrap; }
  .HOT { background: var(--hot-bg); color: var(--hot-ink); }
  .WARM { background: var(--warm-bg); color: var(--warm-ink); }
  .COLD { background: var(--cold-bg); color: var(--cold-ink); }
  .REJECTED { background: var(--rej-bg); color: var(--rej-ink); }
  .score { display: flex; align-items: center; gap: .5rem; }
  .bar { width: 54px; height: 5px; border-radius: 99px; background: var(--line); overflow: hidden; flex: none; }
  .bar i { display: block; height: 100%; background: var(--accent); }
  .num { font-variant-numeric: tabular-nums; font-weight: 600; }
  code.rule { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; color: var(--muted); word-break: break-word; }
  .flag { display: inline-block; font-size: .7rem; padding: .05rem .4rem; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); margin-top: .3rem; }
  details { margin-top: 2rem; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.25rem; }
  summary { cursor: pointer; font-weight: 600; }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; overflow-x: auto; font-size: .82rem; line-height: 1.55; margin: .9rem 0 0; }
  footer { margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .82rem; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>AI Lead Qualification &amp; Routing</h1>
    <p class="sub">
      Demo run · ${escapeHtml(generatedAt.toISOString().replace('T', ' ').slice(0, 19))} UTC ·
      providers <code>llm=${escapeHtml(providers.llm)}</code>
      <code>crm=${escapeHtml(providers.crm)}</code>
      <code>notifier=${escapeHtml(providers.notifier)}</code>
    </p>
  </header>

  <div class="tiles">
    ${tile(rows.length, 'leads in')}
    ${tile(count('HOT'), 'hot')}
    ${tile(count('WARM'), 'warm')}
    ${tile(count('COLD'), 'cold')}
    ${tile(rows.filter((r) => r.rejection).length, 'rejected')}
    ${tile(totals.contacts, 'crm contacts')}
    ${tile(totals.deals, 'crm deals')}
    ${tile(totals.notifications, 'slack alerts')}
  </div>

  <div class="scroll">
    <table>
      <thead><tr>
        <th>Lead</th><th>Class</th><th>Score</th><th>Next action</th>
        <th>CRM</th><th>Deciding rule</th>
      </tr></thead>
      <tbody>${rows.map(renderRow).join('')}</tbody>
    </table>
  </div>

  ${rows.filter((r) => r.result?.suggested_reply).map(renderReply).join('')}

  <details>
    <summary>Full decision trace for lead #1 — what the routing layer recorded</summary>
    <pre>${escapeHtml(JSON.stringify(processed[0]?.qualification.explanation ?? {}, null, 2))}</pre>
  </details>

  <footer>
    Generated by <code>npm run demo</code> from <code>demo/leads.json</code>.
    Every external system is an offline fake — no API keys, no network, no cost.
    The routing decisions shown are produced by the same code path that runs in production.
  </footer>
</div>
</body>
</html>
`;
}

function tile(n: number, label: string): string {
  return `<div class="tile"><div class="n">${n}</div><div class="k">${escapeHtml(label)}</div></div>`;
}

function renderRow(row: ReportRow): string {
  const head = `<td><div class="lead-name">${escapeHtml(row.label)}</div><div class="lead-note">${escapeHtml(row.note)}</div></td>`;

  if (!row.result) {
    return `<tr>${head}
      <td><span class="badge REJECTED">REJECTED</span></td>
      <td class="num">—</td><td>—</td><td>—</td>
      <td><code class="rule">${escapeHtml(row.rejection ?? '')}</code></td></tr>`;
  }

  const q = row.result.qualification;
  const crm = [
    row.result.crm.contact ? `contact ${row.result.crm.contact.existing ? 'existing' : 'new'}` : null,
    row.result.crm.deal ? `deal ${row.result.crm.deal.existing ? 'existing' : 'new'}` : 'no deal',
  ]
    .filter(Boolean)
    .join('<br>');

  const flags = [
    q.explanation.overrode_model ? '<span class="flag">rules overrode model</span>' : '',
    q.explanation.degraded ? '<span class="flag">degraded — no AI</span>' : '',
  ].join(' ');

  return `<tr>${head}
    <td><span class="badge ${q.classification}">${q.classification}</span></td>
    <td><div class="score"><span class="num">${q.score}</span><span class="bar"><i style="width:${q.score}%"></i></span></div></td>
    <td>${escapeHtml(q.next_action.replace(/_/g, ' '))}</td>
    <td style="font-size:.82rem;color:var(--muted)">${crm}</td>
    <td><code class="rule">${escapeHtml(q.explanation.applied_rule)}</code>${flags}</td></tr>`;
}

function renderReply(row: ReportRow): string {
  return `<details>
    <summary>Suggested reply drafted for “${escapeHtml(row.label)}” — a draft for a human to review, never sent automatically</summary>
    <pre>${escapeHtml(row.result?.suggested_reply ?? '')}</pre>
  </details>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
