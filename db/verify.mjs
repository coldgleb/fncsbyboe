/* Автосверка SQL-логики с прежним JS-расчётом: node db/verify.mjs
   Замороженный JS-расчёт (db/reference/, как было в js/ до переноса) — эталон: на тех же данных из
   базы он считает зачёты, а функции схемы api должны дать ровно то же на каждом
   этапе, в обоих дивизионах и в каждом режиме. Любое расхождение печатается.
   Подключение — из PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.

   Два отличия от эталона сделаны намеренно и поэтому из сверки исключены:
   1) пилот с заявкой от команды больше не двоится на «Имя» и «Имя (i)» — гостевые
      этапы приписаны ему же и очков не приносят (MERGED ниже: у таких пилотов
      сходятся место и очки, а статистика мест шире эталонной на гостевые этапы);
   2) номер машины и марка берутся из последней гонки, а не из первой строки сезона
      (поля car/mfr в сверке не участвуют).
   Эталон при этом работает как раньше: имена ему отдаются с прежней меткой «(i)». */

import pg from 'pg';
import { makeLogic } from './reference/logic.gen.js';

const SEASON = 2026;
const db = new pg.Client();
await db.connect();

// строки протокола в формате листов и в том порядке, в каком их видел сайт
async function sheetRows(division, sessions) {
  const { rows } = await db.query(`
    SELECT round_key, pos, car, driver, is_guest, team, mfr, ql, dr1, dr2, dr3, dr4, cau, ret, mn, due, points
      FROM api.protocol
     WHERE season = $1 AND division = $2 AND session = ANY($3)
     ORDER BY round, duel NULLS FIRST, pos IS NULL, pos, id`, [SEASON, division, sessions]);
  return rows.map(r => ({
    // эталону — прежнее имя с меткой гостя
    'Round': Number(r.round_key), 'Pos.': r.pos, '#': r.car,
    'Driver': r.driver + (r.is_guest && !r.driver.endsWith(' (i)') ? ' (i)' : ''), 'Team': r.team,
    'M.': r.mfr, 'QL': r.ql, 'DR1': r.dr1, 'DR2': r.dr2, 'DR3': r.dr3, 'DR4': r.dr4,
    'CAU': r.cau, 'RET': r.ret, 'MN': r.mn, 'DUE': r.due, 'Points': r.points,
  }));
}

// то же состояние, что собирает load() в js/app.js
async function jsState(division) {
  const L = makeLogic();
  const { state } = L;
  const races = await sheetRows(division, ['race']);
  const quals = await sheetRows(division, ['qual', 'duel']);
  const { rows: ch } = await db.query(`
    SELECT p.name FROM division_changes dc JOIN participants p ON p.id = dc.participant_id
     WHERE dc.season = $1 AND dc.from_division = $2`, [SEASON, division]);

  state.division = division;
  state.guestByChange = new Set(ch.map(r => r.name));
  const { rows: ded } = await db.query(`
    SELECT t.name, d.points, d.reason, d.round FROM deductions d JOIN teams t ON t.id = d.team_id
     WHERE d.season = $1`, [SEASON]);
  state.deductions = Object.fromEntries(ded.map(r => [r.name, { pts: r.points, reason: r.reason || '', round: r.round }]));
  state.teamOf = L.computeTeamOf(races, quals);
  state.races.rows = races;
  state.races.rowsWithDuel = [...races, ...quals.filter(r => L.SPRINT_ROUNDS.has(r['Round']))];
  state.races.rounds = L.uniqueRounds(races).filter(r => r !== 0);
  state.quals.rows = quals;
  state.quals.rounds = L.uniqueRounds(quals).filter(r => r !== 0);
  state.qualsParticipation = {};
  for (const r of quals) {
    const d = r['Driver'], rnd = r['Round'];
    if (!d || L.isGuestDriver(d) || rnd == null || L.SPRINT_ROUNDS.has(rnd) || rnd === 0) continue;
    (state.qualsParticipation[d] ||= new Set()).add(rnd);
  }
  return { L, state };
}

const FIELDS = ['driver', 'rank', 'total', 'team', 'isGuest'];
// статистика мест у сведённых пилотов шире эталонной — гостевые этапы теперь их
const STAT_FIELDS = ['wins', 'firstWin', 'best', 'top5', 'top10', 'finishes', 'posSum', 'sheetPts'];
const norm = (k, v) => (v === Infinity || v === undefined ? null : v);

const mergedCache = {};
const mergedRef = async division => (mergedCache[division] ??= await mergedDrivers(division));

async function mergedDrivers(division) {
  const { rows } = await db.query(`
    SELECT DISTINCT pr.driver FROM api.protocol pr
     WHERE pr.season = $1 AND pr.division = $2 AND pr.is_guest AND NOT pr.guest_entry`,
    [SEASON, division]);
  return new Set(rows.map(r => r.driver));
}
// у эталона такой пилот — две записи; гостевую убираем, чтобы строки сошлись
const dropGuestTwins = (list, merged, name = r => r.driver) =>
  list.filter(r => !(name(r).endsWith(' (i)') && merged.has(name(r).slice(0, -4))));

let checks = 0, fails = 0;
function compare(label, js, sql, merged = new Set()) {
  checks++;
  js = dropGuestTwins(js, merged);
  const problems = [];
  if (js.length !== sql.length) problems.push(`строк: JS ${js.length}, SQL ${sql.length}`);
  for (let i = 0; i < Math.min(js.length, sql.length); i++) {
    const fields = merged.has(js[i].driver) ? FIELDS : [...FIELDS, ...STAT_FIELDS];
    for (const f of fields) {
      const a = norm(f, js[i][f]), b = norm(f, sql[i][f]);
      if (a !== b && !(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9)) {
        problems.push(`#${i + 1} ${f}: JS=${JSON.stringify(a)} SQL=${JSON.stringify(b)} (${js[i].driver})`);
        break;
      }
    }
    if (problems.length > 5) break;
  }
  if (problems.length) { fails++; console.log(`✘ ${label}\n   ${problems.join('\n   ')}`); }
}

// ── личный зачёт, регулярный (без Чейза), на каждый этап ──
for (const division of ['open', 'star']) {
  const { L, state } = await jsState(division);
  const merged = await mergedDrivers(division);
  for (const [session, rowsKey, roundsKey] of [['race', 'rowsWithDuel', 'races'], ['qual', 'rows', 'quals']]) {
    const rounds = state[roundsKey].rounds.filter(r => !L.SPRINT_ROUNDS.has(r));
    for (const at of rounds) {
      const js = L.computeStandings(state[roundsKey][rowsKey].filter(r => r['Round'] < at + 1));
      const { rows: sql } = await db.query(
        'SELECT * FROM api.standings_ranked($1, $2, $3, $4)', [SEASON, division, session, at]);
      compare(`${division} ${session} регулярный после ${at}`, js, sql, merged);
    }
  }
}

// ── личный зачёт с Чейзом: срезы после 26 этапа ──
for (const division of ['open', 'star']) {
  const { L, state } = await jsState(division);
  const merged = await mergedDrivers(division);
  for (const [session, rowsKey, roundsKey] of [['race', 'rowsWithDuel', 'races'], ['qual', 'rows', 'quals']]) {
    const rounds = state[roundsKey].rounds.filter(r => !L.SPRINT_ROUNDS.has(r) && r > L.CHASE_START);
    for (const at of rounds) {
      const js = dropGuestTwins(
        L.computeChaseStandings(state[roundsKey][rowsKey].filter(r => r['Round'] < at + 1)), merged);
      const { rows: sql } = await db.query(
        'SELECT * FROM api.standings_chase($1, $2, $3, $4)', [SEASON, division, session, at]);
      compare(`${division} ${session} Чейз после ${at}`, js, sql, merged);
      // посев и победы в Чейзе (тай-брейк внутри Чейза) — отдельно
      checks++;
      const bad = js.findIndex((r, i) => (r.chaseSeed ?? null) !== (sql[i]?.chaseSeed ?? null)
        || (r.chase ? r.chase.wins : null) !== (sql[i]?.chase_wins ?? null));
      if (bad >= 0) { fails++; console.log(`✘ ${division} ${session} Чейз ${at}: посев/победы в Чейзе у #${bad + 1} ${js[bad].driver}`); }
    }
  }
}

// ── владельцы: регулярный зачёт на каждом этапе, Чейз после 26 ──
const OWNER_FIELDS = ['car', 'rank', 'total', 'wins', 'best', 'firstWin', 'chaseSeed'];
for (const division of ['open', 'star']) {
  const { L, state } = await jsState(division);
  const rounds = state.races.rounds.filter(r => !L.SPRINT_ROUNDS.has(r));
  for (const at of rounds) {
    const rows = state.races.rowsWithDuel.filter(r => r['Round'] < at + 1);
    const js = at > L.CHASE_START ? L.computeChaseOwnerStandings(rows) : L.computeOwnerStandings(rows);
    const { rows: [{ s: sql }] } = await db.query(
      'SELECT api.owner_standings($1, $2, $3) AS s', [SEASON, division, at]);
    checks++;
    const problems = [];
    if (js.length !== sql.length) problems.push(`строк: JS ${js.length}, SQL ${sql.length}`);
    for (let i = 0; i < Math.min(js.length, sql.length) && problems.length < 5; i++) {
      for (const f of OWNER_FIELDS) {
        const a = norm(f, js[i][f]) ?? null, b = norm(f, sql[i][f]) ?? null;
        if (a !== b) { problems.push(`#${i + 1} ${f}: JS=${JSON.stringify(a)} SQL=${JSON.stringify(b)} (#${js[i].car})`); break; }
      }
      const plain = ds => [...new Set(ds.map(d => d.endsWith(' (i)') ? d.slice(0, -4) : d))];
      if (JSON.stringify(plain(js[i].drivers)) !== JSON.stringify(plain(sql[i].drivers))
        || JSON.stringify(js[i].top5) !== JSON.stringify(sql[i].top5)) {
        problems.push(`#${i + 1} пилоты/топ-5 (#${js[i].car})`);
      }
    }
    if (problems.length) { fails++; console.log(`✘ ${division} владельцы после ${at}\n   ${problems.join('\n   ')}`); }
  }
}

// ── независимые: зачёт без команд коалиций, места заново ──
for (const division of ['open']) {
  const { L, state } = await jsState(division);
  const { rows: coal } = await db.query('SELECT name FROM teams WHERE is_coalition');
  const coalitions = new Set(coal.map(r => r.name));
  const indep = team => team && team !== '—' && !coalitions.has(team);
  for (const [session, rowsKey, roundsKey] of [['indRaces', 'rowsWithDuel', 'races'], ['indQuals', 'rows', 'quals']]) {
    const rounds = state[roundsKey].rounds.filter(r => !L.SPRINT_ROUNDS.has(r));
    for (const at of rounds) {
      const js = L.renumber(L.computeStandings(state[roundsKey][rowsKey].filter(r => r['Round'] < at + 1))
        .filter(s => indep(s.team)));
      const { rows: [{ s: sql }] } = await db.query(
        'SELECT api.driver_standings($1, $2, $3, $4) AS s', [SEASON, division, session, at]);
      compare(`${division} ${session} после ${at}`, js, sql);
    }
  }
}

// ── командный зачёт (и вариант сводной — с командами из одних гостей) ──
const sortObj = o => JSON.stringify(Object.keys(o || {}).sort().map(k => [String(Number(k)), o[k]]));
for (const division of ['open', 'star']) {
  const { L, state } = await jsState(division);
  const rounds = state.races.rounds.filter(r => !L.SPRINT_ROUNDS.has(r));
  for (const withGuestOnly of [false, true]) {
    for (const at of rounds) {
      const js = L.computeTeamStandings(state.races.rowsWithDuel.filter(r => r['Round'] < at + 1), withGuestOnly);
      const { rows: [{ s: sql }] } = await db.query(
        'SELECT api.team_standings($1, $2, $3, $4) AS s', [SEASON, division, at, withGuestOnly]);
      checks++;
      const problems = [];
      if (js.length !== sql.length) problems.push(`строк: JS ${js.length}, SQL ${sql.length}`);
      for (let i = 0; i < Math.min(js.length, sql.length) && problems.length < 5; i++) {
        const a = js[i], b = sql[i];
        const diff = ['team', 'total', 'penalty', 'rank', 'entered'].find(f => (a[f] ?? null) !== (b[f] ?? null))
          || (JSON.stringify(a.drivers) !== JSON.stringify(b.drivers) && 'drivers')
          || (JSON.stringify(a.bestPositions) !== JSON.stringify(b.bestPositions) && 'bestPositions')
          || (sortObj(a.roundPts) !== sortObj(b.roundPts) && 'roundPts')
          || (sortObj(Object.fromEntries(Object.entries(a.roundBest).map(([k, v]) => [k, v.map(x => [x.driver, x.pos, x.pts])])))
            !== sortObj(Object.fromEntries(Object.entries(b.roundBest).map(([k, v]) => [k, v.map(x => [x.driver, x.pos, x.pts])]))) && 'roundBest')
          || (sortObj(a.scorers) !== sortObj(b.scorers) && 'scorers');
        if (diff) problems.push(`#${i + 1} ${diff}: ${a.team} / ${b.team}`);
      }
      if (problems.length) { fails++; console.log(`✘ ${division} команды${withGuestOnly ? ' (сводная)' : ''} после ${at}\n   ${problems.join('\n   ')}`); }
    }
  }
}

// ── история мест, сводные, отыгранные позиции, Голубочкин, графики ──
const keyed = o => JSON.stringify(Object.entries(o || {}).map(([k, v]) => [String(Number(k)), v])
  .sort((a, b) => Number(a[0]) - Number(b[0])));
function same(label, a, b) {
  checks++;
  if (a !== b) { fails++; console.log(`✘ ${label}`); }
}
for (const division of ['open', 'star']) {
  const { L, state } = await jsState(division);
  const one = async (sql, ...args) => (await db.query(sql, args)).rows[0].s;

  // история мест: JS строит её в load() тем же циклом по этапам
  const hist = {}, teamHist = {}, qualHist = {};
  for (const rnd of state.races.rounds) {
    const upTo = state.races.rowsWithDuel.filter(r => r['Round'] < rnd + 1);
    const st = rnd > L.CHASE_START ? L.computeChaseStandings(upTo) : L.computeStandings(upTo);
    for (const s of st) (hist[s.driver] ||= {})[rnd] = s.rank;
    for (const t of L.computeTeamStandings(upTo)) (teamHist[t.team] ||= {})[rnd] = t.rank;
  }
  for (const rnd of state.quals.rounds.filter(r => !L.SPRINT_ROUNDS.has(r))) {
    const upTo = state.quals.rows.filter(r => r['Round'] <= rnd);
    const st = rnd > L.CHASE_START ? L.computeChaseStandings(upTo) : L.computeStandings(upTo);
    for (const s of st) (qualHist[s.driver] ||= {})[rnd] = s.rank;
  }
  const cmpHist = (label, js, sql) => {
    const drivers = [...new Set([...Object.keys(js), ...Object.keys(sql)])];
    const bad = drivers.filter(d => keyed(js[d]) !== keyed(sql[d]));
    checks++;
    if (bad.length) { fails++; console.log(`✘ ${label}: ${bad.length} расхождений, напр. ${bad[0]}\n   JS ${keyed(js[bad[0]])}\n   SQL ${keyed(sql[bad[0]])}`); }
  };
  cmpHist(`${division} история мест (гонки)`, hist, await one('SELECT api.rank_history($1,$2,$3) s', SEASON, division, 'race'));
  cmpHist(`${division} история мест (квалы)`, qualHist, await one('SELECT api.rank_history($1,$2,$3) s', SEASON, division, 'qual'));
  cmpHist(`${division} история мест команд`, teamHist, await one('SELECT api.team_rank_history($1,$2) s', SEASON, division));

  // очки по этапам для графиков (без Чейза)
  for (const [session, rows] of [['race', state.races.rowsWithDuel], ['qual', state.quals.rows]]) {
    const js = L.computeStandings(rows).map(s => [s.driver, s.team, keyed(s.roundPts)]);
    const sql = (await one('SELECT api.chart_points($1,$2,$3) s', SEASON, division, session))
      .map(s => [s.driver, s.team, keyed(s.roundPts)]);
    same(`${division} очки для графиков (${session})`, JSON.stringify(js), JSON.stringify(sql));
  }

  // сводные «пилот × этап»
  for (const [type, session] of [['races', 'race'], ['quals', 'qual']]) {
    state[type].standings = type === 'races'
      ? (Math.max(...state.races.rounds) > L.CHASE_START ? L.computeChaseStandings(state.races.rowsWithDuel) : L.computeStandings(state.races.rowsWithDuel))
      : (Math.max(...state.quals.rounds) > L.CHASE_START ? L.computeChaseStandings(state.quals.rows) : L.computeStandings(state.quals.rows));
    const js = L.buildPivotData(type);
    const sql = await one('SELECT api.pivot($1,$2,$3) s', SEASON, division, session);
    const mapKey = m => JSON.stringify(Object.keys(m || {}).sort().map(d => [d, keyed(m[d])]));
    same(`${division} сводная ${type}: порядок`, JSON.stringify(js.order), JSON.stringify(sql.order));
    same(`${division} сводная ${type}: места`, mapKey(js.map), mapKey(sql.map));
    if (js.qualMap) same(`${division} сводная ${type}: квала`, mapKey(js.qualMap), mapKey(sql.qualMap));
    same(`${division} сводная ${type}: этапы`, JSON.stringify(js.rounds), JSON.stringify(sql.rounds.map(Number)));
    // итог строки сводной — как считал renderPivot
    const jsTotals = Object.fromEntries(js.order.map(d => [d, js.rounds.reduce((t, r) => t + L.scorePts((js.map[d] || {})[r], r), 0)]));
    same(`${division} сводная ${type}: итоги`,
      JSON.stringify(js.order.map(d => [d, jsTotals[d]])),
      JSON.stringify(js.order.map(d => [d, sql.totals[d] ?? 0])));
  }

  // отыгранные позиции
  const gJs = L.computeGains().map(g => [g.driver, g.team, g.gained, g.lost, g.n, g.rank, keyed(g.cells)]);
  const gSql = (await one('SELECT api.gains($1,$2) s', SEASON, division))
    .map(g => [g.driver, g.team, g.gained, g.lost, g.n, g.rank, keyed(g.cells)]);
  same(`${division} отыгранные позиции`, JSON.stringify(gJs), JSON.stringify(gSql));

  // Голубочкин (только там, где он есть)
  if (division === 'open') {
    const metricQuals = new Set(state.quals.rounds.filter(rnd =>
      state.quals.rows.filter(r => r['Round'] === rnd).every(r => L.DR_KEYS.every(k => r[k] == null))));
    for (const [session, rows] of [['race', state.races.rows], ['qual', state.quals.rows.filter(r => !metricQuals.has(r['Round']))]]) {
      const js = L.computeGolub(rows);
      const sql = await one('SELECT api.golub($1,$2,$3) s', SEASON, division, session);
      same(`${division} Голубочкин (${session}): этапы`, JSON.stringify(js.rounds), JSON.stringify(sql.rounds));
      same(`${division} Голубочкин (${session}): зачёт`,
        JSON.stringify(js.drivers.map(d => [d.driver, d.team, d.total, d.rank, keyed(d.cells)])),
        JSON.stringify(sql.drivers.map(d => [d.driver, d.team, d.total, d.rank, keyed(d.cells)])));
    }
  }
}

// ── метрика команд (Open — там есть заявки) ──
{
  const division = 'open';
  const { L, state } = await jsState(division);
  // заявки в прежнем виде листа: команды по названию (побайтово, как отдавал D1)
  const { rows: ent } = await db.query(`
    SELECT t.name AS team, c.number AS car, g.round
      FROM entries e JOIN cars c ON c.id = e.car_id AND c.division = $2 JOIN teams t ON t.id = e.team_id,
           generate_series(e.round_from, e.round_to) g(round)
     WHERE e.season = $1 ORDER BY t.name COLLATE "C", e.car_id, g.round`, [SEASON, division]);
  const rounds = [...new Set(ent.map(r => r.round))].sort((a, b) => a - b);
  const col = i => { let s = ''; for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + n % 26) + s; return s; };
  const colOf = new Map(rounds.map((r, i) => [r, col(i + 2)]));
  const head = { A: null, B: null }; for (const r of rounds) head[colOf.get(r)] = r;
  const byCar = new Map();
  for (const r of ent) {
    const k = r.team + '|' + r.car;
    if (!byCar.has(k)) byCar.set(k, { A: r.team, B: r.car });
    byCar.get(k)[colOf.get(r.round)] = 1;
  }
  state.entries = L.computeEntries([head, { A: 'Team', B: 'Car' }, ...byCar.values()]);
  state.metricQuals = new Set(state.quals.rounds.filter(rnd =>
    state.quals.rows.filter(r => r['Round'] === rnd).every(r => L.DR_KEYS.every(k => r[k] == null))));

  const sql = (await db.query('SELECT api.metric($1, $2) s', [SEASON, division])).rows[0].s;
  same(`${division} метрика: контрольные точки`, JSON.stringify(L.entriesRounds()), JSON.stringify(sql.rounds));
  const F = ['team', 'rank', 'entriesTotal', 'realQuals', 'avgQ', 'top10Q', 'top10QPct', 'starts', 'startsPct',
    'avgR', 'top10R', 'top10RPct', 'wins', 'teamPts', 'made', 'plan', 'pct',
    'avgQRank', 'top10QPctRank', 'startsPctRank', 'avgRRank', 'top10RPctRank', 'winsRank', 'teamPtsRank', 'metric'];
  const round6 = v => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v ?? null);
  for (const at of L.entriesRounds()) {
    const js = L.entriesRows(at).map(t => F.map(f => round6(t[f])));
    const got = (sql.byRound[at] || []).map(t => F.map(f => round6(t[f])));
    checks++;
    const bad = js.findIndex((r, i) => JSON.stringify(r) !== JSON.stringify(got[i]));
    if (bad >= 0 || js.length !== got.length) {
      fails++;
      const i = bad >= 0 ? bad : Math.min(js.length, got.length);
      const f = F.findIndex((_, k) => JSON.stringify(js[i]?.[k]) !== JSON.stringify(got[i]?.[k]));
      console.log(`✘ ${division} метрика после ${at}: #${i + 1} ${F[f]} JS=${JSON.stringify(js[i]?.[f])} SQL=${JSON.stringify(got[i]?.[f])} (${js[i]?.[0]} / ${got[i]?.[0]})`);
    }
  }
}

// ── вкладка «По этапам»: протоколы, зачёты после этапа, метрика следующего этапа ──
for (const division of ['open', 'star']) {
  const { L, state } = await jsState(division);
  const one = async (sql, ...args) => (await db.query(sql, args)).rows[0].s;
  state.roundMaxPos = {};
  for (const r of state.races.rows) {
    if (r['Round'] != null && r['Pos.'] != null)
      state.roundMaxPos[r['Round']] = Math.max(state.roundMaxPos[r['Round']] || 0, r['Pos.']);
  }
  // тот же порядок протокола, что в onRoundChange (js/rounds.js)
  const orderField = rows => {
    const metric = rows.every(r => L.DR_KEYS.every(k => r[k] == null));
    const beats = (a, b) => metric ? (a ?? Infinity) < (b ?? Infinity) : (a ?? -Infinity) > (b ?? -Infinity);
    const key = r => r['Pos.'] ?? Math.min(999, ...rows
      .filter(x => x['Pos.'] != null && beats(r['Points'], x['Points'])).map(x => x['Pos.'])) - 0.5;
    return rows.map(r => [key(r), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  };
  const allRounds = [...new Set([...state.races.rows, ...state.quals.rows].map(r => r['Round']))]
    .filter(r => !L.SPRINT_ROUNDS.has(r)).sort((a, b) => a - b);

  for (const rnd of allRounds) {
    const views = [['race', state.races.rows, rnd], ['qual', state.quals.rows, rnd]];
    if (rnd === 1) views.push(['duel1', state.quals.rows, 1.1], ['duel2', state.quals.rows, 1.2]);
    for (const [view, rows, key] of views) {
      const js = orderField(rows.filter(r => r['Round'] === key));
      if (!js.length) continue;
      const sql = (await one('SELECT api.round_protocol($1,$2,$3,$4) s', SEASON, division, rnd, view)).rows;
      same(`${division} протокол ${view} этапа ${rnd}: порядок`,
        JSON.stringify(js.map(r => [r['Driver'], r['Pos.'], r['Points']])),
        JSON.stringify(sql.map(r => [r['Driver'], r['Pos.'], r['Points']])));
    }
  }

  for (const rnd of state.races.rounds.filter(r => !L.SPRINT_ROUNDS.has(r))) {
    const upTo = n => state.races.rowsWithDuel.filter(r => r['Round'] < n + 1);
    const ownersAfter = n => n > L.CHASE_START ? L.computeChaseOwnerStandings(upTo(n)) : L.computeOwnerStandings(upTo(n));
    const dr = await one('SELECT api.round_standings($1,$2,$3,$4) s', SEASON, division, rnd, 'drivers');
    same(`${division} личный после этапа ${rnd}`,
      JSON.stringify(L.computeStandings(upTo(rnd)).map(s => [s.driver, s.rank, s.total, s.bestPositions.slice(0, 5)])),
      JSON.stringify(dr.rows.map(s => [s.driver, s.rank, s.total, s.top5])));
    const tm = await one('SELECT api.round_standings($1,$2,$3,$4) s', SEASON, division, rnd, 'teams');
    same(`${division} командный после этапа ${rnd}`,
      JSON.stringify(L.computeTeamStandings(upTo(rnd)).map(t => [t.team, t.rank, t.total])),
      JSON.stringify(tm.rows.map(t => [t.team, t.rank, t.total])));
    const ow = await one('SELECT api.round_standings($1,$2,$3,$4) s', SEASON, division, rnd, 'owners');
    same(`${division} владельцы после этапа ${rnd}`,
      JSON.stringify(ownersAfter(rnd).map(o => [o.car, o.rank, o.total])),
      JSON.stringify(ow.rows.map(o => [o.car, o.rank, o.total])));

    // метрика на следующий этап — та же сборка, что renderRoundMetric
    const race = upTo(rnd);
    const quals = state.quals.rows.filter(r => r['Round'] < rnd + 1);
    const champ = L.metricChampRanks(rnd > L.CHASE_START ? L.computeChaseStandings(race) : L.computeStandings(race), quals);
    const owners = ownersAfter(rnd);
    const ownerRank = Object.fromEntries(owners.map(o => [o.car, o.rank]));
    const last = {}, lastOfCar = {};
    for (const r of [...quals, ...race]) {
      const d = r['Driver'], car = r['#'], rr = r['Round'];
      if (!d || !car || car === '-' || rr == null) continue;
      if (!(last[d]?.rnd > rr)) last[d] = { rnd: rr, car: String(car), team: r['Team'] && r['Team'] !== '—' ? r['Team'] : '—' };
      if (!(lastOfCar[car]?.rnd > rr)) lastOfCar[car] = { rnd: rr, driver: d };
    }
    const posOf = Object.fromEntries(state.races.rows.filter(r => r['Round'] === rnd && r['Pos.'] != null).map(r => [r['Driver'], r['Pos.']]));
    const field = state.roundMaxPos[rnd] || 40;
    const js = L.computeNextMetric(Object.keys(champ).map(driver => {
      const { car = '—', team = '—' } = last[driver] || {};
      const pos = posOf[driver] ?? null;
      const other = lastOfCar[car]?.driver;
      return { driver, team, car, pos, place: pos ?? field + 1, champRank: champ[driver],
        ownerRank: ownerRank[car] ?? owners.length + 1, carNote: other && other !== driver ? other : null };
    }));
    const sm = await one('SELECT api.round_metric($1,$2,$3) s', SEASON, division, rnd);
    const pick = m => [m.driver, m.team, m.car, m.pos, m.place, m.champRank, m.ownerRank, m.carNote, Math.round(m.metric * 1000)];
    same(`${division} метрика на следующий этап после ${rnd}`, JSON.stringify(js.map(pick)), JSON.stringify(sm.rows.map(pick)));
  }
}

// ── граница Чейза и «± Чейз» в таблице зачёта (как считал renderTable) ──
for (const division of ['open', 'star']) {
  const { L, state } = await jsState(division);
  for (const [session, rowsKey, roundsKey] of [['races', 'rowsWithDuel', 'races'], ['quals', 'rows', 'quals']]) {
    const rounds = state[roundsKey].rounds.filter(r => !L.SPRINT_ROUNDS.has(r));
    for (const at of rounds) {
      const rows = state[roundsKey][rowsKey].filter(r => r['Round'] < at + 1);
      const isChase = at > L.CHASE_START;
      const all = isChase ? L.computeChaseStandings(rows) : L.computeStandings(rows);
      const playoffSet = L.buildPlayoffSet(all, at);
      const chase = all.filter(s => playoffSet.has(s.driver));
      let lastChaseIdx = -1;
      all.forEach((s, i) => { if (playoffSet.has(s.driver)) lastChaseIdx = i; });
      let afterChase = null;
      for (let j = lastChaseIdx + 1; j < all.length; j++) if (!all[j].isGuest) { afterChase = all[j]; break; }
      const cutoffDriver = all.find(s => !s.isGuest && !playoffSet.has(s.driver) && L.qualEligible(s.driver, at));
      const lastChase = chase[chase.length - 1], chaseLeader = chase[0];
      const gap = s => {
        if (s.isGuest || !L.qualEligible(s.driver, at)) return null;
        const ref = isChase ? (playoffSet.has(s.driver) ? chaseLeader : afterChase)
          : (playoffSet.has(s.driver) ? cutoffDriver : lastChase);
        return ref ? s.total - ref.total : null;
      };
      const js = dropGuestTwins(all, await mergedRef(division))
        .map(s => [s.driver, playoffSet.has(s.driver), afterChase?.driver === s.driver, gap(s)]);
      const sql = (await db.query('SELECT api.slice($1,$2,$3,$4) s', [SEASON, division, session, at])).rows[0].s
        .standings.map(s => [s.driver, s.playoff, s.cutoff, s.gap]);
      same(`${division} ${session} граница Чейза и ± после ${at}`, JSON.stringify(js), JSON.stringify(sql));
    }
  }
}

// ── накопительные очки команд для графика (renderTeamTab) ──
for (const division of ['open', 'star']) {
  const { L, state } = await jsState(division);
  const teams = L.computeTeamStandings(state.races.rowsWithDuel);
  const penaltyBy = (t, r) => (t.penaltyRound == null || t.penaltyRound <= r ? t.penalty : 0);
  const js = teams.map(t => {
    let pts = 0;
    return [t.team, state.races.rounds.map(r => { pts += t.roundPts[r] || 0; return pts - penaltyBy(t, r); })];
  });
  const sql = (await db.query('SELECT api.team_standings($1,$2,$3) s', [SEASON, division, 1000])).rows[0].s
    .map(t => {
      let last = 0;   // этап без строк команды — кривая стоит на месте
      return [t.team, state.races.rounds.map(r => (last = t.cumPts[r] ?? last))];
    });
  same(`${division} накопительные очки команд`, JSON.stringify(js), JSON.stringify(sql));
}

console.log(`\nпроверок: ${checks}, расхождений: ${fails}`);
await db.end();
process.exit(fails ? 1 : 0);
