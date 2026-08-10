/* Подсчёт зачётов: очки, личный, командный, владельцев */

function nascarPts(pos) {
  if (!pos || pos < 1) return 0;
  if (pos === 1) return 55;
  return Math.max(1, 37 - Math.round(pos));
}

const SPRINT_ROUNDS = new Set([1.1, 1.2]);
const DR_KEYS = ['DR1', 'DR2', 'DR3', 'DR4'];

/* Очки в чемпионат (вторичные, п. 9.2). Клэш формально внезачётный (п. 11.1), но его очки
   в зачёт идут — это подтверждено сверкой с официальными протоколами, как и формула ниже
   (она точнее таблицы из п. 11.4). */
function scorePts(pos, round) {
  if (SPRINT_ROUNDS.has(round)) {
    if (!pos || pos > 10) return 0;
    return 11 - Math.round(pos); // P1→10, P2→9 … P10→1
  }
  return nascarPts(pos);
}

/* Порядок в зачёте — одинаковый для пилотов и для владельцев (п. 9.8).
   Шаг «очки регулярного сезона» пропущен: по п. 10.2.2 очки сбрасываются на 2000 + бонусы только
   с началом Чейза, а до этого регулярные очки равны общей сумме и ничего не решают.
   Столбец Points — это очки за прогноз, а не они (проверено на равенстве #17/#24/#95 после 20 этапа). */

function standingsCmp(a, b) {
  if (b.total !== a.total) return b.total - a.total;             // очки
  if (b.wins !== a.wins) return b.wins - a.wins;              // количество побед
  // количество вторых, третьих... мест (клэши не в счёт)
  const maxPos = Math.max(2, ...Object.keys(a.posCounts).map(Number), ...Object.keys(b.posCounts).map(Number));
  for (let p = 2; p <= maxPos; p++) {
    const diff = (b.posCounts[p] || 0) - (a.posCounts[p] || 0);
    if (diff !== 0) return diff;
  }
  // более ранняя первая победа
  return a.firstWin - b.firstWin;
}

function computeStandings(rows) {
  const map = {};
  for (const r of rows) {
    const d = r['Driver'];
    if (!d || d.includes('(i)')) continue;
    if (!map[d]) map[d] = {
      driver: d, team: r['Team'] || '—', car: r['#'] || '—', mfr: r['M.'] || '',
      total: 0, sheetPts: 0, best: Infinity,
      wins: 0, firstWin: Infinity, posCounts: {}, roundPts: {},
      posSum: 0, finishes: 0, top5: 0, top10: 0, positions: []
    };
    const s = map[d];
    const pts = scorePts(r['Pos.'], r['Round']);
    s.total += pts;
    s.sheetPts += r['Points'] || 0;
    const pos = r['Pos.'];
    // Клэш приносит очки, но гоночным результатом не считается: ни победа, ни место, ни статистика
    if (pos != null && !SPRINT_ROUNDS.has(r['Round'])) {
      if (pos < s.best) s.best = pos;
      s.posSum += pos;
      s.finishes++;
      if (pos <= 5) s.top5++;
      if (pos <= 10) s.top10++;
      s.posCounts[pos] = (s.posCounts[pos] || 0) + 1;
      s.positions.push(pos);
      if (pos === 1) {
        s.wins++;
        const rnd = r['Round'];
        if (rnd != null && rnd < s.firstWin) s.firstWin = rnd;
      }
    }
    const rnd = r['Round'];
    if (rnd != null) s.roundPts[rnd] = (s.roundPts[rnd] || 0) + pts;
  }

  return Object.values(map).sort(standingsCmp)
    .map((s, i) => ({ ...s, rank: i + 1, bestPositions: [...s.positions].sort((a, b) => a - b) }));
}

function uniqueRounds(rows) {
  return [...new Set(rows.map(r => r['Round']).filter(x => x != null))].sort((a, b) => a - b);
}

/* ── Командный зачёт: сумма очков двух лучших представителей команды за этап (п. 9.7) ── */
function computeTeamStandings(rows) {
  const teamMap = {};
  for (const r of rows) {
    const team = r['Team'];
    const rnd = r['Round'];
    const d = r['Driver'];
    // Гость личных очков не получает, но команде приносит и борется за зачётное место
    // наравне со своими (свои 5-е и 20-е + гость 10-й → в зачёт идут 5-е и 10-е).
    // «Guest entry» — гость без команды: очки не достаются никому.
    // Клэш в командный зачёт не идёт (в личный — идёт); сверено с официальными итогами
    if (!team || team === '—' || team === 'Guest entry' || rnd == null || !d) continue;
    if (SPRINT_ROUNDS.has(rnd)) continue;
    if (!teamMap[team]) teamMap[team] = { team, roundMap: {}, drivers: new Set(), positions: [] };
    teamMap[team].drivers.add(d);
    if (!teamMap[team].roundMap[rnd]) teamMap[team].roundMap[rnd] = [];
    teamMap[team].roundMap[rnd].push({ driver: d, pos: r['Pos.'], pts: scorePts(r['Pos.'], rnd) });
    if (r['Pos.'] != null && !SPRINT_ROUNDS.has(rnd)) teamMap[team].positions.push(r['Pos.']);
  }

  return Object.values(teamMap).map(t => {
    let total = 0;
    const roundPts = {};
    const roundBest = {};  // этап → зачётные результаты (кто, какое место, сколько очков)
    const scorers = {}; // пилот → { этапов, очков } среди двух зачётных за этап
    for (const [rnd, results] of Object.entries(t.roundMap)) {
      const best2 = results.sort((a, b) => b.pts - a.pts).slice(0, 2);
      const top2 = best2.reduce((s, v) => s + v.pts, 0);
      total += top2;
      roundPts[parseFloat(rnd)] = top2;
      roundBest[parseFloat(rnd)] = best2;
      for (const { driver, pts } of best2) {
        const sc = scorers[driver] ||= { rounds: 0, pts: 0 };
        sc.rounds++;
        sc.pts += pts;
      }
    }
    return {
      team: t.team, total, roundPts, roundBest, scorers, drivers: [...t.drivers],
      bestPositions: t.positions.sort((a, b) => a - b)
    };
  }).sort((a, b) => b.total - a.total).map((t, i) => ({ ...t, rank: i + 1 }));
}

function computeOwnerStandings(rows) {
  const map = {};
  for (const r of rows) {
    const car = r['#'];
    // Гость очков себе не приносит, но машине — приносит; «-» значит «без номера»
    if (car == null || car === '' || car === '-') continue;
    if (!map[car]) map[car] = {
      car, total: 0, wins: 0, firstWin: Infinity,
      best: Infinity, posCounts: {}, positions: [], drivers: new Set()
    };
    const o = map[car];
    o.total += scorePts(r['Pos.'], r['Round']);
    if (r['Driver']) o.drivers.add(r['Driver']);
    const pos = r['Pos.'], rnd = r['Round'];
    // Как и у пилотов: клэш даёт очки, но результатом не считается
    if (pos != null && !SPRINT_ROUNDS.has(rnd)) {
      if (pos < o.best) o.best = pos;
      if (pos === 1) {
        o.wins++;
        if (rnd != null && rnd < o.firstWin) o.firstWin = rnd;
      }
      o.posCounts[pos] = (o.posCounts[pos] || 0) + 1;
      o.positions.push(pos);
    }
  }
  return Object.values(map).sort(standingsCmp)
    .map((o, i) => ({
      ...o, rank: i + 1, drivers: [...o.drivers],
      top5: o.positions.sort((a, b) => a - b).slice(0, 5)
    }));
}

/* ── Зачёт им. Semen GOLUBOCHKIN: точка отсчёта — его позиция на этапе.
   Очки = сколько участников оказалось ниже него, но не ниже тебя (он 33, ты 37 → 4).
   Финишировал выше — 0. Этапы без него не считаются вовсе.
   Клэши и квалификации по метрике не в счёт. ── */

// П. 10.3: в регулярном сезоне (26 этапов) можно пропустить не более пяти. Клэши не этапы (п. 11.1)
function qualEligible(driver) {
  const attended = state.qualsParticipation[driver]?.size || 0;
  const heldRounds = state.quals.rounds.filter(r => !SPRINT_ROUNDS.has(r)).length;
  return heldRounds - attended <= 5;
}

function buildPlayoffSet(type) {
  const playoffSet = new Set();
  let slots = 16;
  for (const s of state[type].standings) {
    if (slots <= 0) break;
    if (qualEligible(s.driver)) { playoffSet.add(s.driver); slots--; }
  }
  return playoffSet;
}

function avgPos(s) {
  return s.finishes ? (s.posSum / s.finishes).toFixed(1) : '—';
}
