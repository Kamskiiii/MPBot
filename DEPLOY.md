# Развёртывание VP Bot на bothost.ru

Чек-лист для нового разработчика: от пустого Discord-приложения до работающего бота.

## 1. Discord-приложение

1. https://discord.com/developers/applications → открыть существующее приложение бота (или создать новое, если нужен отдельный токен — токен уже перевыпущен владельцем).
2. **Bot** → включить:
   - **Server Members Intent** — обязательно (роли, модерация в ветках).
   - **Message Content Intent** — только если ставите `VP_MESSAGE_CONTENT_INTENT=true` (не обязателен для базовой работы бота).
3. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`.
   - Permissions: `Manage Roles`, `Manage Threads`, `Create Private Threads`, `Send Messages`, `Read Message History`, `Embed Links`, `Add Reactions`, `Manage Messages` (для чистки веток).
   - Полученной ссылкой пригласить бота на сервер.
4. Роль бота в Discord должна быть **выше** всех ролей, которые он будет выдавать (position роли бота > любой из `positionRoleIds`/`otherRoleIds`/`leaveActiveRoleId`), иначе `Manage Roles` будет падать молча.

## 2. Настройки проекта: `config.json`

Файл уже есть в репозитории (не секретный, можно коммитить). Заполнить ID-шники реальными значениями с сервера (включить Developer Mode в Discord → ПКМ на канал/роль → Copy ID):

- `guildId` — ID сервера.
- `adminDiscordUserIds` — кто может жать `/setup-panels` и `/setup-training` (плюс любой Administrator на сервере — им можно всегда).
- `welcomeChannelId`, `guestRoleId`, `candidateRoleId`, `welcomePanel*` — приветственная панель.
- `candidateApplicationChannelId`, `candidateApplicationApproverRoleIds`, `candidateApprovalAlwaysRoleIds` — заявки на вступление.
- `positionRoleIds` (+ `positionCategoryRoleId`), `punishmentRoleIds` (+ `punishmentCategoryRoleId`), `otherRoleIds` (+ `otherCategoryRoleId`) — списки ролей для заявок/декоративных ролей.
- `roleRequestChannelId`, `roleRequestApproverRoleIds` — заявки на декоративные роли.
- `leaveRequestChannelId`, `leaveApproverRoleIds`, `leaveNotifyChannelId`, `leaveActiveRoleId` — отпуска.
- `actionsPanelChannelId` — панель с кнопками действий.
- `training.channelId`, `training.instructorRoleId`, `training.panelTitle/panelDescription` — обучение.

Пустая строка/пустой массив = функция выключена, бот просто не публикует эту панель/не принимает эти заявки — ошибок не будет.

## 3. Переменные окружения (`.env`, по образцу `.env.example`)

Обязательно:
- `DISCORD_BOT_TOKEN` — токен бота (уже перевыпущен, вставить новый).

Опционально:
- `VP_MESSAGE_CONTENT_INTENT=true` — если включили Message Content Intent выше.
- `DATA_DIR` — куда класть SQLite (на bothost — путь примонтированного Volume, см. ниже).
- `CONFIG_PATH` — если `config.json` лежит не в корне.
- `DISCORD_PROXY` — если нужен прокси до Discord API.
- `BACKEND_PUBLIC_URL` + `VP_DISCORD_BOT_SECRET` — **только** если включаете интеграцию с VDV (розыск). Секрет тоже перевыпущен — попросить у владельца новое значение, если решите включать. Без обеих переменных бот не делает ни одного запроса в VDV.

На хостинге переменные задаются в панели bothost, а не в файле `.env` (файл — для локальной разработки).

## 4. bothost.ru — создание бота

1. Зарегистрироваться/войти, создать новый проект → тип **Docker** (в репозитории уже есть рабочий `Dockerfile`).
2. Подключить GitHub-репозиторий `Kamskiiii/MPBot`, ветка — `main` (или та, в которую сольёте изменения). Включить авто-деплой при пуше, если доступно на тарифе.
3. **Переменные окружения** — внести из п.3 выше (как минимум `DISCORD_BOT_TOKEN`).
4. **Постоянный диск (Volume) → `/app/data`.** Это критично: SQLite-база (заявки, отпуска, ID сообщений панелей) живёт там. На тарифе **Starter** файлы стираются при каждом перезапуске — заявки будут теряться, а панели переиздаваться дублями при каждом старте. Нужен тариф **Basic** (от 99 ₽/мес) или выше, с постоянным диском, примонтированным именно на `/app/data`.
5. Тарифа Basic (1 GB RAM / 2 vCPU) более чем достаточно — бот лёгкий.
6. Запустить деплой, проверить логи сборки (`npm ci && npm run build`) — должны пройти без ошибок (`better-sqlite3` ставит нативный модуль, в `Dockerfile` для этого уже добавлены `python3 make g++` как резервный вариант, если нет готового бинарника под Alpine).

## 5. Первый запуск и проверка

В логах контейнера должно появиться:
```
Агент ВП авторизован: <имя бота>#0000
```
и (если `guildId` указан) успешная регистрация слеш-команд.

Проверить в Discord:
- `/setup-panels` (от админа) — публикует/обновляет приветствие и панель действий в указанных каналах.
- `/setup-training` — публикует панель обучения.
- Подать тестовую заявку (гость/кандидат/роль/отпуск) через кнопку — проверить, что создаётся приватная ветка и бот реагирует на ✅-реакцию модератора.
- Перезапустить бота (redeploy) и убедиться, что ранее поданные заявки и ID сообщений панелей не потерялись (значит Volume подключён правильно).

## 6. Если включаете VDV (розыск)

- Получить от владельца новый `VP_DISCORD_BOT_SECRET` и `BACKEND_PUBLIC_URL` (адрес бэкенда VDV).
- Добавить обе переменные в окружение на bothost, передеплоить.
- В логах должна появиться строка `Интеграция VDV включена.`
- Настройки розыска (каналы, роли, GIF) в этом режиме приходят с сайта VDV, а не из `config.json`.

## 7. Что дальше по коду

- `npm test` — юнит-тесты логики заявок/отпусков/панелей (не требуют Discord/сети).
- `npm run dev` — локальный запуск с автоперезагрузкой (`tsx watch`).
- Структура: `src/api.ts` — вся бизнес-логика, `src/store.ts` — SQLite, `src/config.ts` — `config.json`, остальное — обработчики конкретных команд/панелей Discord.
