-- ═══════════════════════════════════════════════════════════════════════════
-- Логика сайта в PostgreSQL. Всё — в схеме api: представления и функции поверх
-- таблиц public. Таблицы этот файл не меняет. Накатывается целиком:
--   node db/apply.js           (пересоздаёт схему api)
-- Сайт читает объекты api через PostgREST (db/postgrest.conf).
-- Правила перенесены из js/standings.js и соседних файлов; соответствие числам
-- проверяет db/verify.js (сравнивает с прежним JS-расчётом на всех этапах).
-- ═══════════════════════════════════════════════════════════════════════════

DROP SCHEMA IF EXISTS api CASCADE;
CREATE SCHEMA api;

-- Регулярный сезон — 26 этапов, дальше Чейз (плей-офф топ-16)
CREATE FUNCTION api.chase_start() RETURNS int IMMUTABLE LANGUAGE sql AS $$ SELECT 26 $$;

-- Стартовые баллы Чейза по посеву 1..16
CREATE FUNCTION api.chase_points(seed int) RETURNS int IMMUTABLE LANGUAGE sql AS $$
  SELECT (ARRAY[2100,2075,2065,2060,2055,2050,2045,2040,2035,2030,2025,2020,2015,2010,2005,2000])[seed]
$$;

/* Очки в чемпионат (п. 9.2): этап 0 (The Clash) вне зачёта; дуэль — 11 − место для
   топ-10; обычный этап — P1 = 55, дальше 37 − место, минимум 1. Без места (DQ) — 0. */
CREATE FUNCTION api.score_pts(pos int, round int, duel smallint) RETURNS int
IMMUTABLE LANGUAGE sql AS $$
  SELECT CASE
    WHEN round = 0 THEN 0
    WHEN duel IS NOT NULL THEN CASE WHEN pos IS NULL OR pos > 10 THEN 0 ELSE 11 - pos END
    WHEN pos IS NULL OR pos < 1 THEN 0
    WHEN pos = 1 THEN 55
    ELSE greatest(1, 37 - pos)
  END
$$;

/* Строка протокола в том виде, в каком её понимают правила:
   - driver — имя с меткой «(i)» у гостя: в зачёте гость и тот же пилот без метки —
     разные записи (так было в листах, так считают правила);
   - is_guest — «(i)» или смена дивизиона (в дивизионе, откуда ушёл);
   - round_key — номер этапа с дуэлями как 1.1 / 1.2;
   - src — к какому зачёту относится строка: дуэли идут и в гонки, и в квалы. */
CREATE VIEW api.protocol AS
SELECT
  r.id, r.season, r.division, r.session, r.round, r.duel,
  r.round + coalesce(r.duel, 0) / 10.0 AS round_key,
  r.pos,
  p.id AS participant_id,
  p.name || CASE WHEN r.is_guest THEN ' (i)' ELSE '' END AS driver,
  r.is_guest OR EXISTS (
    SELECT 1 FROM division_changes dc
     WHERE dc.season = r.season AND dc.participant_id = p.id
       AND dc.from_division = r.division AND NOT r.is_guest
  ) AS is_guest,
  t.name AS team, c.number AS car, m.name AS mfr,
  r.ql, r.dr1, r.dr2, r.dr3, r.dr4, r.cau, r.ret, r.mn, r.due, r.points,
  api.score_pts(r.pos, r.round, r.duel) AS pts
FROM results r
JOIN participants p ON p.id = r.participant_id
LEFT JOIN teams t ON t.id = r.team_id
LEFT JOIN cars c ON c.id = r.car_id
LEFT JOIN manufacturers m ON m.id = r.manufacturer_id;

/* Строки, из которых собирается зачёт, в том порядке, в каком их видели правила.
   Порядок важен: машина и марка пилота берутся из первой его строки, а при полном
   равенстве всех тай-брейков места остаются в порядке первого появления.
   Гоночный зачёт — гонки, потом дуэли; квалификационный — квалы вперемешку с дуэлями
   по номеру этапа (так лежали листы). Срез p_upto: этап N включает свои дуэли. */
CREATE FUNCTION api.standing_rows(p_season int, p_division text, p_session text, p_upto numeric)
RETURNS SETOF api.protocol STABLE LANGUAGE sql AS $$
  SELECT pr.*
    FROM api.protocol pr
   WHERE pr.season = p_season AND pr.division = p_division
     AND pr.session IN (p_session, 'duel')
     AND pr.round_key < p_upto + 1
   ORDER BY (p_session = 'race' AND pr.session = 'duel'),
            pr.round, pr.duel NULLS FIRST, pr.pos IS NULL, pr.pos, pr.id
$$;

/* Команда пилота — по последней гонке, где она указана; гонок не было — по последней
   квалификации (в сезоне пилот может сменить команду). Не зависит от среза. */
CREATE FUNCTION api.team_of(p_season int, p_division text)
RETURNS TABLE (driver text, team text) STABLE LANGUAGE sql AS $$
  WITH race AS (
    SELECT DISTINCT ON (pr.driver) pr.driver, pr.team
      FROM api.protocol pr
     WHERE pr.season = p_season AND pr.division = p_division AND pr.session = 'race'
       AND pr.team IS NOT NULL AND pr.team <> '—'
     ORDER BY pr.driver, pr.round_key DESC, pr.pos IS NULL DESC, pr.pos DESC, pr.id DESC
  ), qual AS (
    SELECT DISTINCT ON (pr.driver) pr.driver, pr.team
      FROM api.protocol pr
     WHERE pr.season = p_season AND pr.division = p_division AND pr.session IN ('qual', 'duel')
       AND pr.team IS NOT NULL AND pr.team <> '—'
     ORDER BY pr.driver, pr.round_key DESC, pr.pos IS NULL DESC, pr.pos DESC, pr.id DESC
  )
  SELECT coalesce(race.driver, qual.driver), coalesce(race.team, qual.team)
    FROM race FULL JOIN qual ON qual.driver = race.driver
$$;

/* Личный зачёт по строкам (регулярный, без Чейза).
   Статистика мест — без дуэлей и этапа 0. Тай-брейк (п. 9.8): очки → победы →
   число 2-х, 3-х… мест → более ранняя первая победа → порядок первого появления.
   Счётчики мест — массив [мест 2-х, 3-х, …]: массивы сравниваются поэлементно,
   что и есть «сравнить по вторым местам, при равенстве — по третьим…». */
CREATE FUNCTION api.standings_regular(p_season int, p_division text, p_session text, p_upto numeric)
RETURNS TABLE (
  driver text, team text, car text, mfr text, "isGuest" boolean,
  total int, "sheetPts" double precision, best int, wins int, "firstWin" int,
  "posSum" int, finishes int, top5 int, top10 int, pos_counts int[], ord bigint
) STABLE LANGUAGE sql AS $$
  WITH rows AS (
    SELECT r.*, row_number() OVER () AS ord
      FROM api.standing_rows(p_season, p_division, p_session, p_upto) r
  ), stat AS (
    SELECT * FROM rows WHERE pos IS NOT NULL AND duel IS NULL AND round <> 0
  ), agg AS (
    SELECT rows.driver,
           bool_or(rows.is_guest) AS is_guest,
           sum(rows.pts)::int AS total,
           coalesce(sum(rows.points) FILTER (WHERE rows.round <> 0), 0) AS sheet_pts,
           min(rows.ord) AS ord
      FROM rows GROUP BY rows.driver
  ), first_row AS (
    SELECT DISTINCT ON (rows.driver) rows.driver, rows.car, rows.mfr
      FROM rows ORDER BY rows.driver, rows.ord
  ), st AS (
    SELECT stat.driver,
           min(stat.pos) AS best, sum(stat.pos)::int AS pos_sum, count(*)::int AS finishes,
           count(*) FILTER (WHERE stat.pos <= 5)::int AS top5,
           count(*) FILTER (WHERE stat.pos <= 10)::int AS top10,
           count(*) FILTER (WHERE stat.pos = 1)::int AS wins,
           min(stat.round) FILTER (WHERE stat.pos = 1) AS first_win,
           array_agg(stat.pos) AS positions
      FROM stat GROUP BY stat.driver
  )
  SELECT agg.driver,
         coalesce(tf.team, '—'),
         coalesce(nullif(fr.car, ''), '—'),
         coalesce(fr.mfr, ''),
         agg.is_guest,
         agg.total, agg.sheet_pts,
         st.best, coalesce(st.wins, 0), st.first_win,
         coalesce(st.pos_sum, 0), coalesce(st.finishes, 0),
         coalesce(st.top5, 0), coalesce(st.top10, 0),
         ARRAY(SELECT (SELECT count(*)::int FROM unnest(coalesce(st.positions, '{}'::int[])) p WHERE p = k)
                 FROM generate_series(2, 100) k ORDER BY k),
         agg.ord
    FROM agg
    JOIN first_row fr ON fr.driver = agg.driver
    LEFT JOIN st ON st.driver = agg.driver
    LEFT JOIN api.team_of(p_season, p_division) tf ON tf.driver = agg.driver
$$;

/* Места 1..N по порядку тай-брейка; гость остаётся на своём по очкам месте,
   но номера места у него нет — он вне зачёта. */
CREATE FUNCTION api.standings_ranked(p_season int, p_division text, p_session text, p_upto numeric)
RETURNS TABLE (
  driver text, team text, car text, mfr text, "isGuest" boolean,
  total int, "sheetPts" double precision, best int, wins int, "firstWin" int,
  "posSum" int, finishes int, top5 int, top10 int, rank int, pos_counts int[], ord bigint
) STABLE LANGUAGE sql AS $$
  WITH s AS (
    SELECT *, row_number() OVER (
             ORDER BY total DESC, wins DESC, pos_counts DESC, "firstWin" ASC NULLS LAST, ord
           ) AS n
      FROM api.standings_regular(p_season, p_division, p_session, p_upto)
  )
  SELECT driver, team, car, mfr, "isGuest", total, "sheetPts", best, wins, "firstWin",
         "posSum", finishes, top5, top10,
         CASE WHEN "isGuest" THEN NULL
              ELSE (count(*) FILTER (WHERE NOT "isGuest") OVER (ORDER BY n))::int END,
         pos_counts, ord
    FROM s ORDER BY n
$$;

/* Этапы квалификаций, проведённые в сезоне (дуэли — не этапы, этап 0 вне зачёта) */
CREATE FUNCTION api.qual_rounds(p_season int, p_division text)
RETURNS TABLE (round int) STABLE LANGUAGE sql AS $$
  SELECT DISTINCT r.round FROM results r
   WHERE r.season = p_season AND r.division = p_division
     AND r.session = 'qual' AND r.duel IS NULL AND r.round <> 0
$$;

/* Ценз квалификаций (п. 10.3): к этапу p_at можно пропустить не больше пяти
   проведённых квалификаций. Гостевые строки участия не дают. */
CREATE FUNCTION api.qual_eligible(p_season int, p_division text, p_driver text, p_at numeric)
RETURNS boolean STABLE LANGUAGE sql AS $$
  SELECT (SELECT count(*) FROM api.qual_rounds(p_season, p_division) q WHERE q.round <= p_at)
       - (SELECT count(DISTINCT pr.round) FROM api.protocol pr
           WHERE pr.season = p_season AND pr.division = p_division
             AND pr.session = 'qual' AND pr.duel IS NULL AND pr.round <> 0
             AND NOT pr.is_guest AND pr.driver = p_driver AND pr.round <= p_at)
       <= 5
$$;

/* Зачёт с Чейзом: топ-16 (без гостей и прошедшие ценз квал на 26 этапе) берут
   стартовые баллы 2100…2000 плюс очки, набранные строго после 26 этапа; при равенстве
   у них решают результаты Чейза. Остальные копят очки как в регулярном сезоне.
   Статистика (победы, места, топ-5/10) у всех — за весь сезон. */
CREATE FUNCTION api.standings_chase(p_season int, p_division text, p_session text, p_upto numeric)
RETURNS TABLE (
  driver text, team text, car text, mfr text, "isGuest" boolean,
  total int, "sheetPts" double precision, best int, wins int, "firstWin" int,
  "posSum" int, finishes int, top5 int, top10 int, rank int,
  "chaseSeed" int, chase_wins int, chase_first_win int
) STABLE LANGUAGE sql AS $$
  WITH base AS (
    SELECT b.*, row_number() OVER () AS n
      FROM api.standings_ranked(p_season, p_division, p_session, p_upto) b
  ), at26 AS (
    SELECT s.driver, s."isGuest", row_number() OVER () AS n
      FROM api.standings_ranked(p_season, p_division, p_session, api.chase_start()) s
  ), seeds AS (
    SELECT a.driver, row_number() OVER (ORDER BY a.n)::int AS seed
      FROM at26 a
     WHERE NOT a."isGuest" AND api.qual_eligible(p_season, p_division, a.driver, api.chase_start())
     ORDER BY a.n
     LIMIT 16
  ), post AS (
    -- очки и тай-брейки строго после 26 этапа: строки среза минус строки до 27 этапа
    SELECT pr.driver,
           sum(pr.pts)::int AS total,
           count(*) FILTER (WHERE pr.pos = 1 AND pr.duel IS NULL AND pr.round <> 0)::int AS wins,
           min(pr.round) FILTER (WHERE pr.pos = 1 AND pr.duel IS NULL AND pr.round <> 0) AS first_win,
           ARRAY(SELECT (SELECT count(*)::int FROM unnest(
                    array_agg(pr.pos) FILTER (WHERE pr.pos IS NOT NULL AND pr.duel IS NULL AND pr.round <> 0)
                  ) p WHERE p = k) FROM generate_series(2, 100) k ORDER BY k) AS pos_counts
      FROM api.standing_rows(p_season, p_division, p_session, p_upto) pr
     WHERE pr.round_key > api.chase_start()
     GROUP BY pr.driver
  ), merged AS (
    SELECT b.*, sd.seed,
           CASE WHEN sd.seed IS NULL THEN b.total
                ELSE api.chase_points(sd.seed) + coalesce(po.total, 0) END AS m_total,
           CASE WHEN sd.seed IS NULL THEN b.wins ELSE coalesce(po.wins, 0) END AS k_wins,
           CASE WHEN sd.seed IS NULL THEN b.pos_counts
                ELSE coalesce(po.pos_counts, array_fill(0, ARRAY[99])) END AS k_counts,
           CASE WHEN sd.seed IS NULL THEN b."firstWin" ELSE po.first_win END AS k_first,
           po.wins AS p_wins, po.first_win AS p_first
      FROM base b
      LEFT JOIN seeds sd ON sd.driver = b.driver
      LEFT JOIN post po ON po.driver = b.driver
  ), ordered AS (
    SELECT m.*, row_number() OVER (
             ORDER BY m_total DESC, k_wins DESC, k_counts DESC, k_first ASC NULLS LAST, n
           ) AS o
      FROM merged m
  )
  SELECT driver, team, car, mfr, "isGuest", m_total, "sheetPts", best, wins, "firstWin",
         "posSum", finishes, top5, top10,
         CASE WHEN "isGuest" THEN NULL
              ELSE (count(*) FILTER (WHERE NOT "isGuest") OVER (ORDER BY o))::int END,
         seed,
         CASE WHEN seed IS NULL THEN NULL ELSE coalesce(p_wins, 0) END,
         CASE WHEN seed IS NULL THEN NULL ELSE p_first END
    FROM ordered ORDER BY o
$$;

/* Реальный Чейз (очки сброшены на сетку) — только после 26 этапа; у независимых
   Чейза нет вообще. p_chase: 'auto' | 'regular' | 'chase' — выбор тумблера. */
CREATE FUNCTION api.is_chase(p_session text, p_upto numeric, p_chase text) RETURNS boolean
IMMUTABLE LANGUAGE sql AS $$
  SELECT p_session NOT IN ('indRaces', 'indQuals')
     AND p_upto > api.chase_start()
     AND coalesce(p_chase, 'auto') <> 'regular'
$$;

/* Зачёт пилотов на этап с учётом режима. p_session: races | quals | indRaces | indQuals.
   Независимые — зачёт без команд коалиций, места пересчитаны заново. */
CREATE FUNCTION api.driver_standings(p_season int, p_division text, p_session text,
                                     p_upto numeric, p_chase text DEFAULT 'auto')
RETURNS json STABLE LANGUAGE plpgsql AS $$
DECLARE
  src text := CASE WHEN p_session IN ('quals', 'indQuals') THEN 'qual' ELSE 'race' END;
BEGIN
  IF api.is_chase(p_session, p_upto, p_chase) THEN
    RETURN (SELECT coalesce(json_agg(json_build_object(
      'driver', s.driver, 'team', s.team, 'car', s.car, 'mfr', s.mfr, 'isGuest', s."isGuest",
      'total', s.total, 'sheetPts', s."sheetPts", 'best', s.best, 'wins', s.wins,
      'firstWin', s."firstWin", 'posSum', s."posSum", 'finishes', s.finishes,
      'top5', s.top5, 'top10', s.top10, 'rank', s.rank, 'chaseSeed', s."chaseSeed",
      'chase', CASE WHEN s."chaseSeed" IS NULL THEN NULL
                    ELSE json_build_object('wins', s.chase_wins, 'firstWin', s.chase_first_win) END
    )), '[]') FROM api.standings_chase(p_season, p_division, src, p_upto) s);
  END IF;

  RETURN (
    WITH s AS (
      SELECT r.*, row_number() OVER () AS n
        FROM api.standings_ranked(p_season, p_division, src, p_upto) r
       WHERE p_session NOT IN ('indRaces', 'indQuals')
          OR (r.team IS NOT NULL AND r.team <> '—'
              AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.name = r.team AND t.is_coalition))
    ), ranked AS (
      -- у независимых места пересчитываются заново
      SELECT s.*, CASE WHEN s."isGuest" THEN NULL
                       ELSE (count(*) FILTER (WHERE NOT s."isGuest") OVER (ORDER BY s.n))::int END AS place
        FROM s
    )
    SELECT coalesce(json_agg(json_build_object(
      'driver', driver, 'team', team, 'car', car, 'mfr', mfr, 'isGuest', "isGuest",
      'total', total, 'sheetPts', "sheetPts", 'best', best, 'wins', wins,
      'firstWin', "firstWin", 'posSum', "posSum", 'finishes', finishes,
      'top5', top5, 'top10', top10, 'rank', place
    ) ORDER BY n), '[]') FROM ranked
  );
END $$;

/* Всё, что нужно таблице зачёта на выбранный этап: сам зачёт, место каждого на
   прошлом этапе (колонка ±) и список этапов для селектора. Один вызов — одна таблица. */
CREATE FUNCTION api.slice(p_season int, p_division text, p_session text,
                          p_upto numeric DEFAULT NULL, p_chase text DEFAULT 'auto')
RETURNS json STABLE LANGUAGE plpgsql AS $$
DECLARE
  src text := CASE WHEN p_session IN ('quals', 'indQuals') THEN 'qual' ELSE 'race' END;
  rounds int[];
  at numeric;
  prev numeric;
  cur json;
  prev_st json;
BEGIN
  SELECT array_agg(DISTINCT r.round ORDER BY r.round) INTO rounds
    FROM results r
   WHERE r.season = p_season AND r.division = p_division AND r.session = src
     AND r.duel IS NULL AND r.round <> 0;
  at := coalesce(p_upto, rounds[array_length(rounds, 1)]);
  SELECT max(x) INTO prev FROM unnest(rounds) x WHERE x < at;

  IF p_session = 'owners' THEN
    cur := api.owner_standings(p_season, p_division, at, p_chase);
    prev_st := CASE WHEN prev IS NULL THEN '[]'::json ELSE api.owner_standings(p_season, p_division, prev, p_chase) END;
    RETURN json_build_object('at', at, 'rounds', rounds, 'standings', cur,
      'prevRank', (SELECT coalesce(json_object_agg(e->>'car', (e->>'rank')::int), '{}') FROM json_array_elements(prev_st) e));
  END IF;

  cur := api.driver_standings(p_season, p_division, p_session, at, p_chase);
  prev_st := CASE WHEN prev IS NULL THEN '[]'::json
                  ELSE api.driver_standings(p_season, p_division, p_session, prev, p_chase) END;

  /* Граница Чейза на этом срезе (у независимых её нет): топ-16 не-гостей, прошедших
     ценз квалификаций к этому этапу. «± Чейз»: в Чейзе — запас над первым вне Чейза
     (в реальном Чейзе — отставание от лидера), вне Чейза — отставание от последнего
     в Чейзе (в реальном Чейзе — от первого после границы). cutoff — первый после границы. */
  IF p_session NOT IN ('indRaces', 'indQuals') THEN
    cur := (
      WITH s AS (
        SELECT e.value::jsonb AS v, e.n,
               e.value->>'driver' AS driver, (e.value->>'isGuest')::boolean AS guest,
               (e.value->>'total')::int AS total,
               api.qual_eligible(p_season, p_division, e.value->>'driver', at) AS eligible
          FROM json_array_elements(cur) WITH ORDINALITY e(value, n)
      ), po AS (
        SELECT n FROM s WHERE NOT guest AND eligible ORDER BY n LIMIT 16
      ), f AS (
        SELECT s.*, s.n IN (SELECT n FROM po) AS playoff FROM s
      ), refs AS (
        SELECT
          (SELECT total FROM f WHERE playoff ORDER BY n LIMIT 1) AS leader,
          (SELECT total FROM f WHERE playoff ORDER BY n DESC LIMIT 1) AS last_in,
          (SELECT total FROM f WHERE NOT guest AND NOT playoff AND eligible ORDER BY n LIMIT 1) AS first_out,
          (SELECT n FROM f WHERE NOT guest AND n > coalesce((SELECT max(n) FROM f WHERE playoff), 0) ORDER BY n LIMIT 1) AS after_n,
          api.is_chase(p_session, at, p_chase) AS real_chase
      )
      SELECT coalesce(json_agg((f.v || jsonb_build_object(
               'playoff', f.playoff,
               'cutoff', f.n = r.after_n,
               'gap', CASE WHEN f.guest OR NOT f.eligible THEN NULL
                           ELSE f.total - CASE
                             WHEN r.real_chase AND f.playoff THEN r.leader
                             WHEN r.real_chase THEN (SELECT total FROM f f2 WHERE f2.n = r.after_n)
                             WHEN f.playoff THEN r.first_out
                             ELSE r.last_in END END
             ))::json ORDER BY f.n), '[]')
        FROM f, refs r
    );
  END IF;

  RETURN json_build_object('at', at, 'rounds', rounds, 'standings', cur,
    'prevRank', (SELECT coalesce(json_object_agg(e->>'driver', (e->>'rank')::int), '{}')
                   FROM json_array_elements(prev_st) e));
END $$;

/* ── Владельцы: зачёт по номеру машины (гонки + дуэли). Гость очки машине приносит;
   «-» и пусто — без номера. Тай-брейк тот же, что у пилотов.
   При полном равенстве порядок повторяет прежний расчёт: машины собирались в объект
   по номеру, а объект JS отдаёт номера-целые («4», «14») по возрастанию числа, остальные
   («00», «06») — в порядке появления после них. Отсюда ord ниже. ── */
CREATE FUNCTION api.owners_regular(p_season int, p_division text, p_upto numeric,
                                   p_from numeric DEFAULT NULL)
RETURNS TABLE (car text, total int, wins int, "firstWin" int, best int, pos_counts int[],
               drivers text[], top5 int[], ord bigint)
STABLE LANGUAGE sql AS $$
  WITH rows AS (
    SELECT r.*, row_number() OVER () AS o
      FROM api.standing_rows(p_season, p_division, 'race', p_upto) r
  ), f AS (
    SELECT * FROM rows
     WHERE car IS NOT NULL AND car <> '' AND car <> '-'
       AND (p_from IS NULL OR round_key > p_from)
  ), stat AS (
    SELECT * FROM f WHERE pos IS NOT NULL AND duel IS NULL AND round <> 0
  )
  SELECT f.car,
         sum(f.pts)::int,
         (SELECT count(*)::int FROM stat s WHERE s.car = f.car AND s.pos = 1),
         (SELECT min(s.round) FROM stat s WHERE s.car = f.car AND s.pos = 1),
         (SELECT min(s.pos) FROM stat s WHERE s.car = f.car),
         ARRAY(SELECT (SELECT count(*)::int FROM stat s WHERE s.car = f.car AND s.pos = k)
                 FROM generate_series(2, 100) k ORDER BY k),
         -- пилоты в порядке появления
         (SELECT array_agg(d ORDER BY mo) FROM (
            SELECT f2.driver AS d, min(f2.o) AS mo FROM f f2 WHERE f2.car = f.car GROUP BY f2.driver) x),
         (SELECT array_agg(p ORDER BY p) FROM (
            SELECT s.pos AS p FROM stat s WHERE s.car = f.car ORDER BY s.pos LIMIT 5) y),
         CASE WHEN f.car ~ '^(0|[1-9][0-9]{0,8})$' THEN f.car::bigint
              ELSE 10000000000 + min(f.o) END
    FROM f GROUP BY f.car
$$;

CREATE FUNCTION api.owner_standings(p_season int, p_division text, p_upto numeric,
                                    p_chase text DEFAULT 'auto')
RETURNS json STABLE LANGUAGE sql AS $$
  WITH base AS (
    SELECT b.*, row_number() OVER (
             ORDER BY b.total DESC, b.wins DESC, b.pos_counts DESC, b."firstWin" ASC NULLS LAST, b.ord
           ) AS n
      FROM api.owners_regular(p_season, p_division, p_upto) b
  ), chase_on AS (
    SELECT api.is_chase('owners', p_upto, p_chase) AS enabled
  ), seeds AS (
    SELECT s.car, row_number() OVER (
             ORDER BY s.total DESC, s.wins DESC, s.pos_counts DESC, s."firstWin" ASC NULLS LAST, s.ord
           )::int AS seed
      FROM api.owners_regular(p_season, p_division, api.chase_start()) s
     ORDER BY 2 LIMIT 16
  ), post AS (
    SELECT * FROM api.owners_regular(p_season, p_division, p_upto, api.chase_start())
  ), merged AS (
    SELECT b.*, CASE WHEN (SELECT enabled FROM chase_on) THEN sd.seed END AS seed,
           po.total AS p_total, po.wins AS p_wins, po.pos_counts AS p_counts, po."firstWin" AS p_first
      FROM base b
      LEFT JOIN seeds sd ON sd.car = b.car
      LEFT JOIN post po ON po.car = b.car
  ), ordered AS (
    SELECT m.*,
           CASE WHEN seed IS NULL THEN total ELSE api.chase_points(seed) + coalesce(p_total, 0) END AS m_total,
           row_number() OVER (ORDER BY
             CASE WHEN seed IS NULL THEN total ELSE api.chase_points(seed) + coalesce(p_total, 0) END DESC,
             CASE WHEN seed IS NULL THEN wins ELSE coalesce(p_wins, 0) END DESC,
             CASE WHEN seed IS NULL THEN pos_counts ELSE coalesce(p_counts, array_fill(0, ARRAY[99])) END DESC,
             CASE WHEN seed IS NULL THEN "firstWin" ELSE p_first END ASC NULLS LAST,
             n) AS o
      FROM merged m
  )
  SELECT coalesce(json_agg(json_build_object(
    'car', car, 'total', m_total, 'wins', wins, 'firstWin', "firstWin", 'best', best,
    'drivers', drivers, 'top5', coalesce(top5, '{}'), 'rank', o, 'chaseSeed', seed
  ) ORDER BY o), '[]') FROM ordered
$$;


/* ── Командный зачёт: на каждом этапе в зачёт идут два лучших результата команды.
   Гость команде очки приносит; «Guest entry» — гость без команды. Дуэли и этап 0
   не в счёт. Штраф действует со своего этапа (на срезе до него — без штрафа).
   Команда из одних гостей в зачёте не участвует: места у неё нет, а в сводных
   (p_with_guest_only) она видна. При равенстве очков — порядок появления. ── */
CREATE FUNCTION api.team_standings(p_season int, p_division text, p_upto numeric,
                                   p_with_guest_only boolean DEFAULT false)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH rows AS (
    SELECT r.*, row_number() OVER () AS o
      FROM api.standing_rows(p_season, p_division, 'race', p_upto) r
  ), at AS (
    -- последний этап среза — по нему решается, вступил ли штраф
    SELECT coalesce(max(round_key), 0) AS at FROM rows
  ), f AS (
    SELECT * FROM rows
     WHERE team IS NOT NULL AND team <> '—' AND team <> 'Guest entry'
       AND duel IS NULL AND round <> 0
  ), ranked AS (
    -- очередность внутри этапа: больше очков выше, при равенстве — кто раньше в протоколе
    SELECT f.*, row_number() OVER (PARTITION BY f.team, f.round ORDER BY f.pts DESC, f.o) AS k
      FROM f
  ), best AS (
    SELECT * FROM ranked WHERE k <= 2
  ), per_round AS (
    SELECT team, round, sum(pts)::int AS pts,
           json_agg(json_build_object('driver', driver, 'pos', pos, 'pts', pts) ORDER BY k) AS best
      FROM best GROUP BY team, round
  ), scorers AS (
    SELECT team, json_object_agg(driver, json_build_object('rounds', n, 'pts', p)) AS scorers
      FROM (SELECT team, driver, count(*)::int AS n, sum(pts)::int AS p FROM best GROUP BY team, driver) x
     GROUP BY team
  ), drivers AS (
    SELECT team, array_agg(driver ORDER BY mo) AS drivers,
           bool_or(NOT guest) AS entered
      FROM (SELECT team, driver, min(o) AS mo, bool_and(is_guest) AS guest FROM f GROUP BY team, driver) x
     GROUP BY team
  ), positions AS (
    SELECT team, array_agg(pos ORDER BY pos) AS best_positions
      FROM f WHERE pos IS NOT NULL GROUP BY team
  ), teams_all AS (
    SELECT f.team, min(f.o) AS first_o FROM f GROUP BY f.team
  ), totals AS (
    SELECT ta.team, ta.first_o,
           coalesce((SELECT sum(pr.pts) FROM per_round pr WHERE pr.team = ta.team), 0)::int AS raw,
           d.points AS ded_pts, d.round AS ded_round, d.reason AS ded_reason
      FROM teams_all ta
      LEFT JOIN teams t ON t.name = ta.team
      LEFT JOIN deductions d ON d.team_id = t.id AND d.season = p_season
  ), scored AS (
    SELECT tt.*,
           CASE WHEN tt.ded_pts IS NOT NULL AND (tt.ded_round IS NULL OR tt.ded_round <= (SELECT at FROM at))
                THEN tt.ded_pts ELSE 0 END AS penalty
      FROM totals tt
  ), ordered AS (
    SELECT s.*, dr.entered, dr.drivers,
           row_number() OVER (ORDER BY s.raw - s.penalty DESC, s.first_o) AS n
      FROM scored s JOIN drivers dr ON dr.team = s.team
  ), placed AS (
    SELECT o.*, CASE WHEN o.entered
                     THEN (count(*) FILTER (WHERE o.entered) OVER (ORDER BY o.n))::int END AS place
      FROM ordered o
  )
  SELECT coalesce(json_agg(json_build_object(
    'team', p.team, 'total', p.raw - p.penalty, 'penalty', p.penalty,
    'penaltyRound', p.ded_round, 'penaltyReason', coalesce(p.ded_reason, ''),
    'roundPts', (SELECT coalesce(json_object_agg(pr.round, pr.pts), '{}') FROM per_round pr WHERE pr.team = p.team),
    'roundBest', (SELECT coalesce(json_object_agg(pr.round, pr.best), '{}') FROM per_round pr WHERE pr.team = p.team),
    -- накопленные очки после каждого этапа среза (для графика): штраф — со своего этапа
    'cumPts', (SELECT coalesce(json_object_agg(r.round, (
                  SELECT coalesce(sum(pr.pts), 0) FROM per_round pr WHERE pr.team = p.team AND pr.round <= r.round)
                  - CASE WHEN p.ded_pts IS NOT NULL AND (p.ded_round IS NULL OR p.ded_round <= r.round)
                         THEN p.ded_pts ELSE 0 END ORDER BY r.round), '{}')
                 FROM (SELECT DISTINCT round FROM f) r),
    'scorers', coalesce((SELECT sc.scorers FROM scorers sc WHERE sc.team = p.team), '{}'),
    'drivers', p.drivers, 'entered', p.entered,
    'bestPositions', coalesce((SELECT ps.best_positions FROM positions ps WHERE ps.team = p.team), '{}'),
    'rank', p.place
  ) ORDER BY p.n), '[]')
    FROM placed p
   WHERE p_with_guest_only OR p.entered
$$;

/* ── История мест: место в зачёте после каждого этапа (графики, карточки).
   Гонки и квалы — с Чейзом после 26 этапа, как основной зачёт. ── */
CREATE FUNCTION api.rank_history(p_season int, p_division text, p_session text)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH rounds AS (
    SELECT DISTINCT round FROM results
     WHERE season = p_season AND division = p_division AND session = p_session
       AND duel IS NULL AND round <> 0
  ), per AS (
    -- гонки: этап N вместе со своими дуэлями; квалы: строго этапы <= N — так считал
    -- прежний график, и на первом этапе дуэли 1.1/1.2 в историю квал не попадали
    SELECT rd.round, e->>'driver' AS driver, (e->>'rank')::int AS rank
      FROM rounds rd,
           json_array_elements(api.driver_standings(p_season, p_division,
             CASE WHEN p_session = 'qual' THEN 'quals' ELSE 'races' END,
             CASE WHEN p_session = 'qual' THEN rd.round - 0.95 ELSE rd.round END)) e
  )
  SELECT coalesce(json_object_agg(driver, hist), '{}') FROM (
    SELECT driver, json_object_agg(round, rank ORDER BY round) AS hist FROM per GROUP BY driver
  ) x
$$;

-- История мест команд по этапам
CREATE FUNCTION api.team_rank_history(p_season int, p_division text)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH rounds AS (
    SELECT DISTINCT round FROM results
     WHERE season = p_season AND division = p_division AND session = 'race'
       AND duel IS NULL AND round <> 0
  ), per AS (
    SELECT rd.round, e->>'team' AS team, (e->>'rank')::int AS rank
      FROM rounds rd, json_array_elements(api.team_standings(p_season, p_division, rd.round)) e
  )
  SELECT coalesce(json_object_agg(team, hist), '{}') FROM (
    SELECT team, json_object_agg(round, rank ORDER BY round) AS hist FROM per GROUP BY team
  ) x
$$;

/* Очки по этапам для графиков: без Чейза — «как если бы сброса не было» */
CREATE FUNCTION api.chart_points(p_season int, p_division text, p_session text)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH rows AS (
    SELECT * FROM api.standing_rows(p_season, p_division, p_session, 1000)
  ), s AS (
    SELECT st.*, row_number() OVER () AS n FROM api.standings_ranked(p_season, p_division, p_session, 1000) st
  )
  SELECT coalesce(json_agg(json_build_object(
    'driver', s.driver, 'team', s.team,
    'roundPts', (SELECT json_object_agg(k, v ORDER BY k) FROM (
        SELECT trim_scale(r.round_key) AS k, sum(r.pts)::int AS v FROM rows r WHERE r.driver = s.driver GROUP BY r.round_key) z)
  ) ORDER BY s.n), '[]') FROM s
$$;

/* ── Сводная «пилот × этап»: место на каждом этапе (null — DQ: строка есть, места нет;
   нет ключа — не участвовал); для гонок — ещё и место в квалификации. ── */
CREATE FUNCTION api.pivot(p_season int, p_division text, p_session text)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH pos_map AS (
    -- из нескольких строк на этап — лучшее место; DQ перебивается реальным местом
    SELECT CASE WHEN session = 'race' THEN 'race' ELSE 'qual' END AS sess,
           driver, round_key, min(pos) AS pos
      FROM api.protocol
     WHERE season = p_season AND division = p_division
     GROUP BY 1, 2, 3
  ), st AS (
    SELECT e.value->>'driver' AS driver, (e.value->>'rank')::int AS rank, e.n
      FROM json_array_elements(api.driver_standings(p_season, p_division,
             CASE WHEN p_session = 'qual' THEN 'quals' ELSE 'races' END, 1000)) WITH ORDINALITY e(value, n)
  ), rounds AS (
    -- колонки сводной: этапы, где есть протокол; у квал — вместе с дуэлями 1.1/1.2
    SELECT array_agg(DISTINCT trim_scale(round_key) ORDER BY trim_scale(round_key)) AS r FROM api.protocol
     WHERE season = p_season AND division = p_division AND round <> 0
       AND (session = p_session OR (p_session = 'qual' AND session = 'duel'))
  ), totals AS (
    -- итог строки сводной: очки за места по её колонкам
    SELECT pm.driver, sum(api.score_pts(pm.pos, floor(pm.round_key)::int,
             CASE WHEN pm.round_key <> floor(pm.round_key) THEN 1::smallint END))::int AS total
      FROM pos_map pm
     WHERE pm.sess = p_session AND trim_scale(pm.round_key) = ANY ((SELECT r FROM rounds)::numeric[])
     GROUP BY pm.driver
  )
  SELECT json_build_object(
    'rounds', (SELECT to_json(r) FROM rounds),
    'totals', (SELECT coalesce(json_object_agg(driver, total), '{}') FROM totals),
    'order', (SELECT json_agg(driver ORDER BY n) FROM st),
    'rankOf', (SELECT json_object_agg(driver, rank) FROM st),
    'map', (SELECT coalesce(json_object_agg(driver, m), '{}') FROM (
              SELECT driver, json_object_agg(trim_scale(round_key), pos) AS m FROM pos_map
               WHERE sess = p_session GROUP BY driver) a),
    'qualMap', CASE WHEN p_session = 'qual' THEN NULL ELSE (
              SELECT coalesce(json_object_agg(driver, m), '{}') FROM (
                SELECT driver, json_object_agg(trim_scale(round_key), pos) AS m FROM pos_map
                 WHERE sess = 'qual' GROUP BY driver) b) END
  )
$$;

/* ── Отыгранные / потерянные позиции: квала − гонка по этапам (без дуэлей, этапа 0,
   гостей). Порядок: итог, затем сумма отыгранного, затем порядок появления. ── */
CREATE FUNCTION api.gains(p_season int, p_division text)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH best AS (
    SELECT session AS sess, driver, round, min(pos) AS pos, min(id) AS first_id
      FROM api.protocol
     WHERE season = p_season AND division = p_division AND NOT is_guest
       AND pos IS NOT NULL AND duel IS NULL AND round <> 0 AND session IN ('race', 'qual')
     GROUP BY 1, 2, 3
  ), pairs AS (
    SELECT r.driver, r.round, q.pos - r.pos AS diff, q.pos AS qp, r.pos AS rp
      FROM best r JOIN best q ON q.sess = 'qual' AND q.driver = r.driver AND q.round = r.round
     WHERE r.sess = 'race'
  ), first_seen AS (
    SELECT driver, min(first_id) AS first_id FROM best WHERE sess = 'race' GROUP BY driver
  ), per AS (
    SELECT p.driver,
           sum(greatest(p.diff, 0))::int AS gained, sum(greatest(-p.diff, 0))::int AS lost,
           count(*)::int AS n,
           json_object_agg(p.round, json_build_object('diff', p.diff, 'qp', p.qp, 'rp', p.rp) ORDER BY p.round) AS cells
      FROM pairs p GROUP BY p.driver
  ), ordered AS (
    SELECT per.*, row_number() OVER (ORDER BY per.gained - per.lost DESC, per.gained DESC, fs.first_id) AS rank
      FROM per JOIN first_seen fs ON fs.driver = per.driver
  )
  SELECT coalesce(json_agg(json_build_object(
    'driver', o.driver, 'team', coalesce(tf.team, '—'), 'cells', o.cells,
    'gained', o.gained, 'lost', o.lost, 'net', o.gained - o.lost, 'n', o.n, 'rank', o.rank
  ) ORDER BY o.rank), '[]')
    FROM ordered o LEFT JOIN api.team_of(p_season, p_division) tf ON tf.driver = o.driver
$$;

/* ── Зачёт им. Semen GOLUBOCHKIN: очки = сколько участников финишировало ниже него,
   но не ниже тебя. Этапы без него и этапы, где ниже него нет своих, не считаются.
   Дуэли и (для квал) квалификации по метрике не в счёт. ── */
CREATE FUNCTION api.golub(p_season int, p_division text, p_session text)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH metric_rounds AS (
    -- квала по метрике — не прогноз, а замер: прогнозов DR1–DR4 на этапе нет ни у кого
    SELECT round FROM results
     WHERE season = p_season AND division = p_division AND session = 'qual' AND duel IS NULL
     GROUP BY round
    HAVING bool_and(dr1 IS NULL AND dr2 IS NULL AND dr3 IS NULL AND dr4 IS NULL)
  ), field AS (
    SELECT pr.* FROM api.protocol pr
     WHERE pr.season = p_season AND pr.division = p_division AND pr.session = p_session
       AND pr.pos IS NOT NULL AND pr.duel IS NULL AND pr.round <> 0
       AND NOT (p_session = 'qual' AND pr.round IN (SELECT round FROM metric_rounds))
  ), gp AS (
    SELECT f.round, min(f.pos) AS gp FROM field f WHERE f.driver LIKE '%GOLUBOCHKIN%' GROUP BY f.round
  ), live AS (
    -- этап идёт в зачёт, только если ниже него финишировал хоть кто-то из своих
    SELECT g.round, g.gp, (SELECT count(*)::int FROM field f2 WHERE f2.round = g.round) AS n
      FROM gp g
     WHERE EXISTS (SELECT 1 FROM field f WHERE f.round = g.round AND f.pos > g.gp
                     AND f.driver NOT LIKE '%GOLUBOCHKIN%' AND NOT f.is_guest)
  ), cells AS (
    SELECT f.driver, f.round, l.gp, f.pos, f.id,
           CASE WHEN f.pos <= l.gp THEN 0
                ELSE (SELECT count(*)::int FROM field x WHERE x.round = f.round AND x.pos > l.gp AND x.pos <= f.pos) END AS pts
      FROM field f JOIN live l ON l.round = f.round
     WHERE f.driver NOT LIKE '%GOLUBOCHKIN%' AND NOT f.is_guest
  ), drivers AS (
    SELECT c.driver, sum(c.pts)::int AS total, min(c.round * 100000 + c.id) AS first_seen,
           json_object_agg(c.round, json_build_object('pts', c.pts, 'gp', c.gp, 'pos', c.pos) ORDER BY c.round) AS cells
      FROM cells c GROUP BY c.driver HAVING sum(c.pts) > 0
  )
  SELECT json_build_object(
    'rounds', (SELECT coalesce(json_agg(round ORDER BY round), '[]') FROM live),
    'info', (SELECT coalesce(json_object_agg(round, json_build_object('gp', gp, 'n', n)), '{}') FROM live),
    'drivers', (SELECT coalesce(json_agg(json_build_object(
                   'driver', d.driver, 'team', coalesce(tf.team, '—'), 'total', d.total,
                   'cells', d.cells, 'rank', d.rn) ORDER BY d.rn), '[]')
                  FROM (SELECT *, row_number() OVER (ORDER BY total DESC, first_seen) AS rn FROM drivers) d
                  LEFT JOIN api.team_of(p_season, p_division) tf ON tf.driver = d.driver)
  )
$$;

/* ── Метрика команд (вкладка «Командная метрика»).
   Фулл-тайм машина — заявлена одним сплошным отрезком до последнего этапа сезона.
   FULL TIME PARTICIPATION считается только по ним; остальные блоки — по всем
   прогнозам команды (фулл-тайм, парт-тайм, гости). Только этапы регулярного сезона:
   дуэли и этап 0 не в счёт. Ранги — только у команд с ENTRIES % не ниже 45. ── */

-- Фулл-тайм машины: команда, номер, отрезок заявки
CREATE FUNCTION api.full_time_cars(p_season int, p_division text)
RETURNS TABLE (team text, car text, round_from int, round_to int, team_ord bigint)
STABLE LANGUAGE sql AS $$
  WITH e AS (
    SELECT e.*, t.name AS team, c.number AS car,
           count(*) OVER (PARTITION BY e.car_id) AS spans
      FROM entries e
      JOIN cars c ON c.id = e.car_id AND c.division = p_division
      JOIN teams t ON t.id = e.team_id
     WHERE e.season = p_season
  ), last_col AS (
    SELECT max(round_to) AS last FROM e
  )
  SELECT e.team, e.car, e.round_from, e.round_to,
         -- порядок команд как в прежней таблице: по названию, побайтово
         dense_rank() OVER (ORDER BY e.team COLLATE "C")
    FROM e, last_col
   WHERE e.spans = 1 AND e.round_to = last_col.last
$$;

CREATE FUNCTION api.metric_rows(p_season int, p_division text, p_at int)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH qual_rounds AS (
    SELECT round FROM api.qual_rounds(p_season, p_division) WHERE round <= p_at
  ), metric_rounds AS (
    SELECT round FROM results
     WHERE season = p_season AND division = p_division AND session = 'qual' AND duel IS NULL
     GROUP BY round
    HAVING bool_and(dr1 IS NULL AND dr2 IS NULL AND dr3 IS NULL AND dr4 IS NULL)
  ), ft AS (
    SELECT * FROM api.full_time_cars(p_season, p_division)
  ), quals AS (
    SELECT * FROM api.protocol
     WHERE season = p_season AND division = p_division AND session = 'qual'
       AND duel IS NULL AND round <> 0 AND round <= p_at
  ), races AS (
    SELECT * FROM api.protocol
     WHERE season = p_season AND division = p_division AND session = 'race'
       AND duel IS NULL AND round <> 0 AND round <= p_at
  ), race_team AS (
    -- пилот квалифицировался гостем без машины, а стартовал за команду: прогноз подан
    -- от её имени — берём команду из гоночной строки того же этапа (последнюю)
    SELECT DISTINCT ON (driver, round) driver, round, team
      FROM api.protocol
     WHERE season = p_season AND division = p_division AND session = 'race'
       AND duel IS NULL AND team IS NOT NULL AND team NOT IN ('—', 'Guest entry')
     ORDER BY driver, round, pos IS NULL DESC, pos DESC, id DESC
  ), q AS (
    SELECT CASE WHEN quals.team = 'Guest entry' THEN rt.team ELSE quals.team END AS team,
           quals.round, quals.pos, quals.round IN (SELECT round FROM metric_rounds) AS metric
      FROM quals LEFT JOIN race_team rt ON rt.driver = quals.driver AND rt.round = quals.round
  ), qs AS (
    SELECT team,
           count(*)::int AS entries_total,
           count(*) FILTER (WHERE NOT metric)::int AS real_quals,
           sum(pos) FILTER (WHERE NOT metric AND pos IS NOT NULL) AS q_sum,
           count(*) FILTER (WHERE NOT metric AND pos IS NOT NULL) AS q_n,
           count(*) FILTER (WHERE NOT metric AND pos <= 10)::int AS top10q
      FROM q WHERE team IS NOT NULL GROUP BY team
  ), rs AS (
    SELECT team,
           count(*)::int AS starts,
           sum(pos) FILTER (WHERE pos IS NOT NULL) AS r_sum,
           count(*) FILTER (WHERE pos IS NOT NULL) AS r_n,
           count(*) FILTER (WHERE pos <= 10)::int AS top10r,
           count(*) FILTER (WHERE pos = 1)::int AS wins
      FROM races WHERE team IS NOT NULL GROUP BY team
  ), fact AS (
    -- поданные прогнозы фулл-тайм машин: строка в квалификации по номеру машины
    SELECT ft.team, count(*)::int AS made
      FROM quals JOIN ft ON ft.team = quals.team AND ft.car = quals.car
                        AND quals.round BETWEEN ft.round_from AND ft.round_to
     WHERE quals.round IN (SELECT round FROM qual_rounds)
     GROUP BY ft.team
  ), plan AS (
    SELECT ft.team, count(*)::int AS plan
      FROM ft JOIN qual_rounds qr ON qr.round BETWEEN ft.round_from AND ft.round_to
     GROUP BY ft.team
  ), team_pts AS (
    -- командный зачёт на тот же срез, без дуэлей
    SELECT e->>'team' AS team, (e->>'total')::int AS pts
      FROM json_array_elements(api.team_standings(p_season, p_division, p_at)) e
  ), base AS (
    SELECT t.team, t.team_ord,
           coalesce(qs.entries_total, 0) AS "entriesTotal",
           coalesce(qs.real_quals, 0) AS "realQuals",
           CASE WHEN qs.q_n > 0 THEN qs.q_sum::float / qs.q_n END AS "avgQ",
           coalesce(qs.top10q, 0) AS "top10Q",
           CASE WHEN qs.real_quals > 0 THEN qs.top10q::float / qs.real_quals * 100 END AS "top10QPct",
           coalesce(rs.starts, 0) AS starts,
           CASE WHEN qs.entries_total > 0 THEN coalesce(rs.starts, 0)::float / qs.entries_total * 100 END AS "startsPct",
           CASE WHEN rs.r_n > 0 THEN rs.r_sum::float / rs.r_n END AS "avgR",
           coalesce(rs.top10r, 0) AS "top10R",
           CASE WHEN rs.starts > 0 THEN rs.top10r::float / rs.starts * 100 END AS "top10RPct",
           coalesce(rs.wins, 0) AS wins,
           coalesce(tp.pts, 0) AS "teamPts",
           coalesce(f.made, 0) AS made, coalesce(p.plan, 0) AS plan,
           CASE WHEN p.plan > 0 THEN coalesce(f.made, 0)::float / p.plan * 100 END AS pct
      FROM (SELECT DISTINCT team, team_ord FROM ft) t
      LEFT JOIN qs ON qs.team = t.team
      LEFT JOIN rs ON rs.team = t.team
      LEFT JOIN fact f ON f.team = t.team
      LEFT JOIN plan p ON p.team = t.team
      LEFT JOIN team_pts tp ON tp.team = t.team
  ), rows AS (
    SELECT * FROM base WHERE plan > 0 OR "entriesTotal" > 0
  ), ranked AS (
    -- ранги с общими местами (RANK) и только среди прошедших ценз; «—» не ранжируется
    SELECT r.*,
           CASE WHEN r.pct >= 45 AND r."avgQ" IS NOT NULL THEN rank() OVER (PARTITION BY r.pct >= 45 AND r."avgQ" IS NOT NULL ORDER BY r."avgQ") END AS "avgQRank",
           CASE WHEN r.pct >= 45 AND r."top10QPct" IS NOT NULL THEN rank() OVER (PARTITION BY r.pct >= 45 AND r."top10QPct" IS NOT NULL ORDER BY r."top10QPct" DESC) END AS "top10QPctRank",
           CASE WHEN r.pct >= 45 AND r."startsPct" IS NOT NULL THEN rank() OVER (PARTITION BY r.pct >= 45 AND r."startsPct" IS NOT NULL ORDER BY r."startsPct" DESC) END AS "startsPctRank",
           CASE WHEN r.pct >= 45 AND r."avgR" IS NOT NULL THEN rank() OVER (PARTITION BY r.pct >= 45 AND r."avgR" IS NOT NULL ORDER BY r."avgR") END AS "avgRRank",
           CASE WHEN r.pct >= 45 AND r."top10RPct" IS NOT NULL THEN rank() OVER (PARTITION BY r.pct >= 45 AND r."top10RPct" IS NOT NULL ORDER BY r."top10RPct" DESC) END AS "top10RPctRank",
           CASE WHEN r.pct >= 45 THEN rank() OVER (PARTITION BY r.pct >= 45 ORDER BY r.wins DESC) END AS "winsRank",
           CASE WHEN r.pct >= 45 THEN rank() OVER (PARTITION BY r.pct >= 45 ORDER BY r."teamPts" DESC) END AS "teamPtsRank"
      FROM rows r
  ), scored AS (
    SELECT k.*,
           CASE WHEN k.pct IS NULL OR k."avgQRank" IS NULL OR k."top10QPctRank" IS NULL OR k."startsPctRank" IS NULL
                  OR k."avgRRank" IS NULL OR k."top10RPctRank" IS NULL OR k."winsRank" IS NULL OR k."teamPtsRank" IS NULL
                THEN NULL
                ELSE (k."avgQRank" * 0.10 + k."top10QPctRank" * 0.10 + k."startsPctRank" * 0.15
                    + k."avgRRank" * 0.20 + k."top10RPctRank" * 0.20 + k."winsRank" * 0.10
                    + k."teamPtsRank" * 0.15) * (1 + (1 - k.pct / 100)) END AS metric
      FROM ranked k
  ), ordered AS (
    -- по метрике, меньше лучше; без метрики — вниз; равенство — по командным очкам
    SELECT s.*, row_number() OVER (ORDER BY s.metric ASC NULLS LAST, s."teamPts" DESC, s.team_ord) AS rank
      FROM scored s
  )
  SELECT coalesce(json_agg(((to_jsonb(o) - 'team_ord') || jsonb_build_object('ranked', coalesce(o.pct >= 45, false)))::json
                  ORDER BY o.rank), '[]') FROM ordered o
$$;

/* Срезы метрики — контрольные точки сезона (20, 26, 27 этапы); до первой точки —
   последний проведённый этап. Сама статистика — по всем этапам до выбранного. */
CREATE FUNCTION api.metric(p_season int, p_division text)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH held AS (
    SELECT round FROM api.qual_rounds(p_season, p_division)
  ), cps AS (
    SELECT round FROM held WHERE round IN (20, 26, 27)
  ), rounds AS (
    SELECT round FROM cps
    UNION ALL
    -- max() без строк даёт одну строку NULL — поэтому через подзапрос
    SELECT m FROM (SELECT max(round) AS m FROM held) x
     WHERE m IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cps)
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM api.full_time_cars(p_season, p_division))
              THEN json_build_object('rounds', '[]'::json, 'byRound', '{}'::json)
         ELSE json_build_object(
           'rounds', (SELECT json_agg(round ORDER BY round) FROM rounds),
           'byRound', (SELECT json_object_agg(round, api.metric_rows(p_season, p_division, round)) FROM rounds))
         END
$$;

/* ── Протокол этапа: гонка, квалификация или дуэль (view: race | qual | duel1 | duel2).
   Порядок: по месту; дисквалифицированный (места нет) встаёт там, где был бы по очкам
   за прогноз — прямо перед лучшим из тех, кого обошёл (никого — в конец). В квале
   по метрике очки наоборот: меньше — лучше.
   Для каждой строки отдаются: очки NASCAR, «прошёл дальше» (квала → дуэль/гонка,
   дуэль → гонка), ± квала→гонка и список ячеек с лучшим значением этапа (hl). ── */
CREATE FUNCTION api.round_protocol(p_season int, p_division text, p_round int, p_view text)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH src AS (
    SELECT pr.*,
           -- исходный порядок протокола
           row_number() OVER (ORDER BY pr.pos IS NULL, pr.pos, pr.id) AS o
      FROM api.protocol pr
     WHERE pr.season = p_season AND pr.division = p_division AND pr.round = p_round
       AND CASE p_view
             WHEN 'race'  THEN pr.session = 'race'
             WHEN 'qual'  THEN pr.session = 'qual'
             WHEN 'duel1' THEN pr.session = 'duel' AND pr.duel = 1
             WHEN 'duel2' THEN pr.session = 'duel' AND pr.duel = 2
           END
  ), kind AS (
    -- квала по метрике: прогнозов нет ни у кого — очки «меньше лучше»
    SELECT bool_and(dr1 IS NULL AND dr2 IS NULL AND dr3 IS NULL AND dr4 IS NULL) AS metric,
           count(*) AS n
      FROM src
  ), keyed AS (
    SELECT s.*,
           coalesce(s.pos::numeric, least(999, (
             SELECT min(x.pos) FROM src x, kind k
              WHERE x.pos IS NOT NULL
                AND CASE WHEN k.metric
                         THEN coalesce(s.points, 'Infinity') < coalesce(x.points, 'Infinity')
                         ELSE coalesce(s.points, '-Infinity') > coalesce(x.points, '-Infinity') END
           )) - 0.5, 998.5) AS sort_key
      FROM src s
  ), race_drivers AS (
    SELECT DISTINCT driver FROM api.protocol
     WHERE season = p_season AND division = p_division AND round = p_round AND session = 'race'
  ), duel_drivers AS (
    SELECT DISTINCT driver FROM api.protocol
     WHERE season = p_season AND division = p_division AND round = p_round AND session = 'duel'
  ), qual_pos AS (
    SELECT DISTINCT ON (driver) driver, pos FROM api.protocol
     WHERE season = p_season AND division = p_division AND round = p_round AND session = 'qual'
     ORDER BY driver, pos IS NULL, pos
  ), best AS (
    -- лучшие значения этапа для подсветки (по всему протоколу, не по поиску)
    SELECT min(pos) AS pos_min, max(ql) AS ql_max, max(dr3) AS dr3_max, max(dr4) AS dr4_max,
           max(cau) AS cau_max, max(ret) AS ret_max, max(mn) AS mn_max,
           max(points) AS pts_max, min(points) AS pts_min,
           -- DR1+DR2 — одна группа: подсвечиваются значения не ниже второго по величине
           (SELECT v FROM (SELECT DISTINCT v FROM src, LATERAL (VALUES (dr1), (dr2)) t(v)
                            WHERE v IS NOT NULL ORDER BY v DESC LIMIT 2) z ORDER BY v LIMIT 1) AS dr12_thresh
      FROM src
  ), rows AS (
    SELECT k.*,
           CASE p_view
             WHEN 'qual' THEN CASE WHEN p_round = 1 THEN k.driver IN (SELECT driver FROM duel_drivers)
                                   ELSE k.driver IN (SELECT driver FROM race_drivers) END
             WHEN 'race' THEN NULL
             ELSE k.driver IN (SELECT driver FROM race_drivers)
           END AS made,
           CASE WHEN p_view = 'race' AND k.pos IS NOT NULL AND qp.pos IS NOT NULL
                -- поле квалы бывает больше поля гонки: позиция в квале не дальше последнего стартовавшего
                THEN least(qp.pos, (SELECT n FROM kind)) - k.pos END AS delta,
           array_remove(ARRAY[
             CASE WHEN p_view = 'race' AND k.pos IS NOT NULL AND k.pos = b.pos_min THEN 'Pos.' END,
             CASE WHEN p_view = 'race' AND k.ql IS NOT NULL AND k.ql = b.ql_max THEN 'QL' END,
             CASE WHEN k.dr1 IS NOT NULL AND b.dr12_thresh IS NOT NULL AND k.dr1 >= b.dr12_thresh THEN 'DR1' END,
             CASE WHEN k.dr2 IS NOT NULL AND b.dr12_thresh IS NOT NULL AND k.dr2 >= b.dr12_thresh THEN 'DR2' END,
             CASE WHEN k.dr3 IS NOT NULL AND k.dr3 = b.dr3_max THEN 'DR3' END,
             CASE WHEN k.dr4 IS NOT NULL AND k.dr4 = b.dr4_max THEN 'DR4' END,
             CASE WHEN p_view = 'race' AND k.cau IS NOT NULL AND k.cau = b.cau_max THEN 'CAU' END,
             CASE WHEN p_view = 'race' AND k.ret IS NOT NULL AND k.ret = b.ret_max THEN 'RET' END,
             CASE WHEN p_view = 'race' AND k.mn IS NOT NULL AND k.mn = b.mn_max THEN 'MN' END,
             CASE WHEN k.points IS NOT NULL AND k.points = CASE WHEN (SELECT metric FROM kind) THEN b.pts_min ELSE b.pts_max END
                  THEN 'Points' END
           ], NULL) AS hl
      FROM keyed k CROSS JOIN best b
      LEFT JOIN qual_pos qp ON qp.driver = k.driver
  )
  SELECT json_build_object(
    'metric', (SELECT metric FROM kind),
    'rows', coalesce((SELECT json_agg(json_build_object(
        'Round', r.round_key, 'Pos.', r.pos, '#', r.car, 'Driver', r.driver, 'Team', r.team, 'M.', r.mfr,
        'QL', r.ql, 'DR1', r.dr1, 'DR2', r.dr2, 'DR3', r.dr3, 'DR4', r.dr4,
        'CAU', r.cau, 'RET', r.ret, 'MN', r.mn, 'DUE', r.due, 'Points', r.points,
        'nascar', r.pts, 'made', r.made, 'delta', r.delta, 'hl', r.hl
      ) ORDER BY r.sort_key, r.o) FROM rows r), '[]')
  )
$$;

/* ── Зачёты по состоянию после этапа (вкладка «По этапам»):
   kind: drivers — личный зачёт без Чейза; teams — командный; owners — владельцы
   (с Чейзом после 26 этапа). Плюс место каждого на прошлом этапе (колонка ±). ── */
CREATE FUNCTION api.round_standings(p_season int, p_division text, p_round int, p_kind text)
RETURNS json STABLE LANGUAGE plpgsql AS $$
DECLARE
  prev int;
  cur json;
  prev_st json;
  key text := CASE p_kind WHEN 'teams' THEN 'team' WHEN 'owners' THEN 'car' ELSE 'driver' END;
BEGIN
  SELECT max(round) INTO prev FROM results
   WHERE season = p_season AND division = p_division AND session = 'race'
     AND duel IS NULL AND round <> 0 AND round < p_round;

  IF p_kind = 'teams' THEN
    cur := api.team_standings(p_season, p_division, p_round);
    prev_st := CASE WHEN prev IS NULL THEN '[]' ELSE api.team_standings(p_season, p_division, prev) END;
  ELSIF p_kind = 'owners' THEN
    cur := api.owner_standings(p_season, p_division, p_round);
    prev_st := CASE WHEN prev IS NULL THEN '[]' ELSE api.owner_standings(p_season, p_division, prev) END;
  ELSE
    -- личный зачёт после этапа — регулярный (без сброса Чейза), с пятью лучшими финишами
    SELECT coalesce(json_agg(json_build_object(
             'driver', s.driver, 'team', s.team, 'mfr', s.mfr, 'isGuest', s."isGuest",
             'total', s.total, 'wins', s.wins, 'rank', s.rank,
             'top5', (SELECT coalesce(array_agg(p ORDER BY p), '{}') FROM (
                        SELECT pr.pos AS p FROM api.standing_rows(p_season, p_division, 'race', p_round) pr
                         WHERE pr.driver = s.driver AND pr.pos IS NOT NULL AND pr.duel IS NULL AND pr.round <> 0
                         ORDER BY pr.pos LIMIT 5) t)
           ) ORDER BY s.n), '[]')
      INTO cur
      FROM (SELECT r.*, row_number() OVER () AS n
              FROM api.standings_ranked(p_season, p_division, 'race', p_round) r) s;
    prev_st := CASE WHEN prev IS NULL THEN '[]' ELSE (
      SELECT coalesce(json_agg(json_build_object('driver', driver, 'rank', rank)), '[]')
        FROM api.standings_ranked(p_season, p_division, 'race', prev)) END;
  END IF;

  RETURN json_build_object('rows', cur,
    'prevRank', (SELECT coalesce(json_object_agg(e->>key, (e->>'rank')::int), '{}')
                   FROM json_array_elements(prev_st) e WHERE e->>'rank' IS NOT NULL));
END $$;

/* ── Метрика участников на следующий этап (п. 8.8): стартовый порядок при отмене
   квалификации. 50% — место в гонке этапа (не стартовал — поле + 1), 25% — место в
   чемпионате (гости и не выходившие на старт — последнее + 1; не выходившие с одним
   набором этапов разводятся лучшей квалой), 25% — место машины у владельцев.
   Меньше — лучше; равенство — по месту в чемпионате. ── */
CREATE FUNCTION api.round_metric(p_season int, p_division text, p_round int)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH field AS (
    SELECT coalesce(max(pos), 40) AS n FROM results
     WHERE season = p_season AND division = p_division AND session = 'race' AND round = p_round
  ), champ_st AS (
    SELECT e.value->>'driver' AS driver, (e.value->>'rank')::int AS rank, e.n
      FROM json_array_elements(api.driver_standings(p_season, p_division, 'races', p_round))
           WITH ORDINALITY e(value, n)
  ), base AS (
    SELECT coalesce(max(rank), 0) + 1 AS b FROM champ_st
  ), quals AS (
    -- квалы до этапа включительно (с дуэлями), в порядке протокола
    SELECT r.*, row_number() OVER () AS o FROM api.standing_rows(p_season, p_division, 'qual', p_round) r
  ), no_start AS (
    SELECT q.driver, bool_or(q.is_guest) AS guest,
           array_agg(DISTINCT q.round ORDER BY q.round) AS rounds,
           min(q.pos) AS best, min(q.o) AS first_o
      FROM quals q
     WHERE q.round <> 0 AND q.duel IS NULL
       AND q.driver NOT IN (SELECT driver FROM champ_st WHERE rank IS NOT NULL)
     GROUP BY q.driver
  ), champ AS (
    -- зачётные — своё место; гости — последнее + 1; не выходившие — последнее + 1 и
    -- ещё по одному за каждого соперника с тем же набором этапов и лучшей квалой
    SELECT driver, rank AS champ_rank, n AS ord FROM champ_st WHERE rank IS NOT NULL
    UNION ALL
    SELECT driver, (SELECT b FROM base), 100000 + n FROM champ_st WHERE rank IS NULL
    UNION ALL
    SELECT ns.driver,
           CASE WHEN ns.guest THEN (SELECT b FROM base)
                ELSE (SELECT b FROM base) + (SELECT count(*)::int FROM no_start o
                        WHERE NOT o.guest AND o.rounds = ns.rounds AND coalesce(o.best, 2147483647) < coalesce(ns.best, 2147483647)) END,
           200000 + ns.first_o
      FROM no_start ns
     WHERE ns.driver NOT IN (SELECT driver FROM champ_st)
  ), owners AS (
    SELECT e->>'car' AS car, (e->>'rank')::int AS rank
      FROM json_array_elements(api.owner_standings(p_season, p_division, p_round)) e
  ), all_rows AS (
    -- квалы, потом гонки — из этого порядка берётся «последняя» строка
    SELECT pr.*, 0 AS part, row_number() OVER () AS o
      FROM api.standing_rows(p_season, p_division, 'qual', p_round) pr
    UNION ALL
    SELECT pr.*, 1, row_number() OVER ()
      FROM api.standing_rows(p_season, p_division, 'race', p_round) pr
  ), last_row AS (
    -- машина и команда участника — по его последней строке
    SELECT DISTINCT ON (driver) driver, car, coalesce(nullif(team, '—'), '—') AS team
      FROM all_rows WHERE car IS NOT NULL AND car <> '' AND car <> '-'
     ORDER BY driver, round_key DESC, part DESC, o DESC
  ), last_of_car AS (
    SELECT DISTINCT ON (car) car, driver
      FROM all_rows WHERE car IS NOT NULL AND car <> '' AND car <> '-'
     ORDER BY car, round_key DESC, part DESC, o DESC
  ), pos_of AS (
    SELECT driver, pos FROM api.protocol
     WHERE season = p_season AND division = p_division AND session = 'race'
       AND round = p_round AND pos IS NOT NULL
  ), people AS (
    SELECT c.driver, coalesce(lr.team, '—') AS team, coalesce(lr.car, '—') AS car,
           po.pos, coalesce(po.pos, (SELECT n FROM field) + 1) AS place,
           c.champ_rank,
           coalesce(ow.rank, (SELECT count(*)::int FROM owners) + 1) AS owner_rank,
           CASE WHEN lc.driver IS NOT NULL AND lc.driver <> c.driver THEN lc.driver END AS car_note,
           c.ord
      FROM champ c
      LEFT JOIN last_row lr ON lr.driver = c.driver
      LEFT JOIN pos_of po ON po.driver = c.driver
      LEFT JOIN owners ow ON ow.car = lr.car
      LEFT JOIN last_of_car lc ON lc.car = lr.car
  )
  SELECT json_build_object('field', (SELECT n FROM field), 'rows', coalesce(json_agg(json_build_object(
    'driver', driver, 'team', team, 'car', car, 'pos', pos, 'place', place,
    'champRank', champ_rank, 'ownerRank', owner_rank, 'carNote', car_note,
    'metric', place * 0.5 + champ_rank * 0.25 + owner_rank * 0.25
  ) ORDER BY place * 0.5 + champ_rank * 0.25 + owner_rank * 0.25, champ_rank, ord), '[]'))
    FROM people
$$;

/* ── Карточка пилота: его результаты по этапам. Из нескольких строк на этап — лучшая
   (DQ-строку перебивает реальное место). Дуэли отдельной строкой не показываются —
   их очки идут в Дейтону (этап 1). p_mode = 'quals' — карточка из зачёта квалификаций. ── */
CREATE FUNCTION api.driver_card(p_season int, p_division text, p_driver text, p_mode text DEFAULT 'races')
RETURNS json STABLE LANGUAGE sql AS $$
  WITH rows AS (
    SELECT * FROM api.protocol
     WHERE season = p_season AND division = p_division AND driver = p_driver
  ), best AS (
    SELECT DISTINCT ON (sess, round_key) *
      FROM (SELECT CASE WHEN session = 'race' THEN 'race' ELSE 'qual' END AS sess, * FROM rows) x
     ORDER BY sess, round_key, pos IS NULL, pos, id
  ), metric_rounds AS (
    SELECT round FROM results
     WHERE season = p_season AND division = p_division AND session = 'qual' AND duel IS NULL
     GROUP BY round
    HAVING bool_and(dr1 IS NULL AND dr2 IS NULL AND dr3 IS NULL AND dr4 IS NULL)
  ), rounds AS (
    SELECT DISTINCT round_key FROM best
     WHERE (p_mode = 'quals' AND sess = 'qual') OR (p_mode <> 'quals' AND round_key = floor(round_key))
  )
  SELECT json_build_object(
    'driver', p_driver,
    'rounds', coalesce((SELECT json_agg(json_build_object(
        'round', rd.round_key,
        'qualPos', q.pos, 'qualDQ', q.id IS NOT NULL AND q.pos IS NULL, 'qualPts', q.points,
        'racePos', r.pos, 'raceDQ', r.id IS NOT NULL AND r.pos IS NULL, 'racePts', r.points,
        -- отыграно / потеряно: место в квале минус место в гонке
        'diff', CASE WHEN q.pos IS NOT NULL AND r.pos IS NOT NULL THEN q.pos - r.pos END,
        'metric', rd.round_key IN (SELECT round FROM metric_rounds),
        -- очки в зачёт: гонка (или квала в карточке квал), у Дейтоны — плюс дуэли
        'nascar', CASE WHEN p_mode = 'quals' THEN api.score_pts(q.pos, floor(rd.round_key)::int,
                                                  CASE WHEN rd.round_key <> floor(rd.round_key) THEN 1::smallint END)
                       ELSE api.score_pts(r.pos, rd.round_key::int, NULL)
                            + CASE WHEN rd.round_key = 1 THEN coalesce((
                                SELECT sum(api.score_pts(d.pos, 1, d.duel))::int FROM best d
                                 WHERE d.sess = 'qual' AND d.round_key IN (1.1, 1.2)), 0) ELSE 0 END END
      ) ORDER BY rd.round_key)
      FROM rounds rd
      LEFT JOIN best q ON q.sess = 'qual' AND q.round_key = rd.round_key
      LEFT JOIN best r ON r.sess = 'race' AND r.round_key = rd.round_key), '[]'),
    'history', (api.rank_history(p_season, p_division, CASE WHEN p_mode = 'quals' THEN 'qual' ELSE 'race' END)) -> p_driver
  )
$$;

/* ── Карточка команды: по этапам — зачётные места, кто принёс, очки, место на самом
   этапе (по очкам этапа, равные очки — равное место), итог со штрафом и место в зачёте. ── */
CREATE FUNCTION api.team_card(p_season int, p_division text, p_team text)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH pivot AS (
    SELECT e AS t FROM json_array_elements(api.team_standings(p_season, p_division, 1000, true)) e
     WHERE e->>'team' = p_team
  ), all_teams AS (
    SELECT e->'roundPts' AS rp FROM json_array_elements(api.team_standings(p_season, p_division, 1000)) e
  ), rounds AS (
    SELECT DISTINCT round FROM results
     WHERE season = p_season AND division = p_division AND session = 'race' AND duel IS NULL AND round <> 0
  ), hist AS (
    SELECT api.team_rank_history(p_season, p_division) -> p_team AS h
  ), per AS (
    SELECT rd.round,
           (SELECT t->'roundBest'->(rd.round::text) FROM pivot) AS best,
           ((SELECT t->'roundPts'->>(rd.round::text) FROM pivot))::int AS got
      FROM rounds rd
  )
  SELECT json_build_object(
    'team', (SELECT t FROM pivot),
    'rounds', coalesce((SELECT json_agg(json_build_object(
        'round', p.round, 'best', coalesce(p.best, '[]'), 'pts', coalesce(p.got, 0),
        'rankInRound', CASE WHEN p.got IS NULL THEN NULL ELSE 1 + (
            SELECT count(*)::int FROM all_teams a WHERE coalesce((a.rp->>(p.round::text))::int, -1) > p.got) END,
        -- итог со штрафом: штраф входит со своего этапа
        'total', (SELECT coalesce(sum(p2.got), 0)::int FROM per p2 WHERE p2.round <= p.round)
                 - CASE WHEN (SELECT (t->>'penalty')::int FROM pivot) > 0
                          AND ((SELECT t->>'penaltyRound' FROM pivot) IS NULL
                               OR (SELECT (t->>'penaltyRound')::int FROM pivot) <= p.round)
                        THEN (SELECT (t->>'penalty')::int FROM pivot) ELSE 0 END,
        'rank', (SELECT h->>(p.round::text) FROM hist)::int
      ) ORDER BY p.round) FROM per p), '[]'),
    'history', (SELECT h FROM hist)
  )
$$;

/* ── Сводка сезона для шапки и первой загрузки: числа для шапки, этапы, основной зачёт,
   календарь, признаки этапов и участников, которые таблицы используют при показе. ── */
CREATE FUNCTION api.season_summary(p_season int, p_division text)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH races AS (
    SELECT api.driver_standings(p_season, p_division, 'races',
             (SELECT max(round) FROM results WHERE season = p_season AND division = p_division AND session = 'race')) AS s
  ), quals AS (
    SELECT api.driver_standings(p_season, p_division, 'quals',
             (SELECT max(round) FROM results WHERE season = p_season AND division = p_division AND session = 'qual')) AS s
  ), prot AS (
    SELECT * FROM api.protocol WHERE season = p_season AND division = p_division
  ), metric_rounds AS (
    SELECT round FROM results
     WHERE season = p_season AND division = p_division AND session = 'qual' AND duel IS NULL AND round <> 0
     GROUP BY round
    HAVING bool_and(dr1 IS NULL AND dr2 IS NULL AND dr3 IS NULL AND dr4 IS NULL)
  )
  SELECT json_build_object(
    'season', p_season, 'division', p_division,
    'kpi', json_build_object(
      'numRaces', (SELECT count(DISTINCT round) FROM results WHERE season = p_season AND division = p_division AND session = 'race' AND round <> 0),
      'numQuals', (SELECT count(*) FROM api.qual_rounds(p_season, p_division)),
      'drivers', (SELECT count(DISTINCT driver) FROM prot),
      'teams', (SELECT count(DISTINCT team) FROM prot WHERE session = 'race' AND team IS NOT NULL),
      'leader', (SELECT json_build_object('driver', s->0->>'driver', 'team', s->0->>'team', 'total', (s->0->>'total')::int) FROM races),
      'second', (SELECT json_build_object('driver', s->1->>'driver', 'total', (s->1->>'total')::int) FROM races),
      'gap', (SELECT (s->0->>'total')::int - (s->1->>'total')::int FROM races)),
    'rounds', json_build_object(
      'races', (SELECT json_agg(DISTINCT round ORDER BY round) FROM results
                 WHERE season = p_season AND division = p_division AND session = 'race' AND round <> 0),
      'quals', (SELECT json_agg(DISTINCT round_key ORDER BY round_key) FROM prot
                 WHERE session IN ('qual', 'duel') AND round <> 0)),
    'standings', json_build_object('races', (SELECT s FROM races), 'quals', (SELECT s FROM quals)),
    'protocolRounds', (SELECT json_agg(DISTINCT round ORDER BY round) FROM results
                        WHERE season = p_season AND division = p_division AND session IN ('race', 'qual')),
    'roundNames', (SELECT json_object_agg(trim_scale(round + coalesce(duel, 0) / 10.0)::text,
                     trim_scale(round + coalesce(duel, 0) / 10.0)::text || ' · ' || coalesce(name, ''))
                     FROM rounds WHERE season = p_season),
    'roundAbb', (SELECT json_object_agg(trim_scale(round + coalesce(duel, 0) / 10.0)::text, abbr)
                   FROM rounds WHERE season = p_season AND abbr IS NOT NULL),
    'metricQuals', (SELECT coalesce(json_agg(round ORDER BY round), '[]') FROM metric_rounds),
    'coalitions', (SELECT coalesce(json_agg(name ORDER BY name), '[]') FROM teams WHERE is_coalition),
    'guestByChange', (SELECT coalesce(json_agg(p.name), '[]') FROM division_changes dc
                       JOIN participants p ON p.id = dc.participant_id
                      WHERE dc.season = p_season AND dc.from_division = p_division),
    'deductions', (SELECT coalesce(json_object_agg(t.name, json_build_object(
                     'pts', d.points, 'reason', coalesce(d.reason, ''), 'round', d.round)), '{}')
                     FROM deductions d JOIN teams t ON t.id = d.team_id WHERE d.season = p_season),
    'teamOf', (SELECT coalesce(json_object_agg(driver, team), '{}') FROM api.team_of(p_season, p_division)),
    'roundMaxPos', (SELECT coalesce(json_object_agg(round, mx), '{}') FROM (
                      SELECT round, max(pos) AS mx FROM results
                       WHERE season = p_season AND division = p_division AND session = 'race' AND pos IS NOT NULL
                       GROUP BY round) m),
    'attendance', json_build_object(
      'races', (SELECT coalesce(json_object_agg(driver, r), '{}') FROM (
                  SELECT driver, json_agg(DISTINCT round ORDER BY round) AS r FROM prot
                   WHERE session = 'race' AND round <> 0 GROUP BY driver) a),
      'quals', (SELECT coalesce(json_object_agg(driver, r), '{}') FROM (
                  SELECT driver, json_agg(DISTINCT round ORDER BY round) AS r FROM prot
                   WHERE session = 'qual' AND round <> 0 GROUP BY driver) b)),
    'qualsParticipation', (SELECT coalesce(json_object_agg(driver, r), '{}') FROM (
                  SELECT driver, json_agg(DISTINCT round ORDER BY round) AS r FROM prot
                   WHERE session = 'qual' AND round <> 0 AND NOT is_guest GROUP BY driver) c)
  )
$$;

/* ── Протокол в виде прежнего листа — для калькулятора прогнозов, которому нужны
   сырые строки (ростер пилотов, квалификации). Имя — как составлял фронт:
   «2026 Open Races», «2026 Star Quals», «2026 Calendar», «2026 Changes». ── */
CREATE FUNCTION api.sheet(p_name text)
RETURNS json STABLE LANGUAGE plpgsql AS $$
DECLARE
  m text[];
BEGIN
  m := regexp_match(p_name, '^(\d{4}) (Open|Star) (Races|Quals)$');
  IF m IS NOT NULL THEN
    RETURN (SELECT coalesce(json_agg(json_build_object(
      'Round', round_key, 'Pos.', pos, '#', car, 'Driver', driver, 'Team', team, 'M.', mfr,
      'QL', ql, 'DR1', dr1, 'DR2', dr2, 'DR3', dr3, 'DR4', dr4,
      'CAU', cau, 'RET', ret, 'MN', mn, 'DUE', due, 'Points', points
    ) ORDER BY round, duel NULLS FIRST, pos IS NULL, pos, id), '[]')
      FROM api.protocol
     WHERE season = m[1]::int AND division = lower(m[2])
       AND session = ANY (CASE WHEN m[3] = 'Races' THEN ARRAY['race'] ELSE ARRAY['qual', 'duel'] END));
  END IF;

  m := regexp_match(p_name, '^(\d{4}) Calendar$');
  IF m IS NOT NULL THEN
    RETURN (SELECT coalesce(json_agg(json_build_object(
      '#', round + coalesce(duel, 0) / 10.0, 'Abb.', abbr, 'Name', name) ORDER BY round, duel NULLS FIRST), '[]')
      FROM rounds WHERE season = m[1]::int);
  END IF;

  m := regexp_match(p_name, '^(\d{4}) Changes$');
  IF m IS NOT NULL THEN
    RETURN (SELECT coalesce(json_agg(json_build_object('A', p.name,
      'B', initcap(dc.from_division), 'C', initcap(dc.to_division)) ORDER BY p.name), '[]')
      FROM division_changes dc JOIN participants p ON p.id = dc.participant_id
     WHERE dc.season = m[1]::int);
  END IF;

  RAISE EXCEPTION 'неизвестный лист «%»', p_name;
END $$;

/* ── Зачёт независимых команд: командный зачёт без коалиций, места заново ── */
CREATE FUNCTION api.ind_team_standings(p_season int, p_division text, p_upto numeric DEFAULT 1000)
RETURNS json STABLE LANGUAGE sql AS $$
  WITH t AS (
    SELECT e.value AS v, e.n
      FROM json_array_elements(api.team_standings(p_season, p_division, p_upto)) WITH ORDINALITY e(value, n)
     WHERE e.value->>'team' <> '—'
       AND NOT EXISTS (SELECT 1 FROM teams x WHERE x.name = e.value->>'team' AND x.is_coalition)
  ), r AS (
    SELECT v, n, row_number() OVER (ORDER BY n) AS place FROM t
  )
  SELECT coalesce(json_agg((v::jsonb || jsonb_build_object('rank', place))::json ORDER BY n), '[]') FROM r
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Доступ для сайта (PostgREST). Анонимная роль web_anon может только вызывать
-- функции схемы api — таблиц public она не видит: функции выполняются с правами
-- владельца (SECURITY DEFINER) и фиксированным search_path.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE f record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_anon') THEN
    CREATE ROLE web_anon NOLOGIN;
  END IF;
  FOR f IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'api'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public, api', f.sig);
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO web_anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA api TO web_anon;
-- представление протокола — только через функции, напрямую не отдаём
REVOKE ALL ON api.protocol FROM PUBLIC;
