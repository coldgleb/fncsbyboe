/* Командный зачёт: таблица, зачёт владельцев, сводные по этапам */

// Кто приносил очки: в зачёт идут 2 лучших результата команды за этап
function scorersTooltip(t) {
  const top = Object.entries(t.scorers || {})
    .sort((a, b) => b[1].pts - a[1].pts)
    .slice(0, 3)
    .map(([d, sc]) => `${d} — ${sc.pts} очк. за ${sc.rounds} эт.`);
  return top.length ? 'Зачётные результаты:\n' + top.join('\n') : '';
}

function teamTableHtml(standings) {
  const starts = (t, kind) => t.drivers.reduce((n, d) => n + (state.attendance[kind][d]?.size || 0), 0);
  let html = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
<th class="r" style="width:40px">#</th>
<th>Команда</th>
<th class="r">Очки</th>
<th class="r" title="Участий пилотов команды: в гонках / в квалификациях (максимум — пилотов × этапов)">Гонок / Квал.</th>
<th class="r">Пилотов</th>
  </tr></thead><tbody>`;

  for (const t of standings) {
    const rc = t.rank <= 3 ? `rank-${t.rank}` : '';
    html += `<tr class="${rc}">
  <td class="r"><span class="pos-badge">${t.rank}</span></td>
  <td>
    <strong>${teamLink(t.team)}</strong>${coalMark(t.team)}
    <div class="team-drivers">${t.drivers.sort().join(' · ')}</div>
  </td>
  <td class="r" title="${scorersTooltip(t)}"><strong>${t.total}</strong></td>
  <td class="r" style="color:var(--muted)">${starts(t, 'races')} / ${starts(t, 'quals')}</td>
  <td class="r" style="color:var(--muted)">${t.drivers.length}</td>
</tr>`;
  }
  return html + '</tbody></table></div>';
}

function renderOwners() {
  const q = (state.ownerFilter || '').toLowerCase();
  const rows = state.ownerStandings.filter(o =>
    !q || String(o.car).toLowerCase().includes(q) || o.drivers.some(d => d.toLowerCase().includes(q)));

  let html = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
<th class="r" style="width:40px">#</th>
<th>Номер</th>
<th>Пилоты</th>
<th class="r">Очки</th>
<th class="r">Победы</th>
<th class="r" title="Пять лучших финишей">Топ-5</th>
  </tr></thead><tbody>`;

  const page = state.ownerPage || 1;
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  for (const o of rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)) {
    const rc = o.rank <= 3 ? `rank-${o.rank}` : '';
    html += `<tr class="${rc}">
  <td class="r"><span class="pos-badge">${o.rank}</span></td>
  <td><strong>#${o.car}</strong></td>
  <td class="team-text">${o.drivers.sort().join(' · ')}</td>
  <td class="r"><strong>${o.total}</strong></td>
  <td class="r">${o.wins > 0 ? `<strong style="color:#d4af37">${o.wins}</strong>` : '<span style="color:var(--muted)">—</span>'}</td>
  <td class="r" style="color:var(--muted)">${o.top5.join(' · ') || '—'}</td>
</tr>`;
  }
  document.getElementById('table-owners').innerHTML = html + '</tbody></table></div>'
    + paginationHtml(page, pages, `${rows.length} машин`, p => `goOwnerPage(${p})`);
}

function goOwnerPage(p) {
  state.ownerPage = p;
  renderOwners();
}

function filterOwners(val) {
  state.ownerFilter = val;
  state.ownerPage = 1;
  renderOwners();
}

/* Очки команды за каждый этап (накопительный итог — в тултипе). Сортировка — общий
   обработчик data-sort="auto": он читает отрисованный текст, годится и для этой таблицы. */

function renderTeamPivot() {
  const rounds = state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r));
  const q = (state.teamPivotFilter || '').toLowerCase();
  const teams = state.teamStandings.filter(t => !q || t.team.toLowerCase().includes(q));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
    <th class="driver-col">Место · Команда</th>
    ${rounds.map(r => `<th title="${roundFullName(r)}">${roundLabel(r)}</th>`).join('')}
    <th>Итого</th>
  </tr></thead><tbody>`;

  for (const t of teams) {
    html += `<tr class="${t.rank <= 3 ? 'rank-' + t.rank : ''}">
      <td class="driver-cell"><span class="pos-badge">${t.rank}</span> ${teamLink(t.team)}${coalMark(t.team)}</td>`;
    let cum = 0;
    for (const r of rounds) {
      const got = t.roundPts[r] || 0;
      cum += got;
      html += `<td title="${roundFullName(r)}: ${got} очк. · всего ${cum}">${got || '<span style="color:var(--border)">—</span>'}</td>`;
    }
    html += `<td class="total-cell">${t.total}</td></tr>`;
  }
  document.getElementById('pivot-teams').innerHTML = html + '</tbody></table>';
}

function filterTeamPivot(val) {
  state.teamPivotFilter = val;
  renderTeamPivot();
}

// Те же строки и столбцы, но в ячейке — места, которые пошли в зачёт
function renderTeamPosPivot() {
  const rounds = state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r));
  const q = (state.teamPosFilter || '').toLowerCase();
  const teams = state.teamStandings.filter(t => !q || t.team.toLowerCase().includes(q));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
    <th class="driver-col">Место · Команда</th>
    ${rounds.map(r => `<th title="${roundFullName(r)}">${roundLabel(r)}</th>`).join('')}
    <th>Итого</th>
  </tr></thead><tbody>`;

  for (const t of teams) {
    html += `<tr class="${t.rank <= 3 ? 'rank-' + t.rank : ''}">
      <td class="driver-cell"><span class="pos-badge">${t.rank}</span> ${teamLink(t.team)}${coalMark(t.team)}</td>`;
    for (const r of rounds) {
      const best = (t.roundBest[r] || []).filter(x => x.pos != null);
      const maxPos = state.roundMaxPos[r] || 40;
      html += best.length
        ? `<td title="${best.map(x => `${x.driver} P${x.pos} — ${x.pts} очк.`).join('\n')}">`
          + best.map(x => `<span class="pos-cell ${posClass(x.pos, maxPos)}">${x.pos}</span>`).join(' ')
          + '</td>'
        : '<td><span class="pos-cell pos-none">—</span></td>';
    }
    html += `<td class="total-cell">${t.total}</td></tr>`;
  }
  document.getElementById('pivot-teams-pos').innerHTML = html + '</tbody></table>';
}

function filterTeamPosPivot(val) {
  state.teamPosFilter = val;
  renderTeamPosPivot();
}

function renderTeamTab() {
  const standings = state.teamStandings;
  const rounds = state.races.rounds;

  document.getElementById('table-teams').innerHTML = teamTableHtml(standings);

  // Bar chart — top 10
  const top10 = standings.slice(0, 10);
  const barId = 'chart-teams-bar';
  if (state.charts[barId]) state.charts[barId].destroy();
  state.charts[barId] = new Chart(document.getElementById(barId), {
    type: 'bar',
    data: {
      labels: top10.map(t => t.team),
      datasets: [{ data: top10.map(t => t.total), backgroundColor: top10.map((_, i) => COLORS[i % COLORS.length]), borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.raw} pts` } } },
      scales: { x: { grid: { color: '#ffffff0c' }, ticks: { color: '#666' } }, y: { grid: { display: false }, ticks: { color: '#bbb', font: { size: 11 } } } }
    }
  });

  // Line chart — top 5 cumulative
  const lineId = 'chart-teams-line';
  if (state.charts[lineId]) state.charts[lineId].destroy();
  const datasets = standings.slice(0, 5).map((t, i) => {
    let cum = 0;
    return {
      label: t.team,
      borderColor: COLORS[i], backgroundColor: COLORS[i] + '20',
      data: rounds.map(r => { cum += t.roundPts[r] || 0; return cum; }),
      tension: 0.35, pointRadius: 3, fill: false,
    };
  });
  state.charts[lineId] = new Chart(document.getElementById(lineId), {
    type: 'line',
    data: { labels: rounds.map(roundLabel), datasets },
    options: lineChartOptions()
  });
}
