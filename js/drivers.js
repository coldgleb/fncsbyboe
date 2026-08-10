/* Личные зачёты: итоговая таблица, сортировка, сводная Пилот · Этап · Позиция */

function driverTooltip(s) {
  return [
    `Тай-брейк: ${s.wins} побед` + (s.firstWin !== Infinity ? ` · 1-я победа R${fmtRoundNum(s.firstWin)}` : '') + ` · ${s.sheetPts} очков за прогноз`,
    `Сред. позиция: ${avgPos(s)}`,
    `Топ-5: ${s.top5} · Топ-10: ${s.top10}`,
  ].join('\n');
}

function renderTable(type) {
  const wrap = document.getElementById(`table-${type}`);
  const all = state[type].standings;
  const q = state.filter[type].toLowerCase();
  const filtered = q
    ? all.filter(s => s.driver.toLowerCase().includes(q) || s.team.toLowerCase().includes(q))
    : all;

  // Чейз считается только в общих зачётах, не в зачёте независимых
  const withChase = !type.startsWith('ind');
  const playoffSet = withChase ? buildPlayoffSet(type) : new Set();
  // первый претендент вне Чейза (граница отсечки) и последний из Чейза
  const cutoffDriver = withChase ? all.find(s => !playoffSet.has(s.driver) && qualEligible(s.driver)) : null;
  const chase = all.filter(s => playoffSet.has(s.driver));
  const lastChase = chase[chase.length - 1];

  const gapCell = s => {
    const dash = '<span style="color:var(--muted)">—</span>';
    if (!qualEligible(s.driver)) return dash;
    if (playoffSet.has(s.driver))
      return cutoffDriver ? `<span style="color:#2ecc71;font-weight:700">+${s.total - cutoffDriver.total}</span>` : dash;
    return lastChase ? `<span style="color:#e63946;font-weight:700">${s.total - lastChase.total}</span>` : dash;
  };

  const sort = state.sort[type];
  const rows = sort
    ? [...filtered].sort((a, b) => {
      const va = SORT_KEYS[sort.key](a), vb = SORT_KEYS[sort.key](b);
      return sort.dir === 'asc' ? va - vb : vb - va;
    })
    : filtered;

  const sortTh = (key, label, attrs = '') => {
    const arrow = sort && sort.key === key ? ` <span class="sort-arrow">${sort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    return `<th class="r sortable" ${attrs} onclick="sortTable('${type}','${key}')">${label}${arrow}</th>`;
  };

  const page = state.page[type];
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  let html = `<div class="table-scroll"><table class="standings-table"><thead><tr>
<th style="width:40px" class="r">#</th>
<th>Гонщик</th>
<th>Команда</th>
<th>Авт.</th>
${sortTh('total', 'Очки')}
${withChase ? '<th class="r" title="В Чейзе — преимущество над первым вне Чейза; вне Чейза — отставание от последнего из Чейза">± Чейз</th>' : ''}
${sortTh('wins', 'Победы', 'title="Количество побед (тай-брейк 1)"')}
${sortTh('starts', 'Гонок / Квал.', 'title="Проходов в гонку / участий в квалификации"')}
${sortTh('best', 'Лучш.')}
  </tr></thead><tbody>`;

  for (const s of slice) {
    const inPlayoff = playoffSet.has(s.driver);
    const isCutoff = cutoffDriver && s.driver === cutoffDriver.driver;
    const rc = [
      s.rank <= 3 ? `rank-${s.rank}` : '',
      inPlayoff ? 'row-playoff' : '',
      isCutoff ? 'row-cutoff' : '',
    ].filter(Boolean).join(' ');

    const winsCell = s.wins > 0
      ? `<strong style="color:#d4af37">${s.wins}</strong>`
      : `<span style="color:var(--muted)">—</span>`;
    const tb = driverTooltip(s);
    html += `<tr class="${rc}" title="${tb}">
  <td class="r"><span class="pos-badge">${s.rank}</span></td>
  <td><strong class="driver-link" onclick="openDriver('${s.driver.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">${s.driver}</strong></td>
  <td class="team-text">${s.team}${coalMark(s.team)}</td>
  <td>${mfrBadge(s.mfr)}</td>
  <td class="r"><strong>${s.total}</strong></td>
  ${withChase ? `<td class="r">${gapCell(s)}</td>` : ''}
  <td class="r">${winsCell}</td>
  <td class="r" style="color:var(--muted)">${state.attendance.races[s.driver]?.size || 0} / ${state.attendance.quals[s.driver]?.size || 0}</td>
  <td class="r" style="color:var(--muted)">${s.best === Infinity ? '—' : 'P' + s.best}</td>
</tr>`;
  }

  html += '</tbody></table></div>'
    + paginationHtml(page, pages, `${rows.length} участников`, p => `goPage('${type}',${p})`);

  wrap.innerHTML = html;
}

const SORT_KEYS = {
  total: s => s.total,
  wins: s => s.wins,
  starts: s => state.attendance.races[s.driver]?.size || 0,
  best: s => s.best,
};

// Клик: по возрастанию, повторный — по убыванию, третий — назад к местам в чемпионате
function sortTable(type, key) {
  const cur = state.sort[type];
  state.sort[type] = !cur || cur.key !== key ? { key, dir: 'asc' }
    : cur.dir === 'asc' ? { key, dir: 'desc' }
      : null;
  state.page[type] = 1;
  renderTable(type);
}

function filterTable(type, val) {
  state.filter[type] = val;
  state.page[type] = 1;
  renderTable(type);
}

function goPage(type, p) {
  state.page[type] = p;
  renderTable(type);
}

function buildPivotData(type) {
  const rows = state[type].rows;
  const rounds = state[type].rounds;
  const standings = state[type].standings;

  const map = {};
  for (const r of rows) {
    const d = r['Driver'];
    const rnd = r['Round'];
    const pos = r['Pos.'];
    if (!d || rnd == null || pos == null) continue;
    if (!map[d]) map[d] = {};
    if (map[d][rnd] == null || pos < map[d][rnd]) map[d][rnd] = pos;
  }

  // For races pivot: build qual map (round → driver → qual pos)
  let qualMap = null;
  if (type === 'races') {
    qualMap = {};
    for (const r of state.quals.rows) {
      const d = r['Driver'];
      const rnd = r['Round'];
      const pos = r['Pos.'];
      if (!d || rnd == null || pos == null) continue;
      if (!qualMap[d]) qualMap[d] = {};
      if (qualMap[d][rnd] == null || pos < qualMap[d][rnd]) qualMap[d][rnd] = pos;
    }
  }

  const order = standings.map(s => s.driver);
  return { map, rounds, order, qualMap };
}

function renderPivot(type) {
  const wrap = document.getElementById(`pivot-${type}`);
  const { map, rounds, order, qualMap } = buildPivotData(type);
  const q = state.pivot[type].toLowerCase();
  const qt = state.pivotTeam[type].toLowerCase();
  const teamOf = Object.fromEntries(state[type].standings.map(s => [s.driver, s.team]));
  const drivers = order.filter(d =>
    (!q || d.toLowerCase().includes(q)) &&
    (!qt || (teamOf[d] || '').toLowerCase().includes(qt))
  );

  let html = `<table class="pivot-table"><thead><tr>
<th class="driver-col">Пилот</th>
${rounds.map(r => `<th>${roundLabel(r)}</th>`).join('')}
<th>Итого</th>
  </tr></thead><tbody>`;

  for (const driver of drivers) {
    const dmap = map[driver] || {};
    const qmap = qualMap ? (qualMap[driver] || {}) : null;
    const total = rounds.reduce((s, r) => s + scorePts(dmap[r], r), 0);
    html += `<tr><td class="driver-cell">${driver}${coalMark(teamOf[driver])}</td>`;
    for (const r of rounds) {
      const pos = dmap[r];
      const qpos = qmap ? qmap[r] : null;
      const maxPos = state.roundMaxPos[r] || 40;
      const raceCell = pos == null
        ? `<span class="pos-cell pos-none">—</span>`
        : `<span class="pos-cell ${posClass(pos, maxPos)}">${pos}</span>`;
      const qualCell = qmap == null ? '' : qpos == null
        ? `<span class="pivot-qpos pos-none">—</span>`
        : `<span class="pivot-qpos" style="color:${qpos <= maxPos ? '#2ecc71' : '#e63946'}">${qpos}</span>`;
      html += `<td>${raceCell}${qualCell}</td>`;
    }
    html += `<td class="total-cell">${total}</td></tr>`;
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function filterPivot(type, val) {
  state.pivot[type] = val;
  renderPivot(type);
}

function filterPivotTeam(type, val) {
  state.pivotTeam[type] = val;
  renderPivot(type);
}
