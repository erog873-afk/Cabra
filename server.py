#!/usr/bin/env python3
"""
Мини-сервер для кейсов: хранит конфигурацию в cases.json, чтобы правки из админ-панели
сразу видели ВСЕ пользователи. Только стандартная библиотека Python 3.8+.

Запуск:
    BOT_TOKEN=123:ABC  ADMIN_IDS=111111111,222222222  python3 server.py
    (по умолчанию порт 8080, переменная PORT меняет его)

Эндпоинты:
    GET  /api/cases   -> JSON конфигурации (доступно всем)
    PUT  /api/cases   -> сохранить конфигурацию; нужен заголовок X-Init-Data из Telegram,
                         подпись проверяется по BOT_TOKEN, пользователь должен быть в ADMIN_IDS
Остальные файлы (index.html, admin.html, roulette.html …) отдаются как обычная статика из этой папки.

Если у вас уже есть свой бэкенд (там, где /api/balance и /api/topup/create) — просто добавьте в него
эти два эндпоинта по описанию выше, а в index.html и admin.html задайте window.APEX_API.
"""
import hashlib, hmac, json, os, tempfile, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl

BOT_TOKEN = os.environ.get("BOT_TOKEN", "8239960804:AAHDFegF3O-PmKwf2fh5VU5dDRZFHasBpgg")
ADMIN_IDS = {int(x) for x in os.environ.get("ADMIN_IDS", "8642237301").replace(" ", "").split(",") if x}
PORT = int(os.environ.get("PORT", "8080"))
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cases.json")
MAX_BODY = 8 * 1024 * 1024          # 8 МБ (картинки хранятся внутри)
INITDATA_TTL = 24 * 3600            # initData старше суток не принимаем


def valid_config(c):
    return isinstance(c, dict) and isinstance(c.get("cases"), list) and isinstance(c.get("sections"), list)


def admin_from_init_data(init_data):
    """Возвращает id админа, если подпись Telegram верна и id в ADMIN_IDS, иначе None."""
    if not BOT_TOKEN or not ADMIN_IDS or not init_data:
        return None
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
        got = pairs.pop("hash", "")
        check = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
        secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        calc = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calc, got):
            return None
        if time.time() - int(pairs.get("auth_date", "0")) > INITDATA_TTL:
            return None
        uid = int(json.loads(pairs.get("user", "{}")).get("id", 0))
        return uid if uid in ADMIN_IDS else None
    except Exception:
        return None


def read_config():
    try:
        with open(DATA, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def write_config(c):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(DATA), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(c, f, ensure_ascii=False)
    os.replace(tmp, DATA)           # запись целиком или никак


class Handler(SimpleHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Init-Data")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/cases":
            c = read_config()
            if c is None:
                return self._json(404, {"error": "not configured yet"})   # приложение возьмёт набор по умолчанию
            return self._json(200, c)
        return super().do_GET()

    def do_PUT(self):
        if self.path.split("?")[0] != "/api/cases":
            return self._json(404, {"error": "not found"})
        if admin_from_init_data(self.headers.get("X-Init-Data", "")) is None:
            return self._json(403, {"error": "forbidden: только для администраторов"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0 or n > MAX_BODY:
                return self._json(413, {"error": "bad size"})
            cfg = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return self._json(400, {"error": "bad json"})
        if not valid_config(cfg):
            return self._json(400, {"error": "нужны поля cases и sections"})
        old = read_config()
        cfg["version"] = int((old or {}).get("version", 0)) + 1      # версию ведёт сервер
        cfg["updatedAt"] = int(time.time() * 1000)
        write_config(cfg)
        return self._json(200, {"ok": True, "config": cfg})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    if not BOT_TOKEN or not ADMIN_IDS:
        print("ВНИМАНИЕ: BOT_TOKEN и/или ADMIN_IDS не заданы — сохранять правки не сможет никто.")
    print(f"Сервер: http://0.0.0.0:{PORT}  (админка: /admin.html)")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
