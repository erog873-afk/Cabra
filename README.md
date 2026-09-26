# ApexLoot — Settings API

Минимальный backend для хранения настроек пользователя (язык, вибрация) в базе данных, привязанной к его Telegram ID — вместо `localStorage` в браузере.

## Что внутри

- `server.js` — Express-сервер с двумя эндпоинтами: `GET /api/settings`, `POST /api/settings`
- `db.js` — SQLite (файл `apexloot.db` создастся сам при первом запуске)
- `verifyInitData.js` — проверка подлинности данных от Telegram Mini App
- `.env.example` — пример настроек

## Установка

```bash
cd apexloot-backend
npm install
cp .env.example .env
```

По умолчанию в `.env` стоит `DEV_MODE=true` — это специальный режим **только для тестирования на своём компьютере**, без реального Telegram. В нём проверка подписи Telegram отключена, и `user_id` можно передавать напрямую.

## Запуск

```bash
npm start
```

Сервер поднимется на `http://localhost:3000`.

## Как протестировать (DEV_MODE=true)

**1. Проверить, что сервер жив:**
```bash
curl http://localhost:3000/health
```

**2. Получить настройки нового пользователя (их ещё нет — вернутся дефолтные):**
```bash
curl "http://localhost:3000/api/settings?user_id=123456789"
```
Ответ:
```json
{"userId":123456789,"language":"ru","vibration":true}
```

**3. Сохранить настройки (например, включить английский и выключить вибрацию):**
```bash
curl -X POST http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"user_id":123456789,"language":"en","vibration":false}'
```

**4. Проверить, что сохранилось:**
```bash
curl "http://localhost:3000/api/settings?user_id=123456789"
```
Ответ:
```json
{"userId":123456789,"language":"en","vibration":false}
```

**5. Проверить другого пользователя** (должны быть дефолтные, независимо от первого):
```bash
curl "http://localhost:3000/api/settings?user_id=999"
```

Все данные лежат в файле `apexloot.db` рядом с сервером — можно открыть любым SQLite-браузером (например, DB Browser for SQLite) и посмотреть таблицу `user_settings` глазами.

## Переход в боевой режим (когда сервер будет на хостинге)

1. В `.env` поставить `BOT_TOKEN=` — реальный токен бота из @BotFather.
2. Поставить `DEV_MODE=false`.
3. Фронтенд (мини-апп) должен слать заголовок `X-Telegram-Init-Data` со значением `Telegram.WebApp.initData` в каждом запросе — сервер сам проверит подпись и достанет `user.id`, отдельно передавать `user_id` больше не нужно.

## Подключение фронтенда (мини-аппа) к этому API

В `index.html` / `index_black_white_lower.html` вместо `localStorage.getItem/setItem` для языка и вибрации нужно будет:

- при открытии страницы — `GET /api/settings` (с заголовком initData) и применить `language`/`vibration` к интерфейсу;
- при клике на пилюлю языка/вибрации — `POST /api/settings` с новыми значениями.

Как только сервер будет выложен на хостинг (Render, Railway, VPS и т.п.) и у вас будет его адрес — скажите, допишу этот код в мини-апп, чтобы он ходил на реальный URL вместо `localhost`.
