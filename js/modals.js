/* Карточки пилота и команды */

/* ── Карточка пилота ── */
/* Карточка пилота: итоговые цифры — из уже загруженного зачёта, строки по этапам и
   история мест — из базы (api.driver_card). mode = 'quals' — карточка из зачёта квал. */
async function openDriver(driver, mode) {
  const qualsOnly = mode === 'quals';
  const rs = state.races.standings.find(s => s.driver === driver);
  const qs = state.quals.standings.find(s => s.driver === driver);
  const base = (qualsOnly ? qs : rs) || rs || qs;
  if (!base) return;
  const card = await rpc('driver_card', {
    season: state.year, division: state.division, driver, mode: qualsOnly ? 'quals' : 'races',
  }, state.fresh);
  const rounds = card.rounds;

  const stat = (k, v) => `<div class="modal-stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const raceStats = [
    stat('Место · гонки', rs ? `#${rs.rank}` : '—'),
    stat('Очки · гонки', rs ? rs.total : '—'),
    stat('К-во гонок', state.attendance.races[driver]?.size || 0),
    stat('Сред. поз. · гонки', rs ? avgPos(rs) : '—'),
    stat('Топ-5 / 10 · гонки', rs ? `${rs.top5} / ${rs.top10}` : '—'),
    // С победами показываем их, без побед «Лучший финиш» информативнее
    rs && rs.wins > 0
      ? stat('Победы', rs.wins)
      : stat('Лучший финиш', rs && rs.best != null ? 'P' + rs.best : '—'),
  ].join('');
  const qualStats = [
    stat('Место · квала', qs ? `#${qs.rank}` : '—'),
    stat('Очки · квала', qs ? qs.total : '—'),
    stat('К-во квалификаций', state.attendance.quals[driver]?.size || 0),
    stat('Сред. поз. · квала', qs ? avgPos(qs) : '—'),
    stat('Топ-5 / 10 · квала', qs ? `${qs.top5} / ${qs.top10}` : '—'),
    // Есть поулы — показываем их, иначе информативнее лучший старт
    qs && qs.wins > 0
      ? stat('Поулы', qs.wins)
      : stat('Лучший старт', qs && qs.best != null ? 'P' + qs.best : '—'),
  ].join('');

  const metricMark = r => r.metric
    ? '<span class="metric-mark" title="Квалификация по метрике: без прогноза, меньше — лучше">(metric)</span> ' : '';
  const place = (pos, dq) => pos ?? (dq ? DQ_MARK : '—');
  const roundLink = r => `<span class="driver-link" title="Открыть результаты этапа" onclick="goToRound(${Math.trunc(r.round)})">${roundFullName(r.round)}</span>`;

  const body = rounds.map(r => qualsOnly ? `<tr>
  <td>${roundLink(r)}</td>
  <td class="r">${place(r.qualPos, r.qualDQ)}</td>
  <td class="r muted">${metricMark(r)}${r.qualPts ?? '—'}</td>
  <td class="r">${r.nascar}</td>
</tr>` : `<tr>
  <td>${roundLink(r)}</td>
  <td class="r">${place(r.qualPos, r.qualDQ)}</td>
  <td class="r muted">${metricMark(r)}${r.qualPts ?? '—'}</td>
  <td class="r">${place(r.racePos, r.raceDQ)}</td>
  <td class="r muted">${r.racePts ?? '—'}</td>
  <td class="r">${r.diff == null ? '<span class="muted">—</span>' : r.diff === 0 ? '<span class="muted">0</span>'
    : `<span class="${r.diff > 0 ? 'up' : 'down'}">${r.diff > 0 ? '+' : ''}${r.diff}</span>`}</td>
  <td class="r">${r.nascar}</td>
</tr>`).join('');

  document.getElementById('driver-modal-body').innerHTML = `
<div class="modal-head">
  <div>
    <h2>${driver}</h2>
    <div class="team-text">${base.team}${coalMark(base.team)} ${mfrBadge(base.mfr)}</div>
  </div>
  <button class="modal-close" onclick="closeDriver()" title="Закрыть (Esc)">×</button>
</div>
${qualsOnly ? `<div class="modal-stats">${qualStats}</div>`
      : `<div class="modal-stats">${raceStats}</div><div class="modal-stats">${qualStats}</div>`}
<div class="chart-card">
  <h3>Место в ${qualsOnly ? 'зачёте квалификаций' : 'личном зачёте'} после этапа</h3>
  <div class="chart-wrap sm"><canvas id="chart-driver-rank"></canvas></div>
</div>
<div class="table-scroll"><table class="standings-table" data-sort="auto">
  <thead><tr>
    <th>Этап</th>
    <th class="r">Квала</th>
    <th class="r" title="Очки за прогноз в квалификации">Очки кв.</th>
    ${qualsOnly ? '' : `<th class="r">Гонка</th>
    <th class="r" title="Очки за прогноз в гонке">Очки гн.</th>
    <th class="r">±</th>`}
    <th class="r" title="${qualsOnly ? 'Очки в зачёт квалификаций' : 'Очки в зачёт (дуэли включены в Дейтону)'}">NASCAR</th>
  </tr></thead>
  <tbody>${body || `<tr><td colspan="${qualsOnly ? 4 : 7}" class="muted">Нет данных</td></tr>`}</tbody>
</table></div>
${rounds.some(r => r.metric)
      ? '<div class="modal-note"><span class="metric-mark">(metric)</span> — квалификация по метрике: прогноза не было, меньше очков лучше</div>'
      : ''}`;
  document.getElementById('driver-modal').classList.add('open');
  const color = MFR_COLORS[mfrKey(base.mfr)] || GRAY;
  qualsOnly
    ? drawRankChart(card.history || {}, color, state.quals.rounds.filter(r => r === Math.trunc(r)))
    : drawRankChart(card.history || {}, color);
}

// Ссылка на карточку команды — из любой таблицы
function teamLink(team) {
  if (!team || team === '—') return team || '—';
  return `<span class="driver-link" onclick="openTeam('${team.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">${team}</span>`;
}

/* Карточка команды — та же всплывашка, что у пилота */
/* Карточка команды: всё по этапам (зачётные места, кто принёс, место на этапе, итог
   со штрафом, место в зачёте) — из базы, api.team_card */
async function openTeam(team) {
  const card = await rpc('team_card', { season: state.year, division: state.division, team }, state.fresh);
  const t = card.team;
  if (!t) return;
  const hist = card.history || {};
  const scored = card.rounds.filter(r => r.best.length);
  const best = t.bestPositions[0];
  const wins = t.bestPositions.filter(p => p === 1).length;

  const stat = (k, v) => `<div class="modal-stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const stats = [
    stat('Место', t.rank == null ? 'вне зачёта' : `#${t.rank}`),
    stat('Очки', `${penMark(t)}${t.total}`),
    stat('Пилотов', t.drivers.length),
    stat('Этапов в зачёте', scored.length),
    stat('Лучший финиш', best != null ? 'P' + best : '—'),
    wins > 0 ? stat('Победы', wins) : stat('Сред. за этап', scored.length ? (t.total / scored.length).toFixed(1) : '—'),
  ].join('');

  const body = card.rounds.map(row => {
    const { round: r, best: bestOfRound, pts: got, rankInRound: rr, total: cum } = row;
    const maxPos = state.roundMaxPos[r] || 40;
    const cells = bestOfRound.length
      ? bestOfRound.map(x => `<span class="pos-cell ${posClass(x.pos, maxPos)}">${x.pos}</span>`).join(' ')
      : '<span class="muted">—</span>';
    return `<tr>
      <td><span class="driver-link" title="Открыть результаты этапа" onclick="goToRound(${r})">${roundFullName(r)}</span></td>
      <td>${cells}</td>
      <td class="team-text">${bestOfRound.map(x => x.driver).join(' · ') || '—'}</td>
      <td class="r">${got || '—'}</td>
      <td class="r">${rr == null ? '—' : `<span class="pos-badge">${rr}</span>`}</td>
      <td class="r"><strong>${cum}</strong></td>
      <td class="r">${row.rank ?? '—'}</td>
    </tr>`;
  }).join('');

  document.getElementById('driver-modal-body').innerHTML = `
<div class="modal-head">
  <div>
    <h2>${team}${coalMark(team)}</h2>
    <div class="team-text">${t.drivers.slice().sort().join(' · ')}</div>
  </div>
  <button class="modal-close" onclick="closeDriver()" title="Закрыть (Esc)">×</button>
</div>
<div class="modal-stats">${stats}</div>
<div class="chart-card">
  <h3>Место в командном зачёте после этапа</h3>
  <div class="chart-wrap sm"><canvas id="chart-driver-rank"></canvas></div>
</div>
<div class="table-scroll"><table class="standings-table" data-sort="auto">
  <thead><tr>
    <th>Этап</th>
    <th title="Два лучших результата команды на этапе">Зачётные места</th>
    <th>Кто принёс</th>
    <th class="r">Очки</th>
    <th class="r" title="Место команды на этапе — по очкам, набранным на нём">На этапе</th>
    <th class="r">Всего</th>
    <th class="r" title="Место в командном зачёте после этапа">Место</th>
  </tr></thead>
  <tbody>${body || '<tr><td colspan="7" class="muted">Нет данных</td></tr>'}</tbody>
</table></div>`;
  document.getElementById('driver-modal').classList.add('open');
  drawRankChart(hist, GRAY);
}

function closeDriver() {
  document.getElementById('driver-modal').classList.remove('open');
}

// Из карточки пилота — к результатам этапа
function goToRound(n) {
  const val = String(n);
  closeDriver();
  switchTab('rounds');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // селектор этапов заполняется при первом открытии вкладки — ждём его и выбираем этап
  ensureTab('rounds').then(() => {
    const sel = document.getElementById('round-select');
    if (!sel || ![...sel.options].some(o => o.value === val)) return;
    sel.value = val;
    roundView = 'race';
    onRoundChange();
  }).catch(err => console.error(err));
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDriver(); });
