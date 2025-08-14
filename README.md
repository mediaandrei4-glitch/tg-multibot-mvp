# tg-multibot-mvp
Запуск:
1) Создать БД в Supabase и выполнить SQL-схему (bots, subscribers, events, campaigns, campaign_jobs).
2) Деплой на Render → Web Service из этого репозитория.
3) На Render → Settings → Environment:
   - DATABASE_URL = <строка подключения из Supabase>
   - ADMIN_TOKEN = <любой длинный секрет, например my_secret_123>
   - PUBLIC_BASE_URL = https://<ваш-сервис>.onrender.com
4) Redeploy.

Админ-эндпоинты (замените <BASE> и <TOKEN>):
- Добавить бота:
  curl -X POST "<BASE>/admin/bots" -H "Content-Type: application/json" -H "x-admin-token: <TOKEN>" -d '{"token":"123:ABC","username":"mybot","display_name":"My Bot"}'

- Поставить вебхуки всем активным:
  curl -X POST "<BASE>/admin/set-webhooks" -H "x-admin-token: <TOKEN>"

- Создать кампанию (пример фото):
  curl -X POST "<BASE>/admin/campaigns" -H "Content-Type: application/json" -H "x-admin-token: <TOKEN>" -d '{"name":"Promo","bot_id":null,"content":{"type":"photo","photo_url":"https://picsum.photos/600/400","caption":"Hello"}}'

- Запустить кампанию:
  curl -X POST "<BASE>/admin/campaigns/1/run" -H "x-admin-token: <TOKEN>"

- Воркёр (рассылка до 100 сообщений за тик):
  curl -X POST "<BASE>/admin/worker/tick" -H "x-admin-token: <TOKEN>"

- Статистика:
  curl "<BASE>/admin/stats" -H "x-admin-token: <TOKEN>"
