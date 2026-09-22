/* Сборка серверной копии расчётов: node cloud/build-logic.js

   Логика зачётов живёт в js/*.js и используется браузером. Worker считает те же
   таблицы, поэтому код не дублируется, а заворачивается в модуль: сюда попадают
   файлы с расчётами целиком, DOM-зависимые функции просто не вызываются. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['js/standings.js', 'js/drivers.js', 'js/teams.js', 'js/entries.js',
  'js/golub.js', 'js/rounds.js'];
const OUT = path.join(__dirname, '_logic.gen.js');

// из core.js берём только конфиг и хелперы до загрузки листов — дальше начинается браузерная часть
const core = fs.readFileSync(path.join(ROOT, 'js/core.js'), 'utf8');
const coreHead = core.slice(0, core.indexOf('/* ── Кэш листов в браузере ──'));
const coreTail = core.slice(core.indexOf('/* ── Round view ── */'), core.indexOf('/* ── Сортировка по клику'));

const parts = SOURCES.map(f => `// ── ${f} ──\n${fs.readFileSync(path.join(ROOT, f), 'utf8')}`);

const bundle = `// СГЕНЕРИРОВАНО cloud/build-logic.js из js/*.js — руками не править.
// Расчёты у сайта и у Worker-а одни и те же, расхождений быть не может.

export function makeLogic() {
  // заглушки браузерного окружения: расчётный код их не использует, но модули
  // ссылаются на них на верхнем уровне
  const location = { hash: '', reload() { } };
  const noop = () => { };
  const document = {
    addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, createElement: () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop } }),
  };
  const localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  const window = {};
  const URLSearchParams = globalThis.URLSearchParams;

${coreHead}
${coreTail}
${parts.join('\n')}

  return {
    state, DIVISIONS, SPRINT_ROUNDS, CHASE_START, DR_KEYS,
    scorePts, renumber, uniqueRounds, avgPos, qualEligible, buildPlayoffSet,
    computeTeamOf, computeStandings, computeChaseStandings,
    computeTeamStandings, computeOwnerStandings, computeChaseOwnerStandings,
    computeGolub, computeEntries, computeGains, buildPivotData,
    entriesRows, entriesRounds, metricChampRanks, computeNextMetric,
    teamStats, factByTeamRound, planByTeam, raceTeamByRound, rankBy,
    isGuestDriver, roundFullName, roundLabel, fmtRoundNum,
  };
}
`;
fs.writeFileSync(OUT, bundle, 'utf8');
console.log(`${OUT} — ${(bundle.length / 1024).toFixed(0)} КБ`);
