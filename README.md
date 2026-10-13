# CHOPEX Panel — نسخه Railway (Node.js)

این پروژه همان پنل Cloudflare Worker اصلی شماست که **بدون هیچ تغییری در کد اصلی** (`worker/panel.js` بایت‌به‌بایت همان فایل آپلودی است) روی محیط Node.js اجرا می‌شود و برای دیپلوی روی Railway آماده شده است.

## چطور کار می‌کند؟

همه قابلیت‌های مخصوص Cloudflare که پنل به آن‌ها وابسته است، با لایه‌های سازگاری (Shim) بازسازی شده‌اند:

| قابلیت Cloudflare | معادل در این نسخه |
|---|---|
| `cloudflare:sockets` (اتصال TCP مستقیم) | `node:net` / `node:tls` — سوکت TCP با پشتیبانی BYOB |
| `WebSocketPair` + پاسخ 101 | کتابخانه `ws` + پچ `Response` |
| `env.DB` (دیتابیس D1) | SQLite داخلی Node 24 (`node:sqlite`) با همان API های `prepare/bind/first/all/run/batch` |
| `caches.default` | کش درون‌حافظه‌ای |
| `ctx.waitUntil` | شبیه‌سازی کامل |
| متغیرهای محیطی (`env.*`) | `process.env` |

**هیچ قابلیتی حذف نشده:** پنل ادمین، ساخت کاربر، اشتراک‌ها (sub/feed)، وضعیت کاربران، VLESS / Trojan / Shadowsocks روی WebSocket، پشتیبانی SOCKS4/SOCKS5/HTTP proxy، چرخش خودکار IP، ریست خودکار حجم/درخواست، محدودیت IP و کانکشن، مسدودسازی پورن/تبلیغات از طریق DNS، قابلیت Auto-Update از طریق Cloudflare API و... همگی فعال‌اند.

## ساختار پروژه

```
├── server.js              ← سرور HTTP/WS و پل Request/Response
├── worker/
│   └── panel.js           ← فایل اصلی و دست‌نخورده پنل (کپی بایت‌به‌بایت)
├── src/
│   ├── loader-hooks.mjs   ← نگاشت cloudflare:sockets به شیم Node
│   └── shims/
│       ├── sockets.mjs    ← سوکت TCP سازگار با Cloudflare
│       ├── globals.mjs    ← WebSocketPair / Response-101 / caches / ctx
│       └── d1.mjs         ← آداپتور D1 روی SQLite
├── package.json
├── railway.json           ← تنظیمات بیلد و اجرای Railway
├── Dockerfile             ← روش جایگزین دیپلوی (اختیاری)
├── Procfile / .nvmrc
└── data/                  ← محل فایل دیتابیس (panel.db) به‌صورت خودکار ساخته می‌شود
```

## دیپلوی روی Railway (روش GitHub)

1. این پوشه را در یک ریپازیتوری GitHub (خصوصی) push کنید.
2. در [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** و ریپو را انتخاب کنید.
3. Railway خودش `package.json` را تشخیص می‌دهد، Node 24 را نصب و `node server.js` را اجرا می‌کند (تنظیمات در `railway.json`).
4. از تب **Settings → Networking → Generate Domain** یک دامنه عمومی بسازید. TLS به‌صورت خودکار فعال است.
5. پنل روی آدرس `https://<دامنه-شما>/panel` در دسترس است. اولین بار صفحه‌ی تعیین رمز نمایش داده می‌شود.

### دیپلوی با Docker (روش جایگزین)
اگر Builder را روی `DOCKERFILE` بگذارید، از `Dockerfile` موجود استفاده می‌شود. با CLI هم می‌توانید مستقیم آپلود کنید:
```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

## ذخیره‌سازی دیتابیس (خیلی مهم)

دیتابیس به‌صورت پیش‌فرض در `data/panel.db` داخل پروژه ساخته می‌شود؛ اما برای اینکه با هر دیپلوی مجدد **داده‌هایتان پاک نشود**:

1. در Railway به سرویس → **Settings → Volumes** بروید و یک Volume با نقطه‌اتصال (Mount Path) زیر بسازید:
   ```
   /data
   ```
2. در تب **Variables** این متغیر را اضافه کنید:
   ```
   DB_PATH=/data/panel.db
   ```

## متغیرهای محیطی (همگی اختیاری)

| متغیر | توضیح |
|---|---|
| `DB_PATH` | مسیر فایل دیتابیس (پیش‌فرض: `data/panel.db` یا داخل Volume) |
| `CF_API_TOKEN` | توکن Cloudflare API — فقط برای نمایش مصرف D1 و قابلیت Auto-Update پنل |
| `CF_ACCOUNT_ID` | شناسه اکانت Cloudflare |
| `WORKER_NAME` | نام اسکریپت برای بخش Auto-Update |
| `PORT` | پورت (Railway خودش تنظیم می‌کند) |
| `HOST` | پیش‌فرض `0.0.0.0` |

> نکته: قابلیت‌هایی که به Cloudflare API وصل می‌شوند (نمایش مصرف D1 و Auto-Update خودکار) فقط وقتی کار می‌کنند که توکن‌های بالا را ست کنید؛ بدون آن‌ها هم بقیه پنل کاملاً کار می‌کند. توجه کنید که Auto-Update اسکریپت را روی **Cloudflare** به‌روزرسانی می‌کند و تأثیری روی همین نسخه Railway ندارد.

## اجرای محلی (برای تست)

```bash
npm install
npm start
# http://localhost:3000/panel
```

## تفاوت‌های محیطی مهم

- **IP کاربران:** در Cloudflare از هدر `CF-Connecting-IP` استفاده می‌شد؛ اینجا همان هدر از `X-Forwarded-For` (که Railway ست می‌کند) پر می‌شود، پس محدودیت IP و آمار کاربران درست کار می‌کند.
- **پورت‌های TLS کانفیگ‌ها:** دامنه Railway روی پورت 443 با TLS سرو می‌شود؛ کانفیگ‌های تولیدشده با پورت‌های 443/2053/2083/2087/2096/8443 برای اتصال TLS و پورت‌های دیگر برای غیر-TLS کار می‌کنند.
- **DNS دامنه:** برای اتصال دامنه اختصاصی، CNAME را به دامنه Railway بدهید.
- **دیتابیس:** SQLite محلی است (همان موتور SQLite که D1 هم استفاده می‌کند)؛ حالت WAL فعال است تا خواندن/نوشتن همزمان مشکلی نداشته باشد.

## به‌روزرسانی کد پنل

اگر بعداً نسخه جدیدی از فایل Worker گرفتید، کافی است آن را جایگزین `worker/panel.js` کنید و دوباره دیپلوی کنید — بدون نیاز به تغییر دیگری.
