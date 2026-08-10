/* Карточки пилота и команды */

/* ── Карточка пилота ── */
function openDriver(driver) {
  const rs = state.races.standings.find(s => s.driver === driver);
  const qs = state.quals.standings.find(s => s.driver === driver);
  const base = rs || qs;
  if (!base) return;

  const rowByRound = rows => {
    const m = {};
    for (const r of rows) {
      if (r['Driver'] !== driver) continue;
      const rnd = r['Round'], pos = r['Pos.'];
      if (rnd == null || pos == null) continue;
      if (m[rnd] == null || pos < m[rnd]['Pos.']) m[rnd] = r;
    }
    return m;
  };
  const raceRow = rowByRound(state.races.rows);
  const qualRow = rowByRound(state.quals.rows);
  const racePos = Object.fromEntries(Object.entries(raceRow).map(([k, r]) => [k, r['Pos.']]));
  const qualPos = Object.fromEntries(Object.entries(qualRow).map(([k, r]) => [k, r['Pos.']]));
  // Клэши отдельной строкой не показываем — их очки идут в Дейтону (этап 1)
  const rounds = [...new Set([...Object.keys(racePos), ...Object.keys(qualPos)].map(Number))]
    .filter(r => !SPRINT_ROUNDS.has(r))
    .sort((a, b) => a - b);
  const roundPts = r => scorePts(racePos[r], r) +
    (r === 1 ? [...SPRINT_ROUNDS].reduce((s, c) => s + scorePts(qualPos[c], c), 0) : 0);

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
      : stat('Лучший финиш', rs && rs.best !== Infinity ? 'P' + rs.best : '—'),
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
      : stat('Лучший старт', qs && qs.best !== Infinity ? 'P' + qs.best : '—'),
  ].join('');

  const body = rounds.map(r => {
    const rp = racePos[r], qp = qualPos[r];
    const diff = rp != null && qp != null ? qp - rp : null;
    const diffCell = diff == null ? '<span style="color:var(--muted)">—</span>'
      : diff === 0 ? '<span style="color:var(--muted)">0</span>'
        : `<span style="color:${diff > 0 ? '#2ecc71' : '#e63946'};font-weight:700">${diff > 0 ? '+' : ''}${diff}</span>`;
    const fc = v => `<td class="r" style="color:var(--muted)">${v ?? '—'}</td>`; // очки за прогноз с листа
    const metric = state.metricQuals?.has(r)
      ? '<span class="metric-mark" title="Квалификация по метрике: без прогноза, меньше — лучше">(metric)</span> ' : '';
    return `<tr>
  <td><span class="driver-link" title="Открыть результаты этапа" onclick="goToRound(${r})">${roundFullName(r)}</span></td>
  <td class="r">${qp ?? '—'}</td>
  <td class="r" style="color:var(--muted)">${metric}${qualRow[r]?.['Points'] ?? '—'}</td>
  <td class="r">${rp ?? '—'}</td>
  ${fc(raceRow[r]?.['Points'])}
  <td class="r">${diffCell}</td>
  <td class="r">${roundPts(r)}</td>
</tr>`;
  }).join('');

  document.getElementById('driver-modal-body').innerHTML = `
<div class="modal-head">
  <div>
    <h2>${driver}</h2>
    <div class="team-text">${base.team}${coalMark(base.team)} ${mfrBadge(base.mfr)}</div>
  </div>
  <button class="modal-close" onclick="closeDriver()" title="Закрыть (Esc)">×</button>
</div>
<div class="modal-stats">${raceStats}</div>
<div class="modal-stats">${qualStats}</div>
<div class="chart-card" style="margin-bottom:16px">
  <h3>Место в личном зачёте после этапа</h3>
  <div class="chart-wrap" style="height:220px"><canvas id="chart-driver-rank"></canvas></div>
</div>
<div class="table-scroll"><table class="standings-table" data-sort="auto">
  <thead><tr>
    <th>Этап</th>
    <th class="r">Квала</th>
    <th class="r" title="Очки за прогноз в квалификации">Очки кв.</th>
    <th class="r">Гонка</th>
    <th class="r" title="Очки за прогноз в гонке">Очки гн.</th>
    <th class="r">±</th>
    <th class="r" title="Очки в зачёт (клэши включены в Дейтону)">NASCAR</th>
  </tr></thead>
  <tbody>${body || '<tr><td colspan="7" style="color:var(--muted)">Нет данных</td></tr>'}</tbody>
</table></div>
${rounds.some(r => state.metricQuals?.has(r))
      ? '<div class="modal-note"><span class="metric-mark">(metric)</span> — квалификация по метрике: прогноза не было, меньше очков лучше</div>'
      : ''}`;
  document.getElementById('driver-modal').classList.add('open');
  drawRankChart(state.rankHistory[driver] || {}, MFR_COLORS[base.mfr] || GRAY);
}

// Ссылка на карточку команды — из любой таблицы
function teamLink(team) {
  if (!team || team === '—') return team || '—';
  return `<span class="driver-link" onclick="openTeam('${team.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">${team}</span>`;
}

/* Карточка команды — та же всплывашка, что у пилота */
function openTeam(team) {
  const t = state.teamStandings.find(x => x.team === team);
  if (!t) return;
  const rounds = state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r));
  const hist = state.teamRankHistory[team] || {};
  const scored = rounds.filter(r => t.roundBest[r]?.length);
  const best = t.bestPositions[0];
  const wins = t.bestPositions.filter(p => p === 1).length;

  const stat = (k, v) => `<div class="modal-stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const stats = [
    stat('Место', `#${t.rank}`),
    stat('Очки', t.total),
    stat('Пилотов', t.drivers.length),
    stat('Этапов в зачёте', scored.length),
    stat('Лучший финиш', best != null ? 'P' + best : '—'),
    wins > 0 ? stat('Победы', wins) : stat('Сред. за этап', scored.length ? (t.total / scored.length).toFixed(1) : '—'),
  ].join('');

  // место команды на самом этапе — по очкам, набранным на нём (равные очки → равное место)
  const rankInRound = r => {
    const mine = t.roundPts[r];
    if (mine == null) return null;
    return 1 + state.teamStandings.filter(x => (x.roundPts[r] ?? -1) > mine).length;
  };

  let cum = 0;
  const body = rounds.map(r => {
    const bestOfRound = t.roundBest[r] || [];
    const got = t.roundPts[r] || 0;
    const rr = rankInRound(r);
    cum += got;
    const maxPos = state.roundMaxPos[r] || 40;
    const cells = bestOfRound.length
      ? bestOfRound.map(x => `<span class="pos-cell ${posClass(x.pos, maxPos)}">${x.pos}</span>`).join(' ')
      : '<span style="color:var(--muted)">—</span>';
    return `<tr>
      <td><span class="driver-link" title="Открыть результаты этапа" onclick="goToRound(${r})">${roundFullName(r)}</span></td>
      <td>${cells}</td>
      <td class="team-text">${bestOfRound.map(x => x.driver).join(' · ') || '—'}</td>
      <td class="r">${got || '—'}</td>
      <td class="r">${rr == null ? '—' : `<span class="pos-badge">${rr}</span>`}</td>
      <td class="r"><strong>${cum}</strong></td>
      <td class="r">${hist[r] ?? '—'}</td>
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
<div class="chart-card" style="margin-bottom:16px">
  <h3>Место в командном зачёте после этапа</h3>
  <div class="chart-wrap" style="height:220px"><canvas id="chart-driver-rank"></canvas></div>
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
  <tbody>${body || '<tr><td colspan="7" style="color:var(--muted)">Нет данных</td></tr>'}</tbody>
</table></div>`;
  document.getElementById('driver-modal').classList.add('open');
  drawRankChart(hist, GRAY);
}

function closeDriver() {
  document.getElementById('driver-modal').classList.remove('open');
}

// Из карточки пилота — к результатам этапа
function goToRound(n) {
  const sel = document.getElementById('round-select');
  const val = String(n);
  if (![...sel.options].some(o => o.value === val)) return;
  closeDriver();
  sel.value = val;
  roundView = 'race';
  onRoundChange();
  switchTab('rounds');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDriver(); });
