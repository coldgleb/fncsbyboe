/* Сборка посчитанного сезона на сервере.
   Повторяет load() из js/app.js: те же шаги, те же функции (cloud/_logic.gen.js
   собран из js/*.js), только данные берутся из D1, а не из листов. Фронт получает
   готовые таблицы — считать ему больше нечего. */

import { makeLogic } from './_logic.gen.js';

export async function buildSeason(sheets, season, division) {
  const L = makeLogic();
  const { state } = L;
  const div = L.DIVISIONS[division];

  state.year = season;
  state.division = division;

  const [racesRows, qualsRows, roundRows, coalRows, dedRows, changeRows, entryRows] = await Promise.all([
    sheets(`${season} ${div.races}`),
    sheets(`${season} ${div.quals}`),
    sheets(`${season} Calendar`),
    div.coalitions ? sheets(`${season} ${div.coalitions}`) : [],
    sheets(`${season} Deductions`),
    sheets(`${season} Changes`),
    div.entries ? sheets(`${season} ${div.entries}`) : [],
  ]);

  state.entries = L.computeEntries(entryRows);
  state.coalitions = new Set(coalRows.map(r => Object.values(r)[0]).filter(Boolean));

  state.deductions = Object.fromEntries(
    dedRows.filter(r => r['Team'] && r['Points'] != null)
      .map(r => [r['Team'], { pts: r['Points'], reason: r['Reason'] || '', round: r['Round'] ?? null }]));

  state.roundNames = Object.fromEntries(
    roundRows.filter(r => r['#'] != null)
      .map(r => [String(r['#']), `${L.fmtRoundNum(r['#'])} · ${r['Name'] || ''}`]));
  state.roundAbb = Object.fromEntries(
    roundRows.filter(r => r['#'] != null && r['Abb.']).map(r => [String(r['#']), r['Abb.']]));

  state.guestByChange = new Set(changeRows.filter(r => r.B === div.label && r.A).map(r => r.A));
  state.teamOf = L.computeTeamOf(racesRows, qualsRows);

  const duelRows = qualsRows.filter(r => L.SPRINT_ROUNDS.has(parseFloat(r['Round'])));
  const racesRowsWithDuel = [...racesRows, ...duelRows];

  state.races.rows = racesRows;
  state.races.rowsWithDuel = racesRowsWithDuel;
  state.races.rounds = L.uniqueRounds(racesRows).filter(r => r !== 0);
  state.quals.rows = qualsRows;
  state.quals.rounds = L.uniqueRounds(qualsRows).filter(r => r !== 0);

  state.roundMaxPos = {};
  for (const r of racesRows) {
    const rnd = r['Round'], pos = r['Pos.'];
    if (rnd != null && pos != null) state.roundMaxPos[rnd] = Math.max(state.roundMaxPos[rnd] || 0, pos);
  }

  state.metricQuals = new Set(state.quals.rounds.filter(rnd =>
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
  state.attendance = { races: countRounds(racesRows), quals: countRounds(qualsRows) };

  state.qualsParticipation = {};
  for (const r of qualsRows) {
    const d = r['Driver'], rnd = r['Round'];
    if (!d || L.isGuestDriver(d) || rnd == null || L.SPRINT_ROUNDS.has(rnd) || rnd === 0) continue;
    (state.qualsParticipation[d] ||= new Set()).add(rnd);
  }

  const lastRaceRound = Math.max(...state.races.rounds.filter(r => !L.SPRINT_ROUNDS.has(r)), 0);
  state.races.standings = lastRaceRound > L.CHASE_START
    ? L.computeChaseStandings(racesRowsWithDuel) : L.computeStandings(racesRowsWithDuel);

  const lastQualRound = Math.max(...state.quals.rounds.filter(r => !L.SPRINT_ROUNDS.has(r)), 0);
  state.quals.standings = lastQualRound > L.CHASE_START
    ? L.computeChaseStandings(qualsRows) : L.computeStandings(qualsRows);

  return { L, state, racesRowsWithDuel, qualsRows, racesRows, div };
}

/* Графики и история мест: зачёт пересчитывается на каждый этап — самое дорогое,
   поэтому только для части charts */
export function withCharts({ L, state, racesRowsWithDuel, qualsRows }) {
  state.races.chartStandings = L.computeStandings(racesRowsWithDuel);
  state.quals.chartStandings = L.computeStandings(qualsRows);

  state.rankHistory = {};
  state.teamRankHistory = {};
  for (const rnd of state.races.rounds) {
    const upTo = racesRowsWithDuel.filter(r => r['Round'] < rnd + 1);
    const st = rnd > L.CHASE_START ? L.computeChaseStandings(upTo) : L.computeStandings(upTo);
    for (const s of st) (state.rankHistory[s.driver] ||= {})[rnd] = s.rank;
    for (const t of L.computeTeamStandings(upTo)) (state.teamRankHistory[t.team] ||= {})[rnd] = t.rank;
  }

  state.qualRankHistory = {};
  for (const rnd of state.quals.rounds) {
    const upTo = qualsRows.filter(r => r['Round'] <= rnd);
    const st = rnd > L.CHASE_START ? L.computeChaseStandings(upTo) : L.computeStandings(upTo);
    for (const s of st) (state.qualRankHistory[s.driver] ||= {})[rnd] = s.rank;
  }
}

export function withGolub({ L, state, racesRows, qualsRows, div }) {
  if (div.golub) state.golub = {
    races: L.computeGolub(racesRows),
    quals: L.computeGolub(qualsRows.filter(r => !state.metricQuals.has(r['Round']))),
  };
}

export function withGains({ L, state }) {
  state.gains = L.computeGains();
}

export function withTeams({ L, state, racesRowsWithDuel, qualsRows, div }) {
  state.teamStandings = L.computeTeamStandings(racesRowsWithDuel);
  state.teamPivot = L.computeTeamStandings(racesRowsWithDuel, true);
  if (div.coalitions) {
    const indep = team => team && team !== '—' && !state.coalitions.has(team);
    state.indRaces.standings = L.renumber(L.computeStandings(racesRowsWithDuel).filter(s => indep(s.team)));
    state.indQuals.standings = L.renumber(L.computeStandings(qualsRows).filter(s => indep(s.team)));
    state.indTeams = L.renumber(state.teamStandings.filter(t => indep(t.team)));
  }
}
