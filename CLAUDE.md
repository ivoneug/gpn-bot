# CLAUDE.md

Телеграм-бот, следящий за наличием топлива на АЗС «Газпромнефти». Разбор API — в
[RESEARCH.md](RESEARCH.md), описание настроек — в [README.md](README.md). Здесь только то,
что нужно знать при работе с этим проектом и при деплое.

## Прод: OrangePi

| | |
|---|---|
| Хост | `orangepi@192.168.1.123` (локальная сеть) |
| Система | Ubuntu 24.04.3 LTS, aarch64 (OrangePi 3), ~1 ГБ RAM |
| Docker | 29.1.3, Compose v5.0.1 |
| Каталог | `~/gpn-bot` |
| Контейнер | `gpn-bot`, образ `gpn-bot:latest`, `restart=unless-stopped` |
| Состояние | том `gpn-bot_gpn-bot-data`, внутри — `/app/data/state.json` |
| Бот | `@gpn_Info_bot` |
| Потребление | ~25–65 МБ RAM, ~0% CPU |

**Пароль в репозитории не хранится** — иначе он утёк бы в git. Его даёт пользователь в диалоге;
подставляй через переменную `SSHPASS` (см. ниже) и не записывай ни в файлы, ни в команды.

Ниже `$SCRATCHPAD` — это каталог скратчпада текущей сессии (его путь указан в системном
промпте). Он session-specific и между сессиями исчезает, поэтому обёртку из следующего
раздела каждый раз создавай заново.

### Доступ по SSH: нужна обёртка на expect

Вход только по паролю (ключи не настроены), а `sshpass` на этой macOS **не установлен**.
Зато есть `/usr/bin/expect`. Положи в скратчпад обёртку — она отвечает и на запрос пароля
от `ssh`, и на запрос от `sudo`:

```bash
cat > "$SCRATCHPAD/sshx" <<'EOF'
#!/usr/bin/expect -f
set timeout 900
set pass $env(SSHPASS)
set cmd [lrange $argv 0 end]
log_user 1
spawn -noecho {*}$cmd
expect {
    -re {(?i)are you sure you want to continue connecting} { send "yes\r"; exp_continue }
    -re {(?i)(password|пароль)[^\r\n]*:} { log_user 0; send -- "$pass\r"; log_user 1; exp_continue }
    eof
}
catch wait result
exit [lindex $result 3]
EOF
chmod +x "$SCRATCHPAD/sshx"
```

Regex обязательно в фигурных скобках: в двойных кавычках Tcl примет `[^\r\n]` за подстановку
команды и упадёт с `invalid command name`.

Дальше любая команда оборачивается так:

```bash
export SSHPASS='<пароль от пользователя>'
"$SCRATCHPAD/sshx" ssh -t orangepi@192.168.1.123 'команда'
```

## Деплой обновления

```bash
cd /Users/ivoneug/Development/gpn-bot
COPYFILE_DISABLE=1 tar czf "$SCRATCHPAD/gpn-bot.tgz" \
  --exclude node_modules --exclude .git --exclude data --exclude docs --exclude .DS_Store .
"$SCRATCHPAD/sshx" scp "$SCRATCHPAD/gpn-bot.tgz" orangepi@192.168.1.123:/tmp/gpn-bot.tgz
"$SCRATCHPAD/sshx" ssh -t orangepi@192.168.1.123 'set -e
cd ~/gpn-bot
tar xzf /tmp/gpn-bot.tgz -C ~/gpn-bot && rm -f /tmp/gpn-bot.tgz
find . -name "._*" -delete
chmod 600 .env
sudo docker compose up -d --build'
```

Почему именно так:

- **`tar` + `scp`, а не `rsync`** — системный rsync на macOS древний и не понимает `--info=stats1`
  и часть привычных флагов; проще не связываться.
- **`COPYFILE_DISABLE=1`** — иначе macOS-овский `tar` напихает в архив AppleDouble-файлы `._*`,
  включая `._src`. Страховка `find . -name "._*" -delete` на той стороне всё равно нужна:
  предупреждения `tar: Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'`
  безобидны.
- **`ssh -t`** — без псевдотерминала `sudo` на Pi падает с «no tty present».
- **`chmod 600 .env`** — архив разворачивается с правами 644, а там токен бота.
- `.env` в архив попадает (он не в списке исключений) и перезатирает файл на Pi — следи, чтобы
  локальный `.env` был актуален, иначе задеплоишь свои настройки поверх рабочих.

### Перезапуск без изменения кода

```bash
"$SCRATCHPAD/sshx" ssh -t orangepi@192.168.1.123 'cd ~/gpn-bot && sudo docker compose restart'
```

Чтобы подхватить только правки `.env` — `up -d` (пересоздаст контейнер без пересборки образа):

```bash
"$SCRATCHPAD/sshx" ssh -t orangepi@192.168.1.123 'cd ~/gpn-bot && sudo docker compose up -d'
```

### Проверка после деплоя

```bash
"$SCRATCHPAD/sshx" ssh -t orangepi@192.168.1.123 'cd ~/gpn-bot && sudo docker compose logs --no-color --since 2m | tail -10'
```

Признаки здорового старта:

```
[INFO] Состояние загружено из /app/data/state.json (подписчиков: N)
[INFO] Бот @gpn_Info_bot запущен
[INFO] Отслеживаем АЗС: ... | топливо: ... | опрос раз в 420 с (±10%)
[INFO]   id 885: Краснодар, АЗС №1, Селезнева, 197/2
```

Две важные детали в логах:

- `Состояние загружено` (а не `Файл состояния ... не найден`) — том подключился, подписчики целы.
- Строк `Базовое состояние: АЗС ... = ...` быть **не должно**. Они означают, что состояние
  потерялось и бот заново снимает базовую линию; сразу после этого подписчикам может уйти
  пачка ложных уведомлений.

## Грабли

**`.env` на Pi перекрывает дефолты в коде.** Правка `TRACKED_STATIONS`/`TRACKED_FUELS` в
`src/config.js` или `.env.example` ничего не меняет на проде, пока не обновлён `~/gpn-bot/.env`.
Проверить, что реально отслеживается, можно по строке `Отслеживаем АЗС:` в логах или так:

```bash
"$SCRATCHPAD/sshx" ssh -t orangepi@192.168.1.123 'grep -E "^TRACKED_" ~/gpn-bot/.env'
```

**Docker требует `sudo`.** Пользователь `orangepi` не в группе `docker` (добавлять не стали:
членство в этой группе равносильно root). `sudo` тоже спрашивает пароль — обёртка отвечает и ему.

**При захвате вывода в файл** мусор липнет с обеих сторон: expect отдаёт строки с `\r`
(лечится `| tr -d '\r'`), приглашение `[sudo] password for orangepi:` попадает в stdout,
а в конце ssh дописывает `Connection to ... closed.` — причём **вплотную к последнему символу**,
если вывод не заканчивался переводом строки. Из-за этого `sed -n '/^{/,/^}/p'` для JSON
не спасает: последняя строка станет `}Connection to 192.168.1.123 closed.`. Разбирай
через `raw_decode`, он игнорирует хвост (см. раздел «Чтение состояния»).

**Удалённые команды без `-t`** не смогут выполнить `sudo` вообще — прокидывай `-t` всегда,
даже когда кажется, что tty не нужен.

## Автозапуск

Работает через `systemctl enable docker` (включено; изначально `docker.service` был
`disabled`/`inactive`, то есть после перезагрузки не поднималось ничего) плюс
`restart: unless-stopped` в `docker-compose.yml`.

Проверено перезапуском демона — контейнер поднимается сам и подхватывает том:

```bash
"$SCRATCHPAD/sshx" ssh -t orangepi@192.168.1.123 'sudo systemctl stop docker docker.socket && sudo systemctl start docker && sleep 20 && sudo docker ps --format "{{.Names}} {{.Status}}"'
```

Полной перезагрузкой устройства автозапуск **не проверялся** — владелец отказался. Остаётся
недоказанным только старт самого ядра, его косвенно закрывает флаг `enabled`.

## Чтение состояния

```bash
"$SCRATCHPAD/sshx" ssh -t orangepi@192.168.1.123 'cd ~/gpn-bot && sudo docker compose exec -T gpn-bot cat /app/data/state.json' 2>&1 | tr -d '\r' | python3 -c 'import json,sys; raw=sys.stdin.read(); print(json.dumps(json.JSONDecoder().raw_decode(raw[raw.index("{"):])[0], ensure_ascii=False, indent=1))'
```

`raw_decode` здесь не прихоть: он отрезает и приглашение `sudo` перед JSON, и приписку
ssh после него.

В `state.json` лежат подписчики и последнее известное значение по каждой паре (АЗС, топливо).
Удалять файл без нужды не стоит: после этого бот заново снимает базовую линию.

## Разработка

Тестов в репозитории нет; проверяй логику одноразовыми скриптами в скратчпаде, подсовывая
`fetchStations` фикстуру через подмену `globalThis.fetch` — сам разбор ответа при этом
остаётся настоящим. Живой запрос к API тоже годится, но `gpnbonus.ru` временами
перестаёт отвечать на 20–30 минут, так что не принимай таймаут за поломку кода.

Перед коммитом проверь, что `.env` не попал в индекс (он в `.gitignore`, но токен там живой):

```bash
git diff --cached --name-only | grep -qx '.env' && echo 'ОПАСНОСТЬ' || echo ок
```
