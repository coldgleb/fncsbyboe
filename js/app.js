/* KPI, загрузка данных и запуск */

function renderKPI(racesRows, qualsRows) {
  const rs = state.races.standings;
  const leader = rs[0];
  const second = rs[1];
  const numRaces = state.races.rounds.length;
  const numQuals = state.quals.rounds.filter(r => !SPRINT_ROUNDS.has(r)).length;
  const allDrivers = new Set([...racesRows, ...qualsRows].map(r => r['Driver']).filter(Boolean));
  const teams = new Set(racesRows.map(r => r['Team']).filter(Boolean));
  const gap = leader && second ? leader.total - second.total : 0;

  document.getElementById('kpi-grid').innerHTML = `
<div class="kpi-card">
  <div class="kpi-label">Лидер чемпионата</div>
  <div class="kpi-value sm">${leader.driver}</div>
  <div class="kpi-sub">${leader.team} &middot; ${leader.total} очков</div>
</div>
<div class="kpi-card green">
  <div class="kpi-label">Раундов завершено</div>
  <div class="kpi-value">${numRaces} / ${numQuals}</div>
  <div class="kpi-sub">гонок / квалификаций</div>
</div>
<div class="kpi-card blue">
  <div class="kpi-label">Участников</div>
  <div class="kpi-value">${allDrivers.size}</div>
  <div class="kpi-sub">${teams.size} команд</div>
</div>
<div class="kpi-card gold">
  <div class="kpi-label">Отрыв лидера от 2-го</div>
  <div class="kpi-value">+${gap}</div>
  <div class="kpi-sub">${second ? second.driver.split(' ').pop() + ' · ' + second.total + ' очков' : ''}</div>
</div>
  `;

  const upd = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('header-meta').textContent =
    `Дивизион ${DIVISIONS[state.division].label} · ${numRaces} гонок · ${numQuals} квалификаций · `
    + `${allDrivers.size} участников · ${teams.size} команд · обновлено ${upd}`;
}

async function init() {
  initYearSelect();
  applyDivision();
  document.getElementById('kpi-grid').innerHTML =
    '<div class="kpi-card"><div class="loading-state"><div class="spinner"></div> Загрузка…</div></div>';
  try {
    await load();
  } catch (err) {
    document.getElementById('kpi-grid').innerHTML = `
  <div class="kpi-card" style="grid-column:1/-1;border-top-color:var(--accent)">
    <div class="kpi-label">Ошибка загрузки</div>
    <div class="kpi-value sm">${err.message}</div>
    <div class="kpi-sub" style="margin-top:10px">
      <button class="page-btn" onclick="init()">Повторить</button>
    </div>
  </div>`;
    document.getElementById('header-meta').textContent = 'Данные не загружены';
    console.error(err);
  }
}

async function load() {
  const div = DIVISIONS[state.division];
  const [racesRows, qualsRows, roundRows, coalRows, dedRows, changeRows] = await Promise.all([
    fetchSheet(`${state.year} ${div.races}`),
    fetchSheet(`${state.year} ${div.quals}`),
    fetchSheet(`${state.year} Calendar`),
    div.coalitions ? fetchSheet(`${state.year} ${div.coalitions}`).catch(() => []) : [],
    fetchSheet(`${state.year} Deductions`).catch(() => []),
    fetchSheet(`${state.year} Changes`).catch(() => []),
  ]);

  // Лист без заголовка — берём первое значение строки
  state.coalitions = new Set(coalRows.map(r => Object.values(r)[0]).filter(Boolean));

  /* Штрафы команд в очках. Лист Deductions общий на оба дивизиона (как Round) и без столбца
     этапа, поэтому штраф считается сезонным: вычитается из командного зачёта на любой момент,
     в том числе в зачётах «после этапа» и в истории мест. До computeTeamStandings — она читает
     state.deductions. Пустого листа хватает, чтобы штрафов просто не было. */
  state.deductions = Object.fromEntries(
    dedRows.filter(r => r['Team'] && r['Points'] != null)
      .map(r => [r['Team'], { pts: r['Points'], reason: r['Reason'] || '' }]));

  // названия этапов нужны раньше вкладки «По этапам» — их показывает селектор среза зачёта
  state.roundNames = Object.fromEntries(
    roundRows.filter(r => r['#'] != null)
      .map(r => [String(r['#']), `${fmtRoundNum(r['#'])} · ${r['Name'] || ''}`]));

  state.roundAbb = Object.fromEntries(
    roundRows.filter(r => r['#'] != null && r['Abb.']).map(r => [String(r['#']), r['Abb.']])
  );

  // Пилоты, сменившие дивизион в этом сезоне: в дивизионе, из которого ушли (From) —
  // гости (очки считаются, но в зачёте они вне мест); лист общий на оба дивизиона,
  // без настоящей шапки — gviz отдаёт "Driver"/"From"/"To" первой строкой данных,
  // фильтр по div.label заодно отсекает и её
  state.guestByChange = new Set(
    changeRows.filter(r => r.B === div.label && r.A).map(r => r.A)
  );

  // до любых зачётов: команда пилота берётся отсюда везде, где показывается
  state.teamOf = computeTeamOf(racesRows, qualsRows);

  const duelRows = qualsRows.filter(r => SPRINT_ROUNDS.has(parseFloat(r['Round'])));
  const racesRowsWithDuel = [...racesRows, ...duelRows];

  state.races.rows = racesRows;
  state.races.rowsWithDuel = racesRowsWithDuel;
  // этап 0 (The Clash) не в зачёте — вне списка этапов, но строки остаются в rows для протокола
  state.races.rounds = uniqueRounds(racesRows).filter(r => r !== 0);
  state.quals.rows = qualsRows;
  state.quals.rounds = uniqueRounds(qualsRows).filter(r => r !== 0);

  // Max race position per round (for colour coding)
  state.roundMaxPos = {};
  for (const r of racesRows) {
    const rnd = r['Round'], pos = r['Pos.'];
    if (rnd != null && pos != null)
      state.roundMaxPos[rnd] = Math.max(state.roundMaxPos[rnd] || 0, pos);
  }

  // Квалификация «по метрике»: прогнозов (DR1–DR4) нет, очки считаются метрикой — меньше лучше
  state.metricQuals = new Set(state.quals.rounds.filter(rnd =>
    qualsRows.filter(r => r['Round'] === rnd)
      .every(r => DR_KEYS.every(k => r[k] == null))));

  // Участие по этапам: проходы в гонку и участия в квалификации (дуэли не в счёт)
  const countRounds = rows => {
    const m = {};
    for (const r of rows) {
      const d = r['Driver'], rnd = r['Round'];
      if (!d || rnd == null || SPRINT_ROUNDS.has(rnd) || rnd === 0) continue;
      (m[d] ||= new Set()).add(rnd);
    }
    return m;
  };
  state.attendance = { races: countRounds(racesRows), quals: countRounds(qualsRows) };

  // Участие в квалификациях (без гостей и без дуэлей — дуэль не этап регулярного сезона, п. 11.1)
  state.qualsParticipation = {};
  for (const r of qualsRows) {
    const d = r['Driver'];
    const rnd = r['Round'];
    if (!d || isGuestDriver(d) || rnd == null || SPRINT_ROUNDS.has(rnd) || rnd === 0) continue;
    if (!state.qualsParticipation[d]) state.qualsParticipation[d] = new Set();
    state.qualsParticipation[d].add(rnd);
  }

  // Личный зачёт: после 26 этапа — Чейз (qualEligible выше уже посчитан, от неё зависит топ-16)
  const lastRaceRound = Math.max(...state.races.rounds.filter(r => !SPRINT_ROUNDS.has(r)), 0);
  state.races.standings = lastRaceRound > CHASE_START
    ? computeChaseStandings(racesRowsWithDuel)
    : computeStandings(racesRowsWithDuel);

  const lastQualRound = Math.max(...state.quals.rounds.filter(r => !SPRINT_ROUNDS.has(r)), 0);
  state.quals.standings = lastQualRound > CHASE_START
    ? computeChaseStandings(qualsRows)
    : computeStandings(qualsRows);

  // Место в личном зачёте после каждого этапа — для графика в карточке пилота.
  // Граница как в renderRoundStandings: дуэли относятся к своему этапу
  state.rankHistory = {};
  state.teamRankHistory = {};
  for (const rnd of state.races.rounds) {
    const upTo = racesRowsWithDuel.filter(r => r['Round'] < rnd + 1);
    const st = rnd > CHASE_START ? computeChaseStandings(upTo) : computeStandings(upTo);
    for (const s of st)
      (state.rankHistory[s.driver] ||= {})[rnd] = s.rank;
    for (const t of computeTeamStandings(upTo))
      (state.teamRankHistory[t.team] ||= {})[rnd] = t.rank;
  }

  // То же для зачёта квалификаций — график в карточке пилота в режиме «только квалы»
  state.qualRankHistory = {};
  for (const rnd of state.quals.rounds) {
    const upTo = qualsRows.filter(r => r['Round'] <= rnd);
    const st = rnd > CHASE_START ? computeChaseStandings(upTo) : computeStandings(upTo);
    for (const s of st)
      (state.qualRankHistory[s.driver] ||= {})[rnd] = s.rank;
  }

  if (div.golub) state.golub = {
    races: computeGolub(racesRows),
    // квала по метрике — не прогноз, а замер: сравнивать по ней позиции нечестно
    quals: computeGolub(qualsRows.filter(r => !state.metricQuals.has(r['Round']))),
  };
  state.gains = computeGains();
  state.teamStandings = computeTeamStandings(racesRowsWithDuel);
  // сводным нужны все команды, включая те, за которые ездили одни гости
  state.teamPivot = computeTeamStandings(racesRowsWithDuel, true);
  state.ownerStandings = computeOwnerStandings(racesRowsWithDuel);

  // Зачёты независимых команд (вне коалиций), места пересчитываются
  if (div.coalitions) {
    const indep = team => team && team !== '—' && !state.coalitions.has(team);
    // Независимые Чейз не считают — берём из «сырых» строк, а не из (возможно) чейзового state.races.standings
    state.indRaces.standings = renumber(computeStandings(racesRowsWithDuel).filter(s => indep(s.team)));
    state.indQuals.standings = renumber(computeStandings(qualsRows).filter(s => indep(s.team)));
    state.indTeams = renumber(state.teamStandings.filter(t => indep(t.team)));
  }

  renderKPI(racesRows, qualsRows);

  renderTable('races');
  renderTable('quals');
  renderPivot('races');
  renderPivot('quals');
  renderTeamTab();
  renderOwners();
  if (div.coalitions) {
    renderTable('indRaces');
    renderTable('indQuals');
    renderIndTeams();
  }

  initCharts('races');
  initCharts('quals');
  initRoundView(roundRows);   // до сводных таблиц: оттуда берутся названия этапов
  if (div.golub) {
    renderGolub('races');
    renderGolub('quals');
  }
  renderGainPivot();
  renderTeamPivot();
  renderTeamPosPivot();
  applyHash();
}

init();
