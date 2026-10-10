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

   В новой таблице строка заявки — это year, div, team, num, fulltime, цвета номера bg/fg,
   man, период, на который машина числится за командой (from/to), период заявления
   фулл-тайма (ft_from/ft_to, у парт-тайма пусто), число поданных прогнозов (count) и
   признаки факта по этапам. Колонки читаем по именам — их порядок в листе меняется.
   Метрике нужен именно ПЛАН — этапы заявления; факт она считает сама по листу
   квалификаций. Поэтому отмечаем период заявления, а парт-тайм машины (периода нет)
   в фулл-тайм не попадают. */
const entriesOf = (entryRows, year, division) =>
  entryRows.filter(r => r.year === year && r.div === DIV_CODE[division]);

function entriesMatrix(entryRows, year, division) {
  const mine = entriesOf(entryRows, year, division);
  if (!mine.length) return [];

  const declared = r => r.fulltime === true && r.ft_from != null && r.ft_to != null
    ? [Number(r.ft_from), Number(r.ft_to)] : null;
  const last = Math.max(...mine.map(r => declared(r)?.[1] ?? 0));
  const head = { Team: null, Car: null };
  for (let rnd = 0; rnd <= last; rnd++) head['R' + rnd] = rnd;

  return [head, ...mine.map(r => {
    const row = { Team: r.team, Car: String(r.num ?? '') };
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
  // цвета номера машины (bg/fg — hex без #); номер в сезоне и дивизионе однозначен
  st.carColors = Object.fromEntries(entriesOf(entryRows, year, division)
    .filter(r => r.num != null && r.bg && r.fg)
    .map(r => [String(r.num), { bg: r.bg, fg: r.fg }]));
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

/* Реальный Чейз (очки сброшены на сетку): «авто» — после 26 этапа; ручной выбор «Чейз» —
   с 26 этапа (на нём видна стартовая сетка Чейза), раньше не действует */
const isRealChase = (L, chase, n) => (chase === 'chase' && n >= L.CHASE_START)
  || (chase !== 'regular' && n > L.CHASE_START);

const ownersUpTo = ({ L, st }, at, chase) => {
  const rows = st.races.rowsWithDuel.filter(r => r['Round'] < at + 1);
  const real = isRealChase(L, chase, at);
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
    const real = isRealChase(L, chase, n);
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
     - в регулярном сезоне: в топ-16 — запас над первым вне Чейза, ниже — отставание
       от последнего в Чейзе (гостям и стоящим внутри зоны Чейза без ценза — нет). */
  const playoffSet = L.buildPlayoffSet(all, at);
  const real = isRealChase(L, chase, at);
  const inChase = all.filter(x => playoffSet.has(x.driver));
  let lastChaseIdx = -1;
  all.forEach((x, i) => { if (playoffSet.has(x.driver)) lastChaseIdx = i; });
  // 17-й в списке: первая строка после границы, кто бы это ни был
  const afterChase = all[lastChaseIdx + 1] || null;
  const firstOut = all.find(x => !x.isGuest && !playoffSet.has(x.driver) && L.qualEligible(x.driver, at));
  const lastIn = inChase[inChase.length - 1], leader = inChase[0];

  /* Регулярный сезон на срезе с 26 этапа: граница Чейза уже не нужна — без подсветки
     и отсечки, «±» считается от лидера зачёта */
  if (!real && at >= L.CHASE_START) {
    const top = all.find(x => x.rank != null);
    const standings = all.map(x => ({ ...x, playoff: false, cutoff: false, gap: top ? x.total - top.total : null }));
    return { at, rounds, standings, prevRank };
  }

  const standings = all.map((x, i) => {
    const playoff = playoffSet.has(x.driver);
    const ref = real ? (playoff ? leader : afterChase) : (playoff ? firstOut : lastIn);
    /* в регулярном сезоне: гостю «±» не считается; не прошедшему ценз — только если он
       ниже всех чейзовых (стоит выше хоть одного из них — отставания нет, есть место) */
    const skip = !real && (x.isGuest || (!L.qualEligible(x.driver, at) && i < lastChaseIdx));
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
/* Участники Чейза своей сессии: у посеянных после 26 этапа в готовом зачёте есть chaseSeed.
   Пока сезон не дошёл до Чейза, зачёт обычный и сет пустой. */
const chaseSet = (st, kind) => new Set(st[kind].standings.filter(x => x.chaseSeed != null).map(x => x.driver));

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
  // размер стартового поля последней проведённой гонки (Open — 50, Star — 40)
  const lastRace = st.races.rounds.filter(r => r > 0 && !L.SPRINT_ROUNDS.has(r) && r <= n).pop();
  const expectedField = st.roundMaxPos[lastRace] || 40;
  // с 27 этапа подсвечиваем участников Чейза: в гонке — Чейза гонок, в квале — Чейза квал
  const chase = n > L.CHASE_START && (isRace || view === 'qual') ? chaseSet(st, isRace ? 'races' : 'quals') : null;

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
      : view === 'qual' ? (n === 1 ? duelDrivers.has(r['Driver'])
        // гонки этапа ещё нет — проходят первые по размеру поля последней проведённой гонки
        : raceDrivers.size ? raceDrivers.has(r['Driver']) : r['Pos.'] != null && r['Pos.'] <= expectedField)
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
      nascar: L.scorePts(r['Pos.'], roundNum), made, delta, hl, guest: !!r.guest,
      chase: !!chase?.has(r['Driver']),
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
  // не прошёл в гонку: подавал прогноз на квалу этапа — поле этапа + 1 (Open 51, Star 41),
  // не подавал вовсе — число подавших + 1
  const submitted = new Set(st.quals.rows.filter(r => r['Round'] === n && r['Driver']).map(r => r['Driver']));
  const noStart = d => submitted.has(d) ? field + 1 : submitted.size + 1;

  const list = L.computeNextMetric(Object.keys(champ).map(driver => {
    const { car = '—', team = '—' } = last[driver] || {};
    const pos = posOf[driver] ?? null;
    const other = lastOfCar[car]?.driver;
    return {
      driver, team, car, pos, place: pos ?? noStart(driver), champRank: champ[driver],
      ownerRank: ownerRank[car] ?? owners.length + 1, carNote: other && other !== driver ? other : null,
    };
  }));
  // с 27 этапа — участники Чейза по личному зачёту гонок
  const chase = n > L.CHASE_START ? chaseSet(st, 'races') : null;
  return { field, noStartMax: submitted.size + 1, rows: chase ? list.map(m => ({ ...m, chase: chase.has(m.driver) })) : list };
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
    const guest = !!(qualsOnly ? qr?.guest : (rr?.guest ?? qr?.guest));
    return {
      round: r,
      // гостевая заявка: у пилота со своими заявками очки этапа мимо личного зачёта,
      // у гостя они считаются (он весь вне основного зачёта)
      guest, counted: !guest || L.isGuestDriver(driver),
      qualPos, qualDQ: !!qr && qualPos == null, qualPts: qr ? qr['Points'] ?? null : null,
      racePos, raceDQ: !!rr && racePos == null, racePts: rr ? rr['Points'] ?? null : null,
      diff: racePos != null && qualPos != null ? qualPos - racePos : null,
      metric: st.metricQuals.has(r),
      nascar: qualsOnly ? L.scorePts(qualPos, r) : L.scorePts(racePos, r),
    };
  });

  /* Очки гостевых заявок, которые мимо личного зачёта (у пилота есть и свои заявки):
     в карточке они подписываются под очками, чтобы «0 очков при 8 гонках» не выглядело ошибкой */
  const guestPts = rows => {
    if (L.isGuestDriver(driver)) return { pts: 0, n: 0 };
    const mine = rows.filter(r => r['Driver'] === driver && r.guest && r['Round'] !== 0
      && !L.SPRINT_ROUNDS.has(r['Round']));
    return { pts: mine.reduce((sum, r) => sum + L.scorePts(r['Pos.'], r['Round']), 0), n: mine.length };
  };

  withCharts(s);
  const history = (qualsOnly ? st.qualRankHistory : st.rankHistory)[driver] || {};
  return { rounds: cells, history, guest: { races: guestPts(st.races.rows), quals: guestPts(st.quals.rows) } };
}

/* Карточка машины (зачёт владельцев, п. 9.6): кто и как выступал под номером по этапам,
   итог и место машины, история места после каждого этапа. Гость очки машине приносит. */
function carCard(s, car) {
  const { L, st } = s;
  const mine = rows => rows.filter(r => String(r['#']) === String(car) && !L.SPRINT_ROUNDS.has(r['Round']));
  const race = mine(st.races.rows), qual = mine(st.quals.rows);
  const rounds = [...new Set([...race, ...qual].map(r => r['Round']))].sort((a, b) => a - b);
  const cells = rounds.map(n => {
    const rr = race.find(r => r['Round'] === n), qr = qual.find(r => r['Round'] === n);
    const racePos = rr ? rr['Pos.'] ?? null : null;
    return {
      round: n, driver: (rr || qr)['Driver'], guest: !!(rr || qr).guest,
      qualPos: qr ? qr['Pos.'] ?? null : null, qualDQ: !!qr && qr['Pos.'] == null,
      qualPts: qr ? qr['Points'] ?? null : null,
      racePos, raceDQ: !!rr && racePos == null, racePts: rr ? rr['Points'] ?? null : null,
      nascar: rr ? L.scorePts(racePos, n) : null,
    };
  });

  const held = st.races.rounds.filter(r => !L.SPRINT_ROUNDS.has(r));
  const last = held[held.length - 1];
  const o = last == null ? null : ownersUpTo(s, last, 'auto').find(x => String(x.car) === String(car)) || null;
  const pos = o ? o.positions : [];
  const stats = o && {
    rank: o.rank, total: o.total, wins: o.wins, best: o.best === Infinity ? null : o.best,
    team: o.team, mfr: o.mfr, drivers: o.drivers,
    starts: race.filter(r => r['Round'] !== 0).length, held: held.filter(r => r !== 0).length,
    avg: pos.length ? (pos.reduce((a, b) => a + b, 0) / pos.length).toFixed(1) : null,
    top5: pos.filter(p => p <= 5).length, top10: pos.filter(p => p <= 10).length,
  };
  const history = {};
  for (const r of held) {
    const x = ownersUpTo(s, r, 'auto').find(y => String(y.car) === String(car));
    if (x) history[r] = x.rank;
  }
  return { stats, rounds: cells, history };
}

/* ── Head-to-head: два пилота или две команды ──
   Счёт «кто выше» — только по этапам, где место есть у обоих (DQ и пропуски не в счёт).
   Дуэли и этап 0 (The Clash) не учитываются, как и в остальной статистике. */
// metric === false — квалификации по метрике в сравнении не учитываются
const h2hQualRows = (st, metric) => metric === false
  ? st.quals.rows.filter(r => !st.metricQuals.has(r['Round'])) : st.quals.rows;

function h2hDrivers(s, a, b, metric) {
  const { L, st } = s;
  withCharts(s);
  // лучшее место пилота на этапе, очки за прогноз (Points) и зачётные NASCAR, гостевая заявка
  const byRound = (rows, d) => {
    const m = {};
    for (const r of rows) {
      const rnd = r['Round'];
      if (r['Driver'] !== d || rnd == null || rnd === 0 || L.SPRINT_ROUNDS.has(rnd)) continue;
      const cur = m[rnd], pos = r['Pos.'] ?? null;
      if (!cur || (pos != null && (cur.pos == null || pos < cur.pos)))
        m[rnd] = { pos, guest: !!r.guest, pts: r['Points'] ?? null, nascar: L.scorePts(pos, rnd) };
    }
    return m;
  };
  const ra = byRound(st.races.rows, a), rb = byRound(st.races.rows, b);
  const qrows = h2hQualRows(st, metric);
  const qa = byRound(qrows, a), qb = byRound(qrows, b);
  const score = (x, y) => {
    const out = { a: 0, b: 0 };
    for (const r in x) {
      const pa = x[r]?.pos, pb = y[r]?.pos;
      if (pa == null || pb == null || pa === pb) continue;
      pa < pb ? out.a++ : out.b++;
    }
    return out;
  };
  const rounds = [...new Set([ra, rb, qa, qb].flatMap(m => Object.keys(m)).map(Number))].sort((x, y) => x - y);
  return {
    races: score(ra, rb), quals: score(qa, qb),
    // квалы по метрике: прогнозные очки там «меньше — лучше»
    metric: metric === false ? [] : [...st.metricQuals],
    rounds: rounds.map(r => ({
      round: r,
      a: { qual: qa[r] ?? null, race: ra[r] ?? null },
      b: { qual: qb[r] ?? null, race: rb[r] ?? null },
    })),
    history: { a: st.rankHistory[a] || {}, b: st.rankHistory[b] || {} },
  };
}

/* Команды: гонки — командный зачёт (два лучших результата за этап), квалификации — тот же
   расчёт на протоколах квал (только для сравнения здесь, официального зачёта у квал нет) */
function h2hTeams(s, a, b, metric) {
  const { L, st } = s;
  withTeams(s);
  withCharts(s);
  const rounds = st.races.rounds.filter(r => r !== 0 && !L.SPRINT_ROUNDS.has(r));
  const session = list => {
    const ta = list.find(t => t.team === a), tb = list.find(t => t.team === b);
    const side = t => r => ({
      pts: t?.roundPts[r] || 0,
      pos: (t?.roundBest[r] || []).filter(x => x.pos != null).map(x => x.pos),
    });
    const sa = side(ta), sb = side(tb);
    // этап в счёт, только если зачётный результат был у обеих команд
    const score = { a: 0, b: 0 };
    for (const r of rounds) {
      const x = sa(r), y = sb(r);
      if (!x.pos.length || !y.pos.length || x.pts === y.pts) continue;
      x.pts > y.pts ? score.a++ : score.b++;
    }
    const stats = t => t && {
      rank: t.rank, total: t.total, drivers: t.drivers.length,
      wins: t.bestPositions.filter(p => p === 1).length, best: t.bestPositions[0] ?? null,
      scored: rounds.filter(r => (t.roundBest[r] || []).some(x => x.pos != null)).length,
    };
    return { score, stats: { a: stats(ta), b: stats(tb) }, byRound: Object.fromEntries(rounds.map(r => [r, { a: sa(r), b: sb(r) }])) };
  };
  const races = session(st.teamPivot);
  // штрафы (Deductions) снимаются с командного зачёта гонок — к сравнению квал они не относятся
  const ded = st.deductions;
  st.deductions = {};
  let qualTeams;
  try { qualTeams = L.computeTeamStandings(h2hQualRows(st, metric), true); } finally { st.deductions = ded; }
  const quals = session(qualTeams);
  return {
    races, quals,
    rounds: rounds.map(r => ({ round: r, qual: quals.byRound[r], race: races.byRound[r] })),
    history: { a: st.teamRankHistory[a] || {}, b: st.teamRankHistory[b] || {} },
  };
}

/* ── Вкладка «Прочее»: зачёт производителей, текущие серии, подиумы / топ-5 / топ-10 ──
   Отдельно по гонкам и квалификациям; дуэли, этап 0 и гостевые заявки не учитываются. */
function funStats(s, session) {
  const { L, st } = s;
  const src = session === 'qual' ? st.quals.rows : st.races.rows;
  const rows = src.filter(r => r['Driver'] && r['Round'] !== 0 && !L.SPRINT_ROUNDS.has(r['Round'])
    && !r.guest && !L.isGuestDriver(r['Driver']));
  const rounds = [...new Set(rows.map(r => r['Round']))].sort((a, b) => a - b);

  /* При равенстве место общее, а порядок строк — по месту в зачёте после последнего этапа:
     пилоты — в зачёте своей сессии, команды — в командном зачёте */
  withTeams(s);
  const standRank = list => Object.fromEntries(list.filter(x => x.rank != null).map(x => [x.driver ?? x.team, x.rank]));
  const driverRank = standRank(session === 'qual' ? st.quals.standings : st.races.standings);
  const teamRank = standRank(st.teamStandings);
  const byStanding = (ranks, a, b) => (ranks[a] ?? Infinity) - (ranks[b] ?? Infinity) || a.localeCompare(b);

  // 1. Производители: на этапе у марки в зачёт идёт её лучший финиш — очки за него, как в NASCAR.
  //    Считается машина, поэтому гостевые заявки здесь учитываются
  const mfrRows = src.filter(r => r['Driver'] && r['Round'] !== 0 && !L.SPRINT_ROUNDS.has(r['Round']));
  const mfr = {};
  for (const n of rounds) {
    const best = {};
    for (const r of mfrRows) {
      if (r['Round'] !== n || r['Pos.'] == null || !r['M.']) continue;
      const k = mfrKey(r['M.']);
      if (!best[k] || r['Pos.'] < best[k]['Pos.']) best[k] = r;
    }
    for (const [k, r] of Object.entries(best)) {
      const m = mfr[k] ||= { mfr: r['M.'], points: 0, wins: 0, byRound: {} };
      const pts = L.scorePts(r['Pos.'], n);
      m.points += pts;
      if (r['Pos.'] === 1) m.wins++;
      m.byRound[n] = { pos: r['Pos.'], driver: r['Driver'], pts };
    }
  }
  const manufacturers = Object.values(mfr).sort((a, b) => b.points - a.points || b.wins - a.wins);

  // 2. Текущие серии: подряд идущие этапы с конца, пока у пилота есть строка на этапе
  const present = {};
  for (const r of rows) (present[r['Driver']] ||= new Set()).add(r['Round']);
  const streaks = Object.entries(present).map(([driver, set]) => {
    let len = 0;
    for (let i = rounds.length - 1; i >= 0 && set.has(rounds[i]); i--) len++;
    // последний пропуск — этап перед началом серии (null — пропусков не было с начала сезона)
    const missed = len && rounds.length > len ? rounds[rounds.length - len - 1] : null;
    return { driver, len, from: len ? rounds[rounds.length - len] : null, missed, team: st.teamOf[driver] || '—' };
  }).filter(x => x.len > 0).sort((a, b) => b.len - a.len || byStanding(driverRank, a.driver, b.driver));

  // 3. Подиумы / топ-5 / топ-10 — по пилотам и по командам заявки
  /* Рейтинг «пилоты и команды»: value(r) — вклад строки (число; 0 — не в счёт).
     Нулевых в списке нет; равные делят место, а стоят по месту в зачёте */
  // src — строки для подсчёта (по умолчанию все)
  const rate = (value, src = rows) => {
    const byDriver = {}, byTeam = {};
    for (const r of src) {
      const v = value(r);
      if (!v) continue;
      byDriver[r['Driver']] = (byDriver[r['Driver']] || 0) + v;
      const t = r['Team'];
      if (t && t !== '—' && t !== 'Guest entry') byTeam[t] = (byTeam[t] || 0) + v;
    }
    const rank = (m, ranks) => {
      const list = Object.entries(m).map(([name, n]) => ({ name, n: Math.round(n * 100) / 100 }))
        .filter(x => x.n > 0)
        .sort((a, b) => b.n - a.n || byStanding(ranks, a.name, b.name));
      list.forEach((x, i) => { x.rank = i && x.n === list[i - 1].n ? list[i - 1].rank : i + 1; });
      return list;
    };
    return { drivers: rank(byDriver, driverRank), teams: rank(byTeam, teamRank) };
  };
  const top = limit => rate(r => r['Pos.'] != null && r['Pos.'] <= limit ? 1 : 0);

  /* Допы гонки: CAU, RET, DUE (есть только в Star) и все вместе с MN. Только гонки на машинах,
     заявленных на полное расписание (лист entries, период заявления фулл-тайма); сумма за сезон */
  const fullTime = rows.filter(r => st.entries?.[r['Team']]?.[String(r['#'])]?.has(r['Round']));
  const bonus = k => r => Number(r[k]) || 0;
  const bonuses = session === 'qual' ? null : {
    cau: rate(bonus('CAU'), fullTime), ret: rate(bonus('RET'), fullTime),
    due: fullTime.some(r => r['DUE']) ? rate(bonus('DUE'), fullTime) : null,
    all: rate(r => ['CAU', 'RET', 'DUE', 'MN'].reduce((sum, k) => sum + bonus(k)(r), 0), fullTime),
  };

  /* Командные этапы: очки команды за этап — сумма очков NASCAR двух зачётных результатов
     (правило командного зачёта). В квалах — тот же расчёт на протоколах квал; штрафы
     Deductions к результату этапа не относятся. */
  const ded = st.deductions;
  st.deductions = {};
  let teamList;
  try { teamList = L.computeTeamStandings(src, true); } finally { st.deductions = ded; }
  const teamRounds = teamList.flatMap(t => Object.entries(t.roundPts).map(([rnd, pts]) => ({
    team: t.team, round: Number(rnd), pts,
    pos: (t.roundBest[rnd] || []).filter(x => x.pos != null).map(x => x.pos).sort((a, b) => a - b),
  }))).filter(x => x.pts > 0 && x.round !== 0 && !L.SPRINT_ROUNDS.has(x.round));

  // топ командных этапов сезона (одна команда может встречаться несколько раз); равные делят место
  const teamBest = [...teamRounds].sort((a, b) => b.pts - a.pts || a.round - b.round || byStanding(teamRank, a.team, b.team)).slice(0, 30);
  teamBest.forEach((x, i) => { x.rank = i && x.pts === teamBest[i - 1].pts ? teamBest[i - 1].rank : i + 1; });

  // лучшая команда каждого этапа; при равных очках — та, чей лучший результат на этапе выше,
  // затем второй результат, затем командный зачёт
  const pos = (x, i) => x.pos[i] ?? Infinity;
  const roundBestTeam = rounds.map(n => {
    const best = teamRounds.filter(x => x.round === n).sort((a, b) => b.pts - a.pts
      || pos(a, 0) - pos(b, 0) || pos(a, 1) - pos(b, 1) || byStanding(teamRank, a.team, b.team))[0];
    return best && { round: n, pts: best.pts, teams: [{ team: best.team, pos: best.pos }] };
  }).filter(Boolean);

  /* Максимальный результат: этап, где у участника жёлтым (лучшим на этапе — та же подсветка hl,
     что в протоколе) подсвечены все колонки прогноза: в гонке QL, DR1–DR4, CAU, RET, MN,
     в квале DR1–DR4. Позиция и очки не в счёт. Гостевые заявки учитываются; квалы по метрике
     (без DR) — нет. Считается количество таких этапов у пилотов и команд. */
  const view = session === 'qual' ? 'qual' : 'race';
  const maxKeys = view === 'race' ? ['QL', 'DR1', 'DR2', 'DR3', 'DR4', 'CAU', 'RET', 'MN'] : ['DR1', 'DR2', 'DR3', 'DR4'];
  const maxRows = rounds.filter(n => !(view === 'qual' && st.metricQuals.has(n)))
    .flatMap(n => roundProtocol(s, n, view).rows)
    .filter(x => x['Driver'] && ['DR1', 'DR2', 'DR3', 'DR4'].every(k => x[k] != null)
      && maxKeys.every(k => x[k] == null || x.hl?.includes(k)));
  const maxResults = rate(() => 1, maxRows);

  return {
    rounds, manufacturers, streaks: rankStreaks(streaks).slice(0, 30), teamBest, roundBestTeam, maxResults,
    wins: top(1), podium: top(3), top5: top(5), top10: top(10), bonuses,
  };
}

// места у серий: равные делят место
function rankStreaks(list) {
  list.forEach((x, i) => { x.rank = i && x.len === list[i - 1].len ? list[i - 1].rank : i + 1; });
  return list;
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

/* ── Статистика пилота или команды за сезон — по гонкам или по квалам (session).
   Команда — по любому своему пилоту: строки всех, кто ехал за неё (гостевые заявки тоже).
   Строка без места (DQ) — участие, не место. noMetric — без квал по метрике. ── */
function statsCard(s, kind, name, session, noMetric) {
  const { L, st } = s;
  const isTeam = kind === 'team', isQual = session === 'qual';
  const skip = n => n === 0 || L.SPRINT_ROUNDS.has(n) || (isQual && noMetric && st.metricQuals.has(n));
  const srcAll = (isQual ? st.quals.rows : st.races.rows).filter(r => r['Driver'] && !skip(r['Round']));
  const mine = r => isTeam ? r['Team'] === name : r['Driver'] === name;
  const byRound = (a, b) => a['Round'] - b['Round'] || (a['Pos.'] ?? Infinity) - (b['Pos.'] ?? Infinity);
  const rows = srcAll.filter(mine).sort(byRound);
  const placed = list => list.filter(r => r['Pos.'] != null);
  const hit = r => r && { round: r['Round'], driver: r['Driver'], pos: r['Pos.'], car: r['#'], mfr: r['M.'] };
  const first = maxPos => hit(placed(rows).find(r => r['Pos.'] <= maxPos));
  const held = (isQual ? st.quals.rounds : st.races.rounds).filter(n => !skip(n));

  // первый ряд — у команды на одном этапе P1 и P2
  const frontRow = () => {
    const n = held.find(n => [1, 2].every(p => rows.some(r => r['Round'] === n && r['Pos.'] === p)));
    return n == null ? null : { round: n, drivers: [1, 2].map(p => hit(rows.find(r => r['Round'] === n && r['Pos.'] === p))) };
  };
  const firsts = { p1: first(1), p3: first(3), p10: first(10), p20: first(20), frontRow: isTeam && isQual ? frontRow() : null };

  // серия — подряд идущие проведённые этапы, где ok(этап) выполняется
  const series = ok => {
    let best = { len: 0 }, cur = { len: 0 };
    for (const n of held) {
      cur = ok(n) ? { len: cur.len + 1, from: cur.len ? cur.from : n, to: n } : { len: 0 };
      if (cur.len > best.len) best = cur;
    }
    return { best, current: cur };
  };
  const myRounds = new Set(rows.map(r => r['Round']));
  const qualRounds = new Set(st.quals.rows.filter(r => r['Driver'] && mine(r) && r['Round'] !== 0
    && !L.SPRINT_ROUNDS.has(r['Round'])).map(r => r['Round']));
  // команда: на этапе в серию топ-10 идёт её лучший результат
  const bestPos = n => Math.min(...placed(rows).filter(r => r['Round'] === n).map(r => r['Pos.']));

  const avgMed = list => {
    const p = list.map(r => r['Pos.']).sort((a, b) => a - b), mid = p.length >> 1;
    return p.length ? { avg: p.reduce((a, b) => a + b, 0) / p.length, median: p.length % 2 ? p[mid] : (p[mid - 1] + p[mid]) / 2 } : null;
  };
  const am = avgMed(placed(rows));
  const bestPlace = am && Math.min(...placed(rows).map(r => r['Pos.']));
  const pos = am && { best: bestPlace, bestList: placed(rows).filter(r => r['Pos.'] === bestPlace).map(hit), ...am };
  /* место по среднему и по медиане (меньше — лучше): команды — среди всех команд,
     пилоты — среди всех пилотов, кроме гостей */
  const groupOf = r => isTeam ? (r['Team'] && r['Team'] !== '—' && r['Team'] !== 'Guest entry' ? r['Team'] : null)
    : (L.isGuestDriver(r['Driver']) ? null : r['Driver']);
  const groups = {};
  for (const r of placed(srcAll)) { const g = groupOf(r); if (g) (groups[g] ||= []).push(r); }
  if (pos) {
    const list = Object.values(groups).map(avgMed);
    pos.avgRank = list.filter(x => x.avg < am.avg).length + 1;
    pos.medianRank = list.filter(x => x.median < am.median).length + 1;
    pos.of = list.length;
  }

  /* Очки — NASCAR (55-35-34…), Points листа на разных этапах в разной шкале.
     Пилот — за своё место; команда — очки команды за этап (два зачётных результата). */
  const teamList = L.computeTeamStandings(srcAll, true);
  let ptsRounds;
  if (isTeam) {
    const t = teamList.find(x => x.team === name);
    ptsRounds = Object.entries(t?.roundPts || {}).map(([n, pts]) => ({ round: Number(n), pts,
      // зачётные результаты этапа — строки протокола (место, номер машины)
      drivers: (t.roundBest[n] || []).filter(x => x.pos != null).sort((a, b) => a.pos - b.pos)
        .map(x => hit(rows.find(r => r['Round'] === Number(n) && r['Driver'] === x.driver && r['Pos.'] === x.pos))).filter(Boolean) })).filter(x => !skip(x.round));
  } else {
    ptsRounds = placed(rows).map(r => ({ round: r['Round'], pts: L.scorePts(r['Pos.'], r['Round']), pos: r['Pos.'] }));
  }
  const topPts = [...ptsRounds].sort((a, b) => b.pts - a.pts || a.round - b.round)[0] || null;
  // место по средним очкам NASCAR за этап — среди тех же команд / пилотов
  const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
  const myAvgPts = mean(ptsRounds.map(x => x.pts));
  const avgPtsAll = isTeam
    ? teamList.filter(t => groups[t.team]).map(t => mean(Object.entries(t.roundPts).filter(([n]) => !skip(Number(n))).map(([, v]) => v)))
    : Object.values(groups).map(list => mean(list.map(r => L.scorePts(r['Pos.'], r['Round']))));
  const avgPtsRank = myAvgPts == null ? null : { rank: avgPtsAll.filter(v => v > myAvgPts).length + 1, of: avgPtsAll.length };
  const cnt = maxPos => placed(rows).filter(r => r['Pos.'] <= maxPos).length;

  // Ход позиций в общем зачёте после каждого этапа
  withCharts(s);
  let hist;
  if (!isTeam) hist = (isQual ? st.qualRankHistory : st.rankHistory)[name] || {};
  else if (!isQual) hist = st.teamRankHistory[name] || {};
  else {
    hist = {};
    for (const n of held) {
      const r = L.computeTeamStandings(srcAll.filter(x => x['Round'] <= n)).find(x => x.team === name)?.rank;
      if (r != null) hist[n] = r;
    }
  }
  const path = Object.entries(hist).map(([n, rank]) => ({ round: Number(n), rank }))
    .filter(x => x.rank != null && !skip(x.round)).sort((a, b) => a.round - b.round);
  const pick = cmp => path.length ? path.reduce((a, b) => cmp(b.rank, a.rank) ? b : a) : null;
  const standing = { path, best: pick((a, b) => a < b), worst: pick((a, b) => a > b), leader: path.filter(x => x.rank === 1).length };

  // Чейз — как в зачёте сайта: playoff на последнем срезе своей сессии
  const cur = sliceOf(s, isQual ? 'quals' : 'races').standings;
  let chase;
  if (isTeam) {
    const full = cur.filter(x => x.team === name && !x.isGuest);
    const inChase = full.filter(x => x.playoff);
    // очки команды за этапы Чейза и место среди команд по ним
    const chaseRounds = held.filter(n => n > L.CHASE_START);
    const sum = t => chaseRounds.reduce((a, n) => a + (t.roundPts[n] || 0), 0);
    const score = list => {
      const pts = list.map(t => ({ team: t.team, pts: sum(t) }));
      const my = pts.find(x => x.team === name)?.pts ?? 0;
      return { pts: my, rank: pts.filter(x => x.pts > my).length + 1 };
    };
    // то же, но в зачёт команды идут только её пилоты, попавшие в Чейз
    const playoff = new Set(cur.filter(x => x.playoff).map(x => x.driver));
    // место — только среди команд, у которых есть пилоты в Чейзе (ехали за них в этапах Чейза)
    const chaseRows = srcAll.filter(r => playoff.has(r['Driver']) && chaseRounds.includes(r['Round']));
    const chaseTeams = new Set(chaseRows.map(r => r['Team']));
    /* место — по среднему на одного пилота Чейза: все очки NASCAR её пилотов Чейза за этапы
       Чейза делятся на их число (у команды с одним пилотом в Чейзе иначе меньше результатов) */
    const avgOf = team => {
      const list = chaseRows.filter(r => r['Team'] === team);
      const n = new Set(list.map(r => r['Driver'])).size;
      return n ? list.reduce((a, r) => a + L.scorePts(r['Pos.'], r['Round']), 0) / n : 0;
    };
    const avgs = [...chaseTeams].map(avgOf), myAvg = avgOf(name);
    const onlyChase = { pts: score(L.computeTeamStandings(chaseRows, true)).pts, avg: myAvg,
      rank: avgs.filter(v => v > myAvg).length + 1, teams: chaseTeams.size, inChase: chaseTeams.has(name) };
    chase = { n: inChase.length, full: full.length, drivers: inChase.map(x => x.driver), started: chaseRounds.length > 0,
      ...score(teamList), teams: teamList.length, onlyChase };
  } else {
    const me = cur.find(x => x.driver === name);
    // очки NASCAR только за этапы Чейза и место по ним среди пилотов Чейза
    const chaseRounds = held.filter(n => n > L.CHASE_START);
    const chasePts = d => srcAll.filter(r => r['Driver'] === d && chaseRounds.includes(r['Round']))
      .reduce((a, r) => a + L.scorePts(r['Pos.'], r['Round']), 0);
    const field = cur.filter(x => x.playoff).map(x => chasePts(x.driver));
    const my = chasePts(name);
    chase = { playoff: !!me?.playoff, seed: me?.chaseSeed ?? null, rank: me?.rank ?? null, started: chaseRounds.length > 0,
      pts: my, ptsRank: me?.playoff ? field.filter(v => v > my).length + 1 : null, of: field.length };
    // место по тем же очкам среди всех, кто ехал этапы Чейза (кроме гостей)
    const everyone = [...new Set(srcAll.filter(r => chaseRounds.includes(r['Round']) && !L.isGuestDriver(r['Driver'])).map(r => r['Driver']))].map(chasePts);
    chase.allRank = everyone.filter(v => v > my).length + 1;
    chase.allOf = everyone.length;
  }

  // Напарники: пилот — против тех, кто ехал за ту же команду на том же этапе;
  // команда — лучший пилот по зачёту, сколько разных пилотов, доля гостевых заявок
  let mates;
  if (isTeam) {
    // состав: все, кто ехал за команду, — место и очки в личном зачёте сессии
    const byName = Object.fromEntries(cur.map(x => [x.driver, x]));
    const last = {};
    for (const r of rows) last[r['Driver']] = r;
    const roster = Object.keys(last).map(d => ({ driver: d, car: last[d]['#'], mfr: last[d]['M.'],
      rank: byName[d]?.rank ?? null, pts: byName[d]?.total ?? null, guest: !!byName[d]?.isGuest || L.isGuestDriver(d) }))
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.driver.localeCompare(b.driver));
    mates = { roster, guestPct: rows.length ? rows.filter(r => r.guest).length / rows.length : 0 };
  } else {
    const vs = {};
    let n = 0, aboveAll = 0;
    for (const r of placed(rows)) {
      const others = placed(srcAll).filter(x => x['Round'] === r['Round'] && x['Team'] === r['Team']
        && x['Driver'] !== name && r['Team'] && r['Team'] !== '—');
      if (!others.length) continue;
      n++;
      if (others.every(x => r['Pos.'] < x['Pos.'])) aboveAll++;
      for (const x of others) {
        const v = vs[x['Driver']] ||= { driver: x['Driver'], won: 0, lost: 0 };
        r['Pos.'] < x['Pos.'] ? v.won++ : v.lost++;
      }
    }
    mates = { rounds: n, aboveAll, vs: Object.values(vs).sort((a, b) => b.won + b.lost - a.won - a.lost) };
  }

  return {
    kind: isTeam ? 'team' : 'driver', session: isQual ? 'qual' : 'race', name, firsts,
    entries: { quals: qualRounds.size, n: myRounds.size, streak: series(n => myRounds.has(n)) },
    pos,
    results: { n: rows.length, p1: cnt(1), p3: cnt(3), p5: cnt(5), p10: cnt(10),
      bestPts: topPts, avgPts: myAvgPts, avgPtsRank,
      top10Streak: series(n => bestPos(n) <= 10) },
    standing, chase, mates,
  };
}

/* ── Сводка сезона для первого экрана ── */
/* Машины в Чейзе владельцев: посеянные после 26 этапа (chaseSeed в зачёте владельцев на
   последнем этапе). Пока Чейза нет — пусто. */
function ownerChaseCars(s) {
  const last = s.st.races.rounds.filter(r => !s.L.SPRINT_ROUNDS.has(r)).pop();
  if (!(last > s.L.CHASE_START)) return [];
  return ownersUpTo(s, last, 'auto').filter(o => o.chaseSeed != null).map(o => String(o.car));
}

function seasonSummary(s) {
  const { L, st } = s;
  const setArr = x => [...(x || [])];
  const mapOfSets = m => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, [...v]]));
  const drivers = new Set([...st.races.rows, ...st.quals.rows].map(r => r['Driver']).filter(Boolean));
  const teams = new Set(st.races.rows.map(r => r['Team']).filter(Boolean));
  const [leader, second] = st.races.standings.filter(s => s.rank != null);   // гости вне зачёта
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
    deductions: st.deductions, teamOf: st.teamOf, carOf: st.carOf, carColors: st.carColors, roundMaxPos: st.roundMaxPos,
    ownerChase: ownerChaseCars(s),
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
    return { map, rounds, order, qualMap: p.session === 'qual' ? qualMap : null, rankOf, totals,
      chase: [...chaseSet(s.st, p.session === 'qual' ? 'quals' : 'races')] };
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
  car_card: (s, p) => carCard(s, p.car),
  fun: (s, p) => funStats(s, p.session),
  stats: (s, p) => statsCard(s, p.kind, p.name, p.session, p.noMetric),
  h2h: (s, p) => p.mode === 'teams' ? h2hTeams(s, p.a, p.b, p.metric) : h2hDrivers(s, p.a, p.b, p.metric),
};

/* Вызов «функции данных»: имя и параметры те же, что у прежних функций базы.
   Лист (sheet) обрабатывается в core.js — он идёт прямо с Google Sheets. */
async function localRpc(fn, params = {}, fresh = false) {
  const impl = LOCAL_API[fn];
  if (!impl) throw new Error(`Неизвестный запрос данных: ${fn}`);
  const s = await getSeason(params.season ?? state.year, params.division ?? state.division, fresh);
  return impl(s, params);
}
