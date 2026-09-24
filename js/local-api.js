/* ── Данные сайта: листы Google Sheets + расчёт в браузере ──

   Фронт спрашивает готовые таблицы одним вызовом rpc(имя, параметры). Здесь они и
   считаются: листы тянутся из Google Sheets (fetchSheet в core.js), а правила зачётов
   берутся из js/logic.gen.js — это сборка расчётного кода (сгенерирована из
   db/reference/*.js, там же он проверяется тестами и сверкой).

   Набор имён и структура ответов — те же, что отдавала схема api в PostgreSQL, поэтому
   вкладки, карточки и выгрузки не знают, откуда пришли данные. */

const DR_KEYS_LOCAL = ['DR1', 'DR2', 'DR3', 'DR4'];

/* ── Строки протокола из листа results ──

   В таблице один лист результатов на оба дивизиона и все сессии:
     season, div (O/S), rnd, sess (R — гонка, Q — квала, D1/D2 — дуэли), pos, car, name,
     guest, ql, dr1–dr4, cau, ret, mn, due, points, team, man (C/T/F).
   Правила и таблицы сайта ждут прежние имена колонок, поэтому строку переводим здесь:
   дуэли становятся этапами 1.1 и 1.2, код производителя — его названием, а гостевая
   заявка помечается (r.guest) — очков пилоту она не даёт, но остаётся в статистике.
   Метку «(i)» к имени добавляем только тем, у кого в дивизионе нет ни одной своей заявки. */
const MFR_BY_CODE = { C: 'Chevrolet', T: 'Toyota', F: 'Ford' };
const DIV_CODE = { open: 'O', star: 'S' };
const SESS_ROUND = { D1: 1.1, D2: 1.2 };

function protocolRow(r, guestOnly) {
  const num = v => (v == null || v === '' ? null : toNum(v));
  return {
    'Round': SESS_ROUND[r.sess] ?? num(r.rnd),
    'Pos.': num(r.pos),
    '#': r.car == null || r.car === '' ? null : String(r.car),
    'Driver': r.name + (guestOnly.has(r.name) ? ' (i)' : ''),
    'Team': r.team || '—',
    'M.': MFR_BY_CODE[r.man] || r.man || '',
    'QL': num(r.ql), 'DR1': num(r.dr1), 'DR2': num(r.dr2), 'DR3': num(r.dr3), 'DR4': num(r.dr4),
    'CAU': num(r.cau), 'RET': num(r.ret), 'MN': num(r.mn), 'DUE': num(r.due), 'Points': num(r.points),
    guest: !!r.guest,
  };
}

// В листе строки лежат по этапам и местам; порядок важен для тай-брейков, поэтому
// сортируем явно: этап, затем место (без места — в конец), затем как в листе
const byRoundAndPos = rows => rows
  .map((r, i) => [r, i])
  .sort((a, b) => (a[0]['Round'] - b[0]['Round'])
    || ((a[0]['Pos.'] == null) - (b[0]['Pos.'] == null))
    || ((a[0]['Pos.'] ?? 0) - (b[0]['Pos.'] ?? 0))
    || (a[1] - b[1]))
  .map(([r]) => r);

/* Протоколы дивизиона в прежнем виде: гонки (с дуэлями отдельно) и квалификации */
function divisionRows(results, year, division) {
  const mine = results.filter(r => r.season === year && r.div === DIV_CODE[division] && r.name);
  const own = new Set(mine.filter(r => !r.guest).map(r => r.name));
  const guestOnly = new Set(mine.filter(r => r.guest && !own.has(r.name)).map(r => r.name));
  const rows = sess => byRoundAndPos(mine.filter(r => sess.includes(r.sess)).map(r => protocolRow(r, guestOnly)));
  return { races: rows(['R']), quals: rows(['Q', 'D1', 'D2']) };
}

/* Лист заявок в том виде, который читает computeEntries: первая строка — номера этапов,
   дальше по строке на «команда + машина» с отметкой на заявленных этапах.

   В новой таблице строка заявки — это season, div, team, num, признак фулл-тайма, man,
   затем период, на который машина числится за командой (от/до), период заявления
   фулл-тайма (от/до, у парт-тайма пусто), число фактически поданных прогнозов и, наконец,
   признаки факта по каждому этапу 0–35. Метрике нужен именно ПЛАН — этапы заявления;
   факт она считает сама по листу квалификаций. Поэтому отмечаем период заявления,
   а парт-тайм машины (периода нет) в фулл-тайм не попадают. */
function entriesMatrix(entryRows, year, division) {
  const code = DIV_CODE[division];
  const at = (r, i) => Object.values(r)[i];
  const mine = entryRows.filter(r => at(r, 0) === year && at(r, 1) === code);
  if (!mine.length) return [];

  const declared = r => {
    const start = at(r, 8), end = at(r, 9);
    return at(r, 4) === true && start != null && end != null ? [Number(start), Number(end)] : null;
  };
  const last = Math.max(...mine.map(r => declared(r)?.[1] ?? 0));
  const head = { Team: null, Car: null };
  for (let rnd = 0; rnd <= last; rnd++) head['R' + rnd] = rnd;

  return [head, ...mine.map(r => {
    const row = { Team: at(r, 2), Car: String(at(r, 3) ?? '') };
    const range = declared(r);
    if (range) for (let rnd = range[0]; rnd <= Math.min(range[1], last); rnd++) row['R' + rnd] = 1;
    return row;
  })];
}

/* Прежние имена листов — их ещё спрашивает калькулятор («2026 Open Races», «2026 Calendar») */
async function legacySheet(name, fresh) {
  const m = name.match(/^(\d{4}) (Open|Star) (Races|Quals)$/);
  if (m) {
    const rows = divisionRows(await fetchSheet('results', fresh), Number(m[1]), m[2].toLowerCase());
    return m[3] === 'Races' ? rows.races : rows.quals;
  }
  const cal = name.match(/^(\d{4}) Calendar$/);
  if (cal) return (await fetchSheet('rounds', fresh)).filter(r => r['Year'] === Number(cal[1]));
  return fetchSheet(name, fresh);
}

// Посчитанный сезон держим готовым: пересчёт нужен только на новых данных
const seasons = {};

const seasonKey = (year, division) => `${year}:${division}`;

/* Сборка сезона: те же шаги, что раньше делал load() — листы, календарь, штрафы,
   участие, зачёты. Дорогие части (история мест, сводные, метрика) — по требованию. */
async function buildSeason(year, division, fresh) {
  const L = makeLogic();
  const { state: st } = L;
  const div = L.DIVISIONS[division];
  st.year = year;
  st.division = division;

  // coalitions — необязательный лист: нет его, значит и метки коалиций нет
  const [results, roundRows, dedRows, changeRows, entryRows, coalRows] = await Promise.all([
    fetchSheet('results', fresh),
    fetchSheet('rounds', fresh),
    fetchSheet('deductions', fresh).catch(() => []),
    fetchSheet('division_changes', fresh).catch(() => []),
    fetchSheet('entries', fresh).catch(() => []),
    fetchSheet('coalitions', fresh).catch(() => []),
  ]);

  /* Листа coalitions в таблице может не быть, а gviz на неизвестное имя отдаёт первый
     лист книги (results). Поэтому принимаем ответ только если он похож на список команд. */
  const coalitions = coalRows.filter(r => !('sess' in r) && (r.team || r.Team));

  const { races: racesRows, quals: qualsRows } = divisionRows(results, year, division);

  st.entries = L.computeEntries(entriesMatrix(entryRows, year, division));
  st.coalitions = new Set(coalitions
    .filter(r => (r.season ?? r.Year ?? year) === year && (!r.div || r.div === DIV_CODE[division]))
    .map(r => r.team || r.Team || Object.values(r).filter(v => typeof v === 'string').pop())
    .filter(Boolean));
  st.deductions = Object.fromEntries(
    dedRows.filter(r => r['Year'] === year && r['Team'] && r['Points'] != null)
      .map(r => [r['Team'], { pts: r['Points'], reason: r['Reason'] || '', round: r['Round'] ?? null }]));
  const cal = roundRows.filter(r => r['Year'] === year && r['#'] != null);
  st.roundNames = Object.fromEntries(
    cal.map(r => [String(r['#']), `${L.fmtRoundNum(r['#'])} · ${r['Name'] || ''}`]));
  st.roundAbb = Object.fromEntries(
    cal.filter(r => r['Abb.']).map(r => [String(r['#']), r['Abb.']]));
  // сменившие дивизион: в том, откуда ушли, они гости
  st.guestByChange = new Set(changeRows
    .filter(r => r['Year'] === year && r['From'] === div.label && r['Driver'])
    .map(r => r['Driver']));
  st.teamOf = L.computeTeamOf(racesRows, qualsRows);
  st.carOf = L.computeCarOf(racesRows, qualsRows);

  const duelRows = qualsRows.filter(r => L.SPRINT_ROUNDS.has(parseFloat(r['Round'])));
  const racesRowsWithDuel = [...racesRows, ...duelRows];
  st.races.rows = racesRows;
  st.races.rowsWithDuel = racesRowsWithDuel;
  st.races.rounds = L.uniqueRounds(racesRows).filter(r => r !== 0);
  st.quals.rows = qualsRows;
  st.quals.rounds = L.uniqueRounds(qualsRows).filter(r => r !== 0);

  st.roundMaxPos = {};
  for (const r of racesRows) {
    const rnd = r['Round'], pos = r['Pos.'];
    if (rnd != null && pos != null) st.roundMaxPos[rnd] = Math.max(st.roundMaxPos[rnd] || 0, pos);
  }

  // Квалификация «по метрике»: прогнозов (DR1–DR4) нет ни у кого
  st.metricQuals = new Set(st.quals.rounds.filter(rnd =>
    qualsRows.filter(r => r['Round'] === rnd).every(r => L.DR_KEYS.every(k => r[k] == null))));

  const countRounds = rows => {
    const m = {};
    for (const r of rows) {
      const d = r['Driver'], rnd = r['Round'];
      if (!d || rnd == null || L.SPRINT_ROUNDS.has(rnd) || rnd === 0) continue;
      (m[d] ||= new Set()).add(rnd);
    }
    return m;
  };
  st.attendance = { races: countRounds(racesRows), quals: countRounds(qualsRows) };

  st.qualsParticipation = {};
  for (const r of qualsRows) {
    const d = r['Driver'], rnd = r['Round'];
    // ценз квалификаций — по зачётным заявкам: гостевая в него не идёт
    if (!d || L.isGuestDriver(d) || r.guest || rnd == null || L.SPRINT_ROUNDS.has(rnd) || rnd === 0) continue;
    (st.qualsParticipation[d] ||= new Set()).add(rnd);
  }

  const lastRace = Math.max(...st.races.rounds.filter(r => !L.SPRINT_ROUNDS.has(r)), 0);
  st.races.standings = lastRace > L.CHASE_START
    ? L.computeChaseStandings(racesRowsWithDuel) : L.computeStandings(racesRowsWithDuel);
  const lastQual = Math.max(...st.quals.rounds.filter(r => !L.SPRINT_ROUNDS.has(r)), 0);
  st.quals.standings = lastQual > L.CHASE_START
    ? L.computeChaseStandings(qualsRows) : L.computeStandings(qualsRows);

  return { L, st, div, racesRows, qualsRows, racesRowsWithDuel, done: {} };
}

function lazyPart(name, fn) {   // ленивые дорогие части сезона
  return s => { if (!s.done[name]) { fn(s); s.done[name] = true; } return s; };
}

const withCharts = lazyPart('charts', ({ L, st, racesRowsWithDuel, qualsRows }) => {
  st.races.chartStandings = L.computeStandings(racesRowsWithDuel);
  st.quals.chartStandings = L.computeStandings(qualsRows);
  st.rankHistory = {};
  st.teamRankHistory = {};
  for (const rnd of st.races.rounds) {
    const upTo = racesRowsWithDuel.filter(r => r['Round'] < rnd + 1);
    const stand = rnd > L.CHASE_START ? L.computeChaseStandings(upTo) : L.computeStandings(upTo);
    for (const s of stand) (st.rankHistory[s.driver] ||= {})[rnd] = s.rank;
    for (const t of L.computeTeamStandings(upTo)) (st.teamRankHistory[t.team] ||= {})[rnd] = t.rank;
  }
  st.qualRankHistory = {};
  for (const rnd of st.quals.rounds) {
    const upTo = qualsRows.filter(r => r['Round'] <= rnd);
    const stand = rnd > L.CHASE_START ? L.computeChaseStandings(upTo) : L.computeStandings(upTo);
    for (const s of stand) (st.qualRankHistory[s.driver] ||= {})[rnd] = s.rank;
  }
});

const withGolub = lazyPart('golub', ({ L, st, racesRows, qualsRows, div }) => {
  if (div.golub) st.golub = {
    races: L.computeGolub(racesRows),
    // квала по метрике — замер, а не прогноз: сравнивать по ней позиции нечестно
    quals: L.computeGolub(qualsRows.filter(r => !st.metricQuals.has(r['Round']))),
  };
});

const withGains = lazyPart('gains', ({ L, st }) => { st.gains = L.computeGains(); });

const withTeams = lazyPart('teams', ({ L, st, racesRowsWithDuel }) => {
  st.teamStandings = L.computeTeamStandings(racesRowsWithDuel);
  // сводным нужны все команды, включая те, за которые ездили одни гости
  st.teamPivot = L.computeTeamStandings(racesRowsWithDuel, true);
});

async function getSeason(year, division, fresh) {
  const key = seasonKey(year, division);
  if (fresh || !seasons[key]) seasons[key] = buildSeason(year, division, fresh);
  return seasons[key];
}

/* ── Зачёты на выбранный этап ── */

const ownersUpTo = ({ L, st }, at, chase) => {
  const rows = st.races.rowsWithDuel.filter(r => r['Round'] < at + 1);
  const real = chase === 'chase' || (chase !== 'regular' && at > L.CHASE_START);
  return real ? L.computeChaseOwnerStandings(rows) : L.computeOwnerStandings(rows);
};

// Строка зачёта для таблиц: очки по этапам нужны только графикам
const slim = list => (list || []).map(s => {
  const { roundPts, positions, bestPositions, posCounts, chase, ...rest } = s;
  return chase ? { ...rest, chase: { wins: chase.wins, firstWin: chase.firstWin } } : rest;
});

/* Срез зачёта: места, «± Чейз», граница Чейза и место на прошлом этапе — ровно то,
   что раньше присылала api.slice. */
function sliceOf(s, session, upto, chase = 'auto') {
  const { L, st } = s;
  const base = session === 'quals' ? 'quals' : 'races';
  const rounds = (base === 'quals' ? st.quals.rounds : st.races.rounds).filter(r => !L.SPRINT_ROUNDS.has(r));
  const at = upto == null ? rounds[rounds.length - 1] : Number(upto);

  const standingsUpTo = n => {
    if (session === 'owners') return ownersUpTo(s, n, chase);
    const rows = (base === 'quals' ? st.quals.rows : st.races.rowsWithDuel).filter(r => r['Round'] < n + 1);
    const real = chase === 'chase' || (chase !== 'regular' && n > L.CHASE_START);
    return real ? L.computeChaseStandings(rows) : L.computeStandings(rows);
  };

  const prevRound = Math.max(...rounds.filter(r => r < at), 0);
  const prev = prevRound ? standingsUpTo(prevRound) : [];
  const key = session === 'owners' ? 'car' : 'driver';
  const prevRank = Object.fromEntries(prev.map(x => [x[key], x.rank]));

  if (session === 'owners') return { at, rounds, standings: standingsUpTo(at), prevRank };

  const all = slim(standingsUpTo(at));
  /* Граница Чейза — топ-16 не-гостей, прошедших ценз квалификаций. «± Чейз»:
     - в Чейзе (очки уже сброшены на сетку): в топ-16 — отрыв от лидера Чейза,
       ниже границы — отставание от того, кто идёт 17-м; считается всем подряд,
       включая гостей и не прошедших ценз (им тоже видно, сколько до Чейза);
     - в регулярном сезоне как раньше: в топ-16 — запас над первым вне Чейза,
       ниже — отставание от последнего в Чейзе, и только для тех, кто в зачёте. */
  const playoffSet = L.buildPlayoffSet(all, at);
  const real = chase === 'chase' || (chase !== 'regular' && at > L.CHASE_START);
  const inChase = all.filter(x => playoffSet.has(x.driver));
  let lastChaseIdx = -1;
  all.forEach((x, i) => { if (playoffSet.has(x.driver)) lastChaseIdx = i; });
  // 17-й в списке: первая строка после границы, кто бы это ни был
  const afterChase = all[lastChaseIdx + 1] || null;
  const firstOut = all.find(x => !x.isGuest && !playoffSet.has(x.driver) && L.qualEligible(x.driver, at));
  const lastIn = inChase[inChase.length - 1], leader = inChase[0];

  const standings = all.map(x => {
    const playoff = playoffSet.has(x.driver);
    const ref = real ? (playoff ? leader : afterChase) : (playoff ? firstOut : lastIn);
    const skip = !real && (x.isGuest || !L.qualEligible(x.driver, at));
    const gap = skip || !ref ? null : x.total - ref.total;
    return { ...x, playoff, cutoff: afterChase != null && afterChase.driver === x.driver, gap };
  });
  return { at, rounds, standings, prevRank };
}

/* ── Протокол этапа ── */

// Места по возрастанию; у дисквалифицированного места нет — ставим его там, где он был
// бы по очкам за прогноз. В квале по метрике очки наоборот: меньше — лучше.
function orderField(rows) {
  const metric = rows.every(r => DR_KEYS_LOCAL.every(k => r[k] == null));
  const beats = (a, b) => metric ? (a ?? Infinity) < (b ?? Infinity) : (a ?? -Infinity) > (b ?? -Infinity);
  const key = r => r['Pos.'] ?? Math.min(999, ...rows
    .filter(x => x['Pos.'] != null && beats(r['Points'], x['Points'])).map(x => x['Pos.'])) - 0.5;
  return rows.map((r, i) => [key(r), i, r]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , r]) => r);
}

const bestOf = (rows, key, fn) => {
  const vals = rows.map(r => r[key]).filter(v => v != null && isFinite(v));
  return vals.length ? fn(...vals) : null;
};

/* Протокол одного вида этапа: порядок с дисквалифицированными, «прошёл дальше»,
   ± квала→гонка, очки NASCAR и ключи лучших значений (hl) — как api.round_protocol. */
function roundProtocol(s, round, view) {
  const { L, st } = s;
  const n = Number(round);
  const src = view === 'race' ? st.races.rows
    : view === 'duel1' ? st.quals.rows.filter(r => parseFloat(r['Round']) === 1.1)
      : view === 'duel2' ? st.quals.rows.filter(r => parseFloat(r['Round']) === 1.2)
        : st.quals.rows;
  const rows = orderField(view === 'duel1' || view === 'duel2'
    ? src : src.filter(r => parseFloat(r['Round']) === n));

  const metric = rows.length > 0 && rows.every(r => DR_KEYS_LOCAL.every(k => r[k] == null));
  const raceDrivers = new Set(st.races.rows.filter(r => parseFloat(r['Round']) === n).map(r => r['Driver']));
  const duelDrivers = new Set(st.quals.rows
    .filter(r => L.SPRINT_ROUNDS.has(parseFloat(r['Round']))).map(r => r['Driver']));
  const qualPos = {};
  for (const r of st.quals.rows.filter(x => parseFloat(x['Round']) === n)) {
    const cur = qualPos[r['Driver']];
    if (cur == null || (r['Pos.'] != null && (cur === null || r['Pos.'] < cur))) qualPos[r['Driver']] = r['Pos.'];
  }

  // Пороги подсветки — по всему протоколу этапа
  const max = k => bestOf(rows, k, Math.max);
  const posMin = bestOf(rows, 'Pos.', Math.min);
  const ptsBest = metric ? bestOf(rows, 'Points', Math.min) : bestOf(rows, 'Points', Math.max);
  const dr12 = (() => {
    const vals = [...new Set(rows.flatMap(r => [r['DR1'], r['DR2']]).filter(v => v != null && isFinite(v)))]
      .sort((a, b) => b - a);
    return vals.length >= 2 ? vals[1] : (vals[vals.length - 1] ?? null);
  })();
  const maxes = { QL: max('QL'), DR3: max('DR3'), DR4: max('DR4'), CAU: max('CAU'), RET: max('RET'), MN: max('MN') };
  const isRace = view === 'race';

  const out = rows.map(r => {
    const hl = [];
    const eq = (k, v) => r[k] != null && v != null && r[k] === v;
    if (isRace && eq('Pos.', posMin)) hl.push('Pos.');
    if (isRace && eq('QL', maxes.QL)) hl.push('QL');
    for (const k of ['DR1', 'DR2']) if (r[k] != null && dr12 != null && r[k] >= dr12) hl.push(k);
    for (const k of ['DR3', 'DR4']) if (eq(k, maxes[k])) hl.push(k);
    if (isRace) for (const k of ['CAU', 'RET', 'MN']) if (eq(k, maxes[k])) hl.push(k);
    if (eq('Points', ptsBest)) hl.push('Points');

    const made = isRace ? null
      : view === 'qual' ? (n === 1 ? duelDrivers.has(r['Driver']) : raceDrivers.has(r['Driver']))
        : raceDrivers.has(r['Driver']);
    // поле квалы бывает больше поля гонки: позиция в квале не дальше последнего стартовавшего
    const qp = qualPos[r['Driver']];
    const delta = isRace && r['Pos.'] != null && qp != null ? Math.min(qp, rows.length) - r['Pos.'] : null;
    const roundNum = view === 'duel1' ? 1.1 : view === 'duel2' ? 1.2 : n;

    return {
      'Round': r['Round'], 'Pos.': r['Pos.'], '#': r['#'], 'Driver': r['Driver'], 'Team': r['Team'], 'M.': r['M.'],
      'QL': r['QL'] ?? null, 'DR1': r['DR1'] ?? null, 'DR2': r['DR2'] ?? null, 'DR3': r['DR3'] ?? null,
      'DR4': r['DR4'] ?? null, 'CAU': r['CAU'] ?? null, 'RET': r['RET'] ?? null, 'MN': r['MN'] ?? null,
      'DUE': r['DUE'] ?? null, 'Points': r['Points'] ?? null,
      nascar: L.scorePts(r['Pos.'], roundNum), made, delta, hl,
    };
  });
  return { metric, rows: out };
}

/* Зачёты по состоянию после этапа: пилоты, команды, владельцы */
function roundStandings(s, round, kind) {
  const { L, st } = s;
  const n = Number(round);
  const upTo = m => st.races.rowsWithDuel.filter(r => r['Round'] < m + 1);
  const prevRound = Math.max(...st.races.rounds.filter(r => r < n), 0);

  if (kind === 'teams') {
    const rows = L.computeTeamStandings(upTo(n));
    const prev = prevRound ? L.computeTeamStandings(upTo(prevRound)) : [];
    // кто выступал за команду на этом этапе и раньше — с марками своих машин
    const roster = {};
    for (const r of upTo(n)) {
      const team = r['Team'], d = r['Driver'];
      if (!team || team === '—' || team === 'Guest entry' || !d) continue;
      (roster[team] ||= new Map()).set(d, st.carOf?.[d]?.mfr || r['M.'] || '');
    }
    return {
      rows: rows.map(t => ({
        ...t,
        roster: [...(roster[t.team] || new Map())].map(([driver, mfr]) => ({ driver, mfr })),
      })),
      prevRank: Object.fromEntries(prev.map(t => [t.team, t.rank])),
    };
  }
  if (kind === 'owners') {
    const rows = ownersUpTo(s, n, 'auto');
    const prev = prevRound ? ownersUpTo(s, prevRound, 'auto') : [];
    return { rows, prevRank: Object.fromEntries(prev.map(o => [o.car, o.rank])) };
  }
  const rows = L.computeStandings(upTo(n)).map(x => ({ ...x, top5: (x.bestPositions || []).slice(0, 5) }));
  const prev = prevRound ? L.computeStandings(upTo(prevRound)) : [];
  return { rows, prevRank: Object.fromEntries(prev.map(x => [x.driver, x.rank])) };
}

/* Метрика участников на следующий этап (п. 8.8) */
function roundMetric(s, round) {
  const { L, st } = s;
  const n = Number(round);
  const field = st.roundMaxPos[n] || 40;
  const rows = st.races.rowsWithDuel.filter(r => r['Round'] < n + 1);
  const quals = st.quals.rows.filter(r => r['Round'] < n + 1);
  // место в чемпионате после этапа; не стартовавшие идут за последним в зачёте
  const champ = L.metricChampRanks(
    n > L.CHASE_START ? L.computeChaseStandings(rows) : L.computeStandings(rows), quals);
  const owners = ownersUpTo(s, n, 'auto');
  const ownerRank = Object.fromEntries(owners.map(o => [o.car, o.rank]));

  // номер и команда — по последней заявке пилота, плюс кто позже ездил под этим номером
  const last = {}, lastOfCar = {};
  for (const r of [...quals, ...rows]) {
    const d = r['Driver'], car = r['#'], rnd = r['Round'];
    if (!d || !car || car === '-' || rnd == null) continue;
    if (!(last[d]?.rnd > rnd)) last[d] = { rnd, car: String(car), team: r['Team'] && r['Team'] !== '—' ? r['Team'] : '—' };
    if (!(lastOfCar[car]?.rnd > rnd)) lastOfCar[car] = { rnd, driver: d };
  }
  const posOf = Object.fromEntries(st.races.rows
    .filter(r => parseFloat(r['Round']) === n && r['Pos.'] != null).map(r => [r['Driver'], r['Pos.']]));

  const list = L.computeNextMetric(Object.keys(champ).map(driver => {
    const { car = '—', team = '—' } = last[driver] || {};
    const pos = posOf[driver] ?? null;
    const other = lastOfCar[car]?.driver;
    return {
      driver, team, car, pos, place: pos ?? field + 1, champRank: champ[driver],
      ownerRank: ownerRank[car] ?? owners.length + 1, carNote: other && other !== driver ? other : null,
    };
  }));
  return { field, rows: list };
}

/* ── Карточки ── */

function driverCard(s, driver, mode) {
  const { L, st } = s;
  const qualsOnly = mode === 'quals';
  const rowByRound = rows => {
    const m = {};
    for (const r of rows) {
      if (r['Driver'] !== driver) continue;
      const rnd = r['Round'], pos = r['Pos.'];
      if (rnd == null) continue;
      // строка без места — DQ: этап показываем, но реальное место её перебивает
      const cur = m[rnd];
      if (!cur || (pos != null && (cur['Pos.'] == null || pos < cur['Pos.']))) m[rnd] = r;
    }
    return m;
  };
  const raceRow = rowByRound(st.races.rows), qualRow = rowByRound(st.quals.rows);
  const rounds = [...new Set((qualsOnly ? Object.keys(qualRow) : [...Object.keys(raceRow), ...Object.keys(qualRow)])
    .map(Number))].filter(r => !L.SPRINT_ROUNDS.has(r)).sort((a, b) => a - b);

  const cells = rounds.map(r => {
    const rr = raceRow[r], qr = qualRow[r];
    const racePos = rr ? rr['Pos.'] ?? null : null;
    const qualPos = qr ? qr['Pos.'] ?? null : null;
    return {
      round: r,
      // гостевая заявка: результат есть, а очков в личный зачёт этап не даёт
      guest: !!(qualsOnly ? qr?.guest : (rr?.guest ?? qr?.guest)),
      qualPos, qualDQ: !!qr && qualPos == null, qualPts: qr ? qr['Points'] ?? null : null,
      racePos, raceDQ: !!rr && racePos == null, racePts: rr ? rr['Points'] ?? null : null,
      diff: racePos != null && qualPos != null ? qualPos - racePos : null,
      metric: st.metricQuals.has(r),
      nascar: qualsOnly ? L.scorePts(qualPos, r) : L.scorePts(racePos, r),
    };
  });

  withCharts(s);
  const history = (qualsOnly ? st.qualRankHistory : st.rankHistory)[driver] || {};
  return { rounds: cells, history };
}

function teamCard(s, team) {
  const { L, st } = s;
  withTeams(s);
  withCharts(s);
  const t = st.teamPivot.find(x => x.team === team) || st.teamStandings.find(x => x.team === team);
  if (!t) return { team: null, rounds: [], history: {} };

  const rounds = st.races.rounds.filter(r => !L.SPRINT_ROUNDS.has(r));
  let cum = 0;
  const rows = rounds.map(r => {
    const got = t.roundPts[r] || 0;
    cum = t.cumPts?.[r] ?? (cum + got);
    const atRound = L.computeTeamStandings(st.races.rowsWithDuel.filter(x => x['Round'] === r));
    const rankInRound = atRound.findIndex(x => x.team === team) + 1 || null;
    return {
      round: r, best: (t.roundBest[r] || []).filter(x => x.pos != null),
      pts: got, rankInRound, total: cum, rank: st.teamRankHistory[team]?.[r] ?? null,
    };
  });
  // актуальная метрика команды — на последнем проведённом этапе
  let metric = null;
  if (st.entries) {
    const mr = L.entriesRounds();
    const last = mr[mr.length - 1];
    if (last != null) {
      const list = L.entriesRows(last);
      const row = list.find(x => x.team === team);
      if (row) metric = { round: last, score: row.metric, rank: row.rank, ranked: row.ranked, pct: row.pct };
    }
  }
  return { team: t, rounds: rows, history: st.teamRankHistory[team] || {}, metric };
}

/* ── Сводка сезона для первого экрана ── */
function seasonSummary(s) {
  const { L, st } = s;
  const setArr = x => [...(x || [])];
  const mapOfSets = m => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, [...v]]));
  const drivers = new Set([...st.races.rows, ...st.quals.rows].map(r => r['Driver']).filter(Boolean));
  const teams = new Set(st.races.rows.map(r => r['Team']).filter(Boolean));
  const [leader, second] = st.races.standings;
  // этапы, по которым есть протокол: этап 0 (The Clash) тоже, дуэли выбираются внутри первого
  const protocolRounds = [...new Set([...L.uniqueRounds(st.races.rows), ...L.uniqueRounds(st.quals.rows)])]
    .filter(n => !L.SPRINT_ROUNDS.has(n)).sort((a, b) => a - b);

  return {
    season: st.year, division: st.division,
    kpi: {
      numRaces: st.races.rounds.length,
      numQuals: st.quals.rounds.filter(r => !L.SPRINT_ROUNDS.has(r)).length,
      drivers: drivers.size, teams: teams.size,
      leader: leader ? { driver: leader.driver, team: leader.team, total: leader.total } : null,
      second: second ? { driver: second.driver, total: second.total } : null,
      gap: leader && second ? leader.total - second.total : 0,
    },
    rounds: { races: st.races.rounds, quals: st.quals.rounds },
    standings: { races: slim(st.races.standings), quals: slim(st.quals.standings) },
    protocolRounds,
    roundNames: st.roundNames, roundAbb: st.roundAbb,
    metricQuals: setArr(st.metricQuals),
    coalitions: setArr(st.coalitions),
    guestByChange: setArr(st.guestByChange),
    deductions: st.deductions, teamOf: st.teamOf, carOf: st.carOf, roundMaxPos: st.roundMaxPos,
    attendance: { races: mapOfSets(st.attendance.races), quals: mapOfSets(st.attendance.quals) },
    qualsParticipation: mapOfSets(st.qualsParticipation),
  };
}

/* ── Точка входа: те же имена и параметры, что были у функций базы ── */
const LOCAL_API = {
  season_summary: s => seasonSummary(s),
  slice: (s, p) => sliceOf(s, p.session, p.upto, p.chase || 'auto'),

  pivot: (s, p) => {
    const { map, rounds, order, qualMap, rankOf } = s.L.buildPivotData(p.session === 'qual' ? 'quals' : 'races');
    const totals = Object.fromEntries((p.session === 'qual' ? s.st.quals.standings : s.st.races.standings)
      .map(x => [x.driver, x.total]));
    // в сводной гонок место в квалификации не показываем
    return { map, rounds, order, qualMap: p.session === 'qual' ? qualMap : null, rankOf, totals };
  },

  gains: s => { withGains(s); return s.st.gains; },

  chart_points: (s, p) => {
    withCharts(s);
    const list = p.session === 'qual' ? s.st.quals.chartStandings : s.st.races.chartStandings;
    return list.map(x => ({ driver: x.driver, team: x.team, roundPts: x.roundPts }));
  },

  team_standings: (s, p) => {
    withTeams(s);
    return p.with_guest_only ? s.st.teamPivot : s.st.teamStandings;
  },

  /* Метрика: этапов теперь столько, сколько проведено, поэтому считаем строки только
     на запрошенный срез — остальные фронт дозапросит, когда их выберут. */
  metric: (s, p) => {
    withTeams(s);
    if (!s.st.entries) return { rounds: [], byRound: {} };
    const rounds = s.L.entriesRounds();
    const at = p.upto == null ? rounds[rounds.length - 1] : Number(p.upto);
    return { rounds, byRound: rounds.includes(at) ? { [at]: s.L.entriesRows(at) } : {} };
  },

  golub: (s, p) => { withGolub(s); return (s.st.golub || {})[p.session === 'qual' ? 'quals' : 'races'] || null; },

  round_protocol: (s, p) => roundProtocol(s, p.round, p.view),
  round_standings: (s, p) => roundStandings(s, p.round, p.kind),
  round_metric: (s, p) => roundMetric(s, p.round),
  driver_card: (s, p) => driverCard(s, p.driver, p.mode),
  team_card: (s, p) => teamCard(s, p.team),
};

/* Вызов «функции данных»: имя и параметры те же, что у прежних функций базы.
   Лист (sheet) обрабатывается в core.js — он идёт прямо с Google Sheets. */
async function localRpc(fn, params = {}, fresh = false) {
  const impl = LOCAL_API[fn];
  if (!impl) throw new Error(`Неизвестный запрос данных: ${fn}`);
  const s = await getSeason(params.season ?? state.year, params.division ?? state.division, fresh);
  return impl(s, params);
}
