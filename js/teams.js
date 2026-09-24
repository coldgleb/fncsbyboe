/* Командный зачёт: таблица, зачёт владельцев, сводные по этапам */

// Кто приносил очки: в зачёт идут 2 лучших результата команды за этап
function scorersTooltip(t) {
  const top = Object.entries(t.scorers || {})
    .sort((a, b) => b[1].pts - a[1].pts)
    .slice(0, 3)
    .map(([d, sc]) => `${d} — ${sc.pts} очк. за ${sc.rounds} эт.`);
  return top.length ? 'Зачётные результаты:\n' + top.join('\n') : '';
}

function teamTableHtml(standings, q) {
  const starts = (t, kind) => t.drivers.reduce((n, d) => n + (state.attendance[kind][d]?.size || 0), 0);
  const rows = standings.filter(t => hit(q, t.team, ...t.drivers));
  let html = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
<th class="r w-40">#</th>
<th>Команда</th>
<th class="r">Очки</th>
<th class="r" title="Участий пилотов команды: в гонках / в квалификациях (максимум — пилотов × этапов)">Гонок / Квал.</th>
<th class="r">Пилотов</th>
  </tr></thead><tbody>`;

  for (const t of spoilerRows('teams', rows, q)) {
    const rc = t.rank <= 3 ? `rank-${t.rank}` : '';
    html += `<tr class="${rc}">
  <td class="r"><span class="pos-badge">${t.rank}</span></td>
  <td>
    <strong>${teamLink(t.team)}</strong>${coalMark(t.team)}
    <div class="team-drivers">${t.drivers.sort().map(driverLink).join(' · ')}</div>
  </td>
  <td class="r" title="${scorersTooltip(t)}">${penMark(t)}<strong>${t.total}</strong></td>
  <td class="r muted">${starts(t, 'races')} / ${starts(t, 'quals')}</td>
  <td class="r muted">${t.drivers.length}</td>
</tr>`;
  }
  return html + '</tbody></table></div>' + spoilerHtml('teams', rows.length);
}

function renderTeams() {
  document.getElementById('table-teams').innerHTML = teamTableHtml(state.teamStandings, state.teamFilter);
}

// Полный зачёт, без учёта поискового фильтра на экране
function exportTeamsXLSX() {
  const starts = (t, kind) => t.drivers.reduce((n, d) => n + (state.attendance[kind][d]?.size || 0), 0);
  downloadTableXLSX(state.teamStandings, [
    ['#', t => t.rank],
    ['Команда', t => t.team],
    ['Очки', t => t.total],
    ['Гонок', t => starts(t, 'races')],
    ['Квал.', t => starts(t, 'quals')],
    ['Пилотов', t => t.drivers.length],
  ], 'Командный зачёт', `${exportSeriesLabel()} командный зачёт.xlsx`);
}

function filterTeams(val) {
  state.teamFilter = val;
  renderTeams();
}

// Зачёт владельцев на этап считает сервер — тем же кодом, что раньше работал здесь

function ownersAt() {
  const rounds = roundsOf('owners');
  return state.upTo.owners ?? rounds[rounds.length - 1];
}

function setOwnersUpTo(val) {
  const rounds = roundsOf('owners'), n = parseFloat(val);
  state.upTo.owners = n === rounds[rounds.length - 1] ? null : n;
  renderOwners();
}

function setOwnersChase(val) {
  state.chaseView.owners = val;
  renderOwners();
}

async function renderOwners() {
  const at = ownersAt();
  const isChase = isChaseMode('owners', at);
  const wrap = document.getElementById('table-owners');
  const cut = state.slices[sliceKey('owners', at)];
  if (!cut) {
    if (!wrap.innerHTML) wrap.innerHTML = '<div class="loading-state"><div class="spinner"></div> Загрузка…</div>';
    await fetchSlice('owners', at);
    return renderOwners();
  }
  document.getElementById('upto-owners').innerHTML = `<div class="table-upto">
  <label>Зачёт после этапа:
    <select class="chart-select" onchange="setOwnersUpTo(this.value)">
      ${roundsOf('owners').map(r => `<option value="${r}"${r === at ? ' selected' : ''}>${roundFullName(r)}</option>`).join('')}
    </select>
  </label>
  ${at > CHASE_START ? `
  <div class="round-toggle inline">
    <button class="rtog-btn${!isChase ? ' rtog-active' : ''}" onclick="setOwnersChase('regular')">Регулярный сезон</button>
    <button class="rtog-btn${isChase ? ' rtog-active' : ''}" onclick="setOwnersChase('chase')">Чейз</button>
  </div>` : ''}
</div>`;
  const rows = cut.standings.filter(o => hit(state.ownerFilter, o.car, ...o.drivers));

  let html = `<div class="table-scroll"><table class="standings-table" data-sort="auto"><thead><tr>
<th class="r w-40">#</th>
<th class="r">Номер</th>
<th>Команда</th>
<th>Авт.</th>
<th>Пилоты</th>
<th class="r" title="Пять лучших финишей">Топ-5</th>
<th class="r">Очки</th>
  </tr></thead><tbody>`;

  for (const o of spoilerRows('owners', rows, state.ownerFilter)) {
    const rc = o.rank <= 3 ? `rank-${o.rank}` : '';
    html += `<tr class="${rc}">
  <td class="r"><span class="pos-badge">${o.rank}</span></td>
  <td class="r">${carBadge(o.car, o.mfr)}</td>
  <td class="team-text">${teamLink(o.team)}${coalMark(o.team)}</td>
  <td>${mfrBadge(o.mfr)}</td>
  <td class="team-text">${o.drivers.sort().map(driverLink).join(' · ')}</td>
  <td class="r muted">${o.top5.join(' · ') || '—'}</td>
  <td class="r"><strong>${o.total}</strong></td>
</tr>`;
  }
  document.getElementById('table-owners').innerHTML = html + '</tbody></table></div>'
    + spoilerHtml('owners', rows.length);
}

// Все машины целиком, без пагинации и поиска на экране
async function exportOwnersXLSX() {
  const at = ownersAt();
  downloadTableXLSX((await fetchSlice('owners', at)).standings, [
    ['#', o => o.rank],
    ['Номер', o => o.car],
    ['Команда', o => o.team],
    ['Авт.', o => o.mfr],
    ['Пилоты', o => o.drivers.join(' · ')],
    ['Топ-5', o => o.top5.join(' · ')],
    ['Очки', o => o.total],
  ], 'Зачёт владельцев', `${exportSeriesLabel()} зачёт владельцев.xlsx`);
}

function filterOwners(val) {
  state.ownerFilter = val;
  renderOwners();
}

/* Очки команды за каждый этап (накопительный итог — в тултипе). Сортировка — общий
   обработчик data-sort="auto": он читает отрисованный текст, годится и для этой таблицы. */

// В сводных показываются все команды; у той, что вне зачёта, места нет
const teamPlaceBadge = t => t.rank == null
  ? '<span class="pos-badge" title="Вне командного зачёта: только гостевые пилоты">—</span>'
  : `<span class="pos-badge">${t.rank}</span>`;

function renderTeamPivot() {
  const rounds = state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r));
  const teams = state.teamPivot.filter(t => hit(state.teamPivotFilter, t.team, ...t.drivers));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
    <th class="driver-col">Место · Команда</th>
    ${rounds.map(r => `<th title="${roundFullName(r)}">${roundLabel(r)}</th>`).join('')}
    <th>Итого</th>
  </tr></thead><tbody>`;

  for (const t of spoilerRows('teamPivot', teams, state.teamPivotFilter)) {
    html += `<tr class="${t.rank <= 3 ? 'rank-' + t.rank : ''}">
      <td class="driver-cell">${teamPlaceBadge(t)} ${teamLink(t.team)}${coalMark(t.team)}</td>`;
    let cum = 0;   // накопленное со штрафом с его этапа — из базы (cumPts)
    for (const r of rounds) {
      const got = t.roundPts[r] || 0;
      cum = t.cumPts[r] ?? cum;
      html += `<td title="${roundFullName(r)}: ${got} очк. · всего ${cum}">${got || '<span class="pos-none">—</span>'}</td>`;
    }
    html += `<td class="total-cell">${t.total}</td></tr>`;
  }
  document.getElementById('pivot-teams').innerHTML = html + '</tbody></table>' + spoilerHtml('teamPivot', teams.length);
  // штрафы показываем сноской: в самой таблице остаются только набранные очки
  const penalties = state.teamPivot.filter(t => t.penalty);
  document.getElementById('pivot-teams-note').innerHTML = penalties.length
    ? 'Штрафы: ' + penalties.map(t => `<b>${t.team}</b> — снято ${t.penalty} очк.`
      + (t.penaltyRound != null ? ` с ${fmtRoundNum(t.penaltyRound)} этапа` : '')
      + (t.penaltyReason ? ` (${t.penaltyReason})` : '')).join('; ')
    : '';
}

function filterTeamPivot(val) {
  state.teamPivotFilter = val;
  renderTeamPivot();
}

// Те же строки и столбцы, но в ячейке — места, которые пошли в зачёт
function renderTeamPosPivot() {
  const rounds = state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r));
  const teams = state.teamPivot.filter(t => hit(state.teamPosFilter, t.team, ...t.drivers));

  let html = `<table class="pivot-table" data-sort="auto"><thead><tr>
    <th class="driver-col">Место · Команда</th>
    ${rounds.map(r => `<th title="${roundFullName(r)}">${roundLabel(r)}</th>`).join('')}
    <th>Итого</th>
  </tr></thead><tbody>`;

  for (const t of spoilerRows('teamPosPivot', teams, state.teamPosFilter)) {
    html += `<tr class="${t.rank <= 3 ? 'rank-' + t.rank : ''}">
      <td class="driver-cell">${teamPlaceBadge(t)} ${teamLink(t.team)}${coalMark(t.team)}</td>`;
    for (const r of rounds) {
      const best = (t.roundBest[r] || []).filter(x => x.pos != null);
      const maxPos = state.roundMaxPos[r] || 40;
      html += best.length
        ? `<td title="${best.map(x => `${x.driver} P${x.pos} — ${x.pts} очк.`).join('\n')}">`
          + best.map(x => `<span class="pos-cell ${posClass(x.pos, maxPos)}">${x.pos}</span>`).join(' ')
          + '</td>'
        : '<td><span class="pos-cell pos-none">—</span></td>';
    }
    html += `<td class="total-cell">${penMark(t)}${t.total}</td></tr>`;
  }
  document.getElementById('pivot-teams-pos').innerHTML = html + '</tbody></table>' + spoilerHtml('teamPosPivot', teams.length);
}

function filterTeamPosPivot(val) {
  state.teamPosFilter = val;
  renderTeamPosPivot();
}

function renderTeamTab() {
  const standings = state.teamStandings;
  const rounds = state.races.rounds;

  renderTeams();

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
      scales: {
        x: { grid: { color: themeColor('--row-line') }, ticks: { color: themeColor('--muted') } },
        y: { grid: { display: false }, ticks: { color: themeColor('--text2'), font: { size: 11 } } },
      }
    }
  });

  // Line chart — top 5 cumulative
  const lineId = 'chart-teams-line';
  if (state.charts[lineId]) state.charts[lineId].destroy();
  const datasets = standings.slice(0, 5).map((t, i) => {
    let last = 0;   // накопленные очки со штрафом с его этапа — из базы (cumPts)
    return {
      label: t.team,
      borderColor: COLORS[i], backgroundColor: COLORS[i] + '20',
      data: rounds.map(r => (last = t.cumPts[r] ?? last)),
      tension: 0.35, pointRadius: 3, fill: false,
    };
  });
  state.charts[lineId] = new Chart(document.getElementById(lineId), {
    type: 'line',
    data: { labels: rounds.map(roundLabel), datasets },
    options: lineChartOptions()
  });
}
