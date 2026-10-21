-- Схема БД проекта (PostgreSQL). Сервер выполняет этот файл при каждом старте — он безопасен для повторного запуска.

-- Пользователи и баланс
CREATE TABLE IF NOT EXISTS ma_users (
  id         BIGINT PRIMARY KEY,                 -- Telegram ID
  name       TEXT NOT NULL DEFAULT '',
  photo      TEXT NOT NULL DEFAULT '',
  stars      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (stars >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ma_users_stars_idx ON ma_users (stars DESC) WHERE stars > 0;  -- таблица лидеров

-- Задания, которые добавляет админ
CREATE TABLE IF NOT EXISTS ma_tasks (
  id         TEXT PRIMARY KEY,
  pos        BIGSERIAL,                          -- порядок показа
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  reward     NUMERIC(10,2) NOT NULL CHECK (reward > 0),
  icon       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Прогресс пользователя по своим заданиям: нажал «Начать» (started_at) / выполнил (done_at)
CREATE TABLE IF NOT EXISTS ma_user_tasks (
  user_id    BIGINT NOT NULL REFERENCES ma_users(id) ON DELETE CASCADE,
  task_id    TEXT   NOT NULL REFERENCES ma_tasks(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, task_id)
);

-- Журнал всех изменений баланса (для разбора споров и будущих игр: ставки, выигрыши, кейсы)
CREATE TABLE IF NOT EXISTS ma_stars_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES ma_users(id) ON DELETE CASCADE,
  delta      NUMERIC(14,2) NOT NULL,
  reason     TEXT NOT NULL,                      -- 'task', 'bet', 'win', 'case' ...
  ref        TEXT,                               -- id задания/игры/кейса
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ma_stars_log_user_idx ON ma_stars_log (user_id, created_at DESC);

-- Служебные значения (например, конец недельного цикла лидеров)
CREATE TABLE IF NOT EXISTS ma_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- События вебхука Linkni (подписался / не подписался / нет спонсоров)
CREATE TABLE IF NOT EXISTS ma_linkni_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  status     TEXT NOT NULL,
  sell_code  TEXT NOT NULL DEFAULT '',
  sub_code   TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ma_linkni_events_user_idx ON ma_linkni_events (user_id, created_at DESC);

-- Последняя награждённая подписка Linkni у человека (чтобы одну и ту же подписку не засчитывать дважды)
CREATE TABLE IF NOT EXISTS ma_linkni_claims (
  user_id BIGINT PRIMARY KEY REFERENCES ma_users(id) ON DELETE CASCADE,
  last_ts TIMESTAMPTZ NOT NULL
);
