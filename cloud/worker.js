/* API поверх D1: отдаёт данные с теми же названиями полей, что были у листов
   Google Sheets, чтобы расчёты на фронте не пришлось переписывать.

   GET /sheets/2026%20Open%20Races
     → { cols: ["Round","Pos.","#","Driver",…], rows: [[0,1,"06","Semyon CHALYUK",…], …] }
   Разворачивает обратно в объекты листа fetchSheet в js/core.js.
   ?offset=N — следующая порция; в ответе total и next.

   Деплой: npx wrangler deploy --config cloud/wrangler.toml */

import { buildSeason, withCharts, withGolub, withGains, withTeams } from './season.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

// Строк в одном ответе. Держим порцию в пределах ~30 КБ: несжатые ответы крупнее
// сотни килобайт в некоторых сетях просто не доезжают.
const PAGE = 250;

/* Компактная упаковка: имена колонок один раз, строки — массивами значений,
   повторяющиеся строковые значения (имена, команды, марки, номера) — индексами
   в словарях. Полный протокол так весит впятеро меньше; разворачивает обратно
   в объекты листа fetchSheet в js/core.js. */
function compact(rows, offset = 0) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);

  const page = rows.slice(offset, offset + PAGE);
  // кодируем только те колонки, где значения — строки и они повторяются
  const enc = cols.filter(c => {
    const vals = page.map(r => r[c]).filter(v => v != null);
    return vals.length > 0 && vals.every(v => typeof v === 'string')
      && new Set(vals).size < vals.length;
  });
  const dict = {}, index = {};
  for (const c of enc) { dict[c] = []; index[c] = new Map(); }

  const packed = page.map(r => cols.map(c => {
    const v = r[c] === undefined ? null : r[c];
    if (!enc.includes(c) || v == null) return v;
    if (!index[c].has(v)) { index[c].set(v, dict[c].length); dict[c].push(v); }
    return index[c].get(v);
  }));

  return {
    cols, enc, dict, rows: packed,
    total: rows.length, offset, next: offset + page.length < rows.length ? offset + page.length : null,
  };
}

/* Сжатие делает Cloudflare по Accept-Encoding (своё давало двойной gzip). Ответы
   держим небольшими: крупные тела в некоторых сетях (HTTP/3) не доезжают. */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
      ...CORS,
    },
  });
}

// Номер этапа в том же виде, что в листах: дуэли — 1.1 и 1.2
const roundValue = r => (r.duel == null ? r.round : r.round + r.duel / 10);
// Метка гостя возвращается в имя: расчёты узнают гостя по «(i)»
const driverName = r => (r.is_guest ? `${r.name} (i)` : r.name);

/* Буквенное имя столбца (A, B, … Z, AA, AB…) — лист заявок приходил без шапки,
   и computeEntries в js/entries.js читает именно такие ключи */
function colName(i) {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

const RESULT_SQL = `
  SELECT r.round, r.duel, r.pos, p.name, r.is_guest, t.name AS team, c.number AS car,
         m.name AS mfr, r.ql, r.dr1, r.dr2, r.dr3, r.dr4, r.cau, r.ret, r.mn, r.due, r.points
    FROM results r
    JOIN participants p ON p.id = r.participant_id
    LEFT JOIN teams t ON t.id = r.team_id
    LEFT JOIN cars c ON c.id = r.car_id
    LEFT JOIN manufacturers m ON m.id = r.manufacturer_id
   WHERE r.season = ? AND r.division = ? AND r.session = ?
   ORDER BY r.round, r.duel, r.pos IS NULL, r.pos`;

async function results(db, season, division, session) {
  const { results: rows } = await db.prepare(RESULT_SQL).bind(season, division, session).all();
  const star = division === 'star';
  const race = session === 'race';
  return rows.map(r => {
    const out = {
      'Round': roundValue(r), 'Pos.': r.pos, '#': r.car, 'Driver': driverName(r),
      'Team': r.team, 'M.': r.mfr, 'QL': r.ql,
      'DR1': r.dr1, 'DR2': r.dr2, 'DR3': r.dr3, 'DR4': r.dr4,
    };
    if (race) Object.assign(out, { 'CAU': r.cau, 'RET': r.ret, 'MN': r.mn });
    if (star) out['DUE'] = r.due;
    out['Points'] = r.points;
    return out;
  });
}

async function calendar(db, season) {
  const { results: rows } = await db.prepare(
    'SELECT round, duel, abbr, name FROM rounds WHERE season = ? ORDER BY round, duel'
  ).bind(season).all();
  return rows.map(r => ({ '#': roundValue(r), 'Abb.': r.abbr, 'Name': r.name }));
}

async function deductions(db, season) {
  const { results: rows } = await db.prepare(`
    SELECT t.name AS team, d.points, d.reason, d.round
      FROM deductions d JOIN teams t ON t.id = d.team_id
     WHERE d.season = ? ORDER BY d.id`).bind(season).all();
  return rows.map(r => ({ 'Team': r.team, 'Points': r.points, 'Reason': r.reason, 'Round': r.round }));
}

// Лист Changes шёл без шапки: A — пилот, B — дивизион «откуда», C — «куда»
async function changes(db, season) {
  const { results: rows } = await db.prepare(`
    SELECT p.name, c.from_division, c.to_division
      FROM division_changes c JOIN participants p ON p.id = c.participant_id
     WHERE c.season = ? ORDER BY p.name`).bind(season).all();
  const label = d => d.charAt(0).toUpperCase() + d.slice(1);
  return rows.map(r => ({ A: r.name, B: label(r.from_division), C: label(r.to_division) }));
}

async function coalitions(db) {
  const { results: rows } = await db.prepare(
    'SELECT name FROM teams WHERE is_coalition = 1 ORDER BY name').all();
  return rows.map(r => ({ A: r.name }));
}

async function ogSquad(db) {
  const { results: rows } = await db.prepare(
    'SELECT name FROM participants WHERE in_og_squad = 1 ORDER BY name').all();
  return rows.map(r => ({ A: r.name }));
}

/* Заявки — та же матрица, что в листе: первая строка отдаёт номера этапов по столбцам,
   вторая (подписи Team/Car) сохранена для совместимости, дальше по строке на машину */
async function entries(db, season, division) {
  const { results: rows } = await db.prepare(`
    SELECT c.number AS car, t.name AS team, e.round
      FROM entries e
      JOIN cars c ON c.id = e.car_id
      JOIN teams t ON t.id = e.team_id
     WHERE e.season = ? AND c.division = ?
     ORDER BY t.name, e.car_id, e.round`).bind(season, division).all();
  if (!rows.length) return [];

  const rounds = [...new Set(rows.map(r => r.round))].sort((a, b) => a - b);
  const colOf = new Map(rounds.map((rnd, i) => [rnd, colName(i + 2)]));   // A и B заняты
  const head = { A: null, B: null };
  const labels = { A: 'Team', B: 'Car' };
  for (const rnd of rounds) { head[colOf.get(rnd)] = rnd; labels[colOf.get(rnd)] = null; }

  const byCar = new Map();
  for (const r of rows) {
    const key = `${r.team}|${r.car}`;
    if (!byCar.has(key)) byCar.set(key, { A: r.team, B: r.car, ...Object.fromEntries(rounds.map(rnd => [colOf.get(rnd), null])) });
    byCar.get(key)[colOf.get(r.round)] = 1;
  }
  return [head, labels, ...byCar.values()];
}

/* Части посчитанного сезона. Дробим, потому что ответы крупнее сотни килобайт
   в некоторых сетях не доезжают, а фронту редко нужно всё сразу. */
async function seasonPart(db, season, division, part) {
  const built = await buildSeason(name => sheet(db, name), season, division);
  const { L, state } = built;
  // дорогие расчёты — только для части, которой они нужны
  if (part === 'charts') withCharts(built);
  if (part === 'golub') withGolub(built);
  if (part === 'gains') withGains(built);
  if (part === 'teams' || part === 'metric') withTeams(built);
  const setToArray = s => [...(s || [])];
  const mapOfSets = m => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, [...v]]));

  if (part === 'main') {
    // числа для шапки считаем здесь же — фронту незачем держать протоколы ради них
    const drivers = new Set([...state.races.rows, ...state.quals.rows].map(r => r['Driver']).filter(Boolean));
    const teams = new Set(state.races.rows.map(r => r['Team']).filter(Boolean));
    const [leader, second] = state.races.standings;
    return {
    season, division,
    kpi: {
      numRaces: state.races.rounds.length,
      numQuals: state.quals.rounds.filter(r => !L.SPRINT_ROUNDS.has(r)).length,
      drivers: drivers.size, teams: teams.size,
      leader: leader ? { driver: leader.driver, team: leader.team, total: leader.total } : null,
      second: second ? { driver: second.driver, total: second.total } : null,
      gap: leader && second ? leader.total - second.total : 0,
    },
    rounds: { races: state.races.rounds, quals: state.quals.rounds },
    standings: { races: slim(state.races.standings), quals: slim(state.quals.standings) },
    roundNames: state.roundNames, roundAbb: state.roundAbb,
    metricQuals: setToArray(state.metricQuals),
    coalitions: setToArray(state.coalitions),
    guestByChange: setToArray(state.guestByChange),
    deductions: state.deductions, teamOf: state.teamOf, roundMaxPos: state.roundMaxPos,
    attendance: { races: mapOfSets(state.attendance.races), quals: mapOfSets(state.attendance.quals) },
    qualsParticipation: mapOfSets(state.qualsParticipation),
    };
  }

  if (part === 'teams') return {
    teamStandings: slimTeams(state.teamStandings), teamPivot: slimTeams(state.teamPivot),
    indTeams: state.indTeams ? slimTeams(state.indTeams) : null,
    indRaces: slim(state.indRaces.standings), indQuals: slim(state.indQuals.standings),
  };

  if (part === 'charts') return {
    chartStandings: { races: chartRows(state.races.chartStandings), quals: chartRows(state.quals.chartStandings) },
    rankHistory: state.rankHistory, teamRankHistory: state.teamRankHistory,
    qualRankHistory: state.qualRankHistory,
  };

  if (part === 'pivot') return {
    races: pivotData(L, state, 'races'),
    quals: pivotData(L, state, 'quals'),
  };

  if (part === 'metric') {
    if (!state.entries) return { rounds: [], byRound: {} };
    const rounds = L.entriesRounds();
    const byRound = {};
    for (const at of rounds) byRound[at] = L.entriesRows(at);
    return { rounds, byRound };
  }

  if (part === 'owners') {
    const rounds = state.races.rounds.filter(r => !L.SPRINT_ROUNDS.has(r));
    const last = rounds[rounds.length - 1];
    return { rounds, standings: ownersAt(L, state, last, 'auto') };
  }

  if (part === 'golub') return { golub: state.golub || null };
  if (part === 'gains') return { gains: state.gains };
  if (part === 'entries') return { entries: state.entries };

  return null;
}

/* Строка зачёта для таблиц: убираем то, что фронт в таблицах не читает (очки по
   этапам нужны графикам — они приходят частью charts). Ответ втрое легче. */
function slim(list) {
  return (list || []).map(s => {
    const { roundPts, positions, bestPositions, posCounts, chase, ...rest } = s;
    return chase ? { ...rest, chase: { wins: chase.wins, firstWin: chase.firstWin } } : rest;
  });
}

/* Команды: в roundBest лежали целые строки протокола — фронту нужны только
   пилот, место и очки, остальное раздувало ответ в разы */
function slimTeams(list) {
  return (list || []).map(t => ({
    ...t,
    roundBest: Object.fromEntries(Object.entries(t.roundBest || {})
      .map(([r, best]) => [r, best.map(x => ({ driver: x.driver, pos: x.pos, pts: x.pts }))])),
  }));
}

// графикам нужны только очки по этапам — без статистики зачёта
const chartRows = list => (list || []).map(s => ({ driver: s.driver, team: s.team, roundPts: s.roundPts }));

/* Сводная «пилот × этап»: те же карты позиций, что строит buildPivotData на фронте */
function pivotData(L, state, type) {
  const { map, rounds, order, qualMap, rankOf } = L.buildPivotData(type);
  return { map, rounds, order, qualMap, rankOf };
}

// Зачёт владельцев на выбранный этап; Чейз — по тому же правилу, что в интерфейсе
function ownersAt(L, state, at, chase) {
  const rows = state.races.rowsWithDuel.filter(r => r['Round'] < at + 1);
  const real = chase === 'chase' || (chase !== 'regular' && at > L.CHASE_START);
  return real ? L.computeChaseOwnerStandings(rows) : L.computeOwnerStandings(rows);
}

/* Срез зачёта на этап: сервер считает ровно то же, что раньше считал фронт
   в standingsUpTo/ownersUpTo, включая режим Чейза и место на прошлом этапе. */
function sliceData(L, state, session, at, chase) {
  const isInd = session.startsWith('ind');
  const base = session === 'quals' || session === 'indQuals' ? 'quals' : 'races';
  const indep = team => team && team !== '—' && !state.coalitions.has(team);

  const standingsUpTo = n => {
    if (session === 'owners') return ownersAt(L, state, n, chase);
    const rows = (base === 'quals' ? state.quals.rows : state.races.rowsWithDuel)
      .filter(r => r['Round'] < n + 1);
    const real = !isInd && (chase === 'chase' || (chase !== 'regular' && n > L.CHASE_START));
    const st = real ? L.computeChaseStandings(rows) : L.computeStandings(rows);
    return isInd ? L.renumber(st.filter(s => indep(s.team))) : st;
  };

  const rounds = (base === 'quals' ? state.quals.rounds : state.races.rounds)
    .filter(r => !L.SPRINT_ROUNDS.has(r));
  const prevRound = Math.max(...rounds.filter(r => r < at), 0);
  const prev = prevRound ? standingsUpTo(prevRound) : [];
  const key = session === 'owners' ? 'car' : 'driver';
  return {
    at, rounds,
    standings: session === 'owners' ? standingsUpTo(at) : slim(standingsUpTo(at)),
    prevRank: Object.fromEntries(prev.map(s => [s[key], s.rank])),
  };
}

// Имя листа разбирается ровно так, как его составлял фронт: «2026 Open Races»
async function sheet(db, name) {
  let m = name.match(/^(\d{4}) (Open|Star) (Races|Quals)$/);
  if (m) return results(db, +m[1], m[2].toLowerCase(), m[3] === 'Races' ? 'race' : 'qual');

  m = name.match(/^(\d{4}) Calendar$/);
  if (m) return calendar(db, +m[1]);

  m = name.match(/^(\d{4}) Deductions$/);
  if (m) return deductions(db, +m[1]);

  m = name.match(/^(\d{4}) Changes$/);
  if (m) return changes(db, +m[1]);

  m = name.match(/^(\d{4}) (Open|Star) Coalition Teams$/);
  if (m) return coalitions(db);

  m = name.match(/^(\d{4}) (Open|Star) Entries$/);
  if (m) return entries(db, +m[1], m[2].toLowerCase());

  m = name.match(/^(\d{4}) OG Squad$/);
  if (m) return ogSquad(db);

  return null;
}

export default {
  async fetch(request, env, ctx) {
    // посчитанные части кладём в кэш Cloudflare: пересчёт сезона занимает под секунду
    const cache = caches.default;
    const cached = request.method === 'GET' ? await cache.match(request) : null;
    if (cached) return cached;
    const response = await handle(request, env);
    if (request.method === 'GET' && response.status === 200 && ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  },
};

async function handle(request, env) {
  {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    if (path === '/' || path === '/sheets') {
      return json({ api: 'fncsbyboe', usage: '/sheets/<название листа>' });
    }

    if (path.startsWith('/season/')) {
      const [, , year, division, part] = path.split('/');
      try {
        if (part === 'slice') {
          const { L, state } = await buildSeason(n => sheet(env.DB, n), Number(year), division);
          const session = url.searchParams.get('session') || 'races';
          const chase = url.searchParams.get('chase') || 'auto';
          const rounds = (session.includes('uals') ? state.quals.rounds : state.races.rounds)
            .filter(r => !L.SPRINT_ROUNDS.has(r));
          const at = Number(url.searchParams.get('upto')) || rounds[rounds.length - 1];
          return json(sliceData(L, state, session, at, chase));
        }
        const data = await seasonPart(env.DB, Number(year), division, part || 'main');
        if (data == null) return json({ error: `неизвестная часть «${part}»` }, 404);
        return json(data);
      } catch (err) {
        return json({ error: String(err && err.message || err) }, 500);
      }
    }

    const prefix = '/sheets/';
    if (!path.startsWith(prefix)) return json({ error: 'not found' }, 404);

    const name = path.slice(prefix.length);
    const offset = Number(url.searchParams.get('offset')) || 0;
    try {
      const rows = await sheet(env.DB, name);
      if (rows == null) return json({ error: `неизвестный лист «${name}»` }, 404);
      return json(compact(rows, offset));
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  }
}
