/* Injected only by local_preview.js at /selftest.html. Drives real UI clicks
   against the live base, then reverts. Results are written into <pre id=selftest>
   so headless --dump-dom can capture them. Never deployed. */
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = [];
  const log = (k, v) => out.push(k + '=' + v);
  const pre = document.createElement('pre');
  pre.id = 'selftest';
  document.body.appendChild(pre);

  const serverVal = async (job, field) => {
    const d = await (await fetch('/api/jobs?refresh=1')).json();
    const rec = d.jobs.find(j => j.fields['Job #'] === job);
    return rec ? rec.fields[field] : '<<no record>>';
  };

  try {
    for (let i = 0; i < 60 && !document.querySelector('tbody tr'); i++) await sleep(500);
    const row = document.querySelector('tbody tr');
    if (!row) { log('FATAL', 'no rows rendered'); pre.textContent = out.join('\n'); return; }
    const job = row.querySelector('td').innerText.trim();
    log('job', job);

    // ---- checkbox click -> save (custom span.cb inside an editable td) ----
    const cbCell = row.querySelector('td.ed .cb') ? row.querySelector('td.ed') : null;
    const cellOf = () => document.querySelector('tbody tr td.ed');
    log('cb_cell_found', !!cbCell);
    log('cb_cell_tabindex', cbCell ? cbCell.getAttribute('tabindex') : 'n/a');
    log('cb_aria_role', cbCell ? (cbCell.getAttribute('role') || 'none') : 'n/a');
    if (cbCell) {
      const before = cbCell.querySelector('.cb').classList.contains('on');
      log('ui_before', before);
      cbCell.click();
      await sleep(3500);
      log('ui_after_click', cellOf().querySelector('.cb').classList.contains('on'));
      log('server_after_click', await serverVal(job, 'QA Ready'));
      log('row_indicator', (document.querySelector('tbody tr').innerText
        .match(/saving|saved|error|fail/i) || ['none'])[0]);

      cellOf().click();
      await sleep(3500);
      log('server_after_revert', await serverVal(job, 'QA Ready'));
      log('back_to_original',
        !!(await serverVal(job, 'QA Ready')) === !!before);
    }

    // ---- read-only cell must not be editable ----
    const heads = [...document.querySelectorAll('thead th')].map(t => t.innerText.trim());
    const coeIdx = heads.findIndex(h => /Est COE/i.test(h));
    const bodyCells = [...row.querySelectorAll('td')];
    const roCell = coeIdx >= 0 ? bodyCells[coeIdx - (heads.length - bodyCells.length)] : null;
    if (roCell) {
      roCell.click();
      await sleep(600);
      log('readonly_cell_spawned_input', roCell.querySelectorAll('input,select,textarea').length);
    }

    // ---- filter chip + URL state ----
    const chip = [...document.querySelectorAll('button,[role=button],label')]
      .find(b => /Constr\.? Risk/i.test(b.innerText || ''));
    if (chip) {
      chip.click();
      await sleep(800);
      log('risk_chip_rows', document.querySelectorAll('tbody tr').length);
      log('url_has_state', location.search.length > 1);
      chip.click();
      await sleep(800);
      log('rows_restored', document.querySelectorAll('tbody tr').length);
    }
  } catch (e) {
    log('EXCEPTION', e && e.message);
  }
  pre.textContent = out.join('\n');
})();
