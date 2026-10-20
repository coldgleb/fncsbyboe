# FNCS by BoE

Статический сайт: данные берутся из Google Sheets и считаются в браузере.

## Docker Compose

```bash
docker compose up -d --build
```

Сайт откроется на http://localhost:12569. Сборка образа прогоняет `test.js` и падает, если тесты не прошли. Сервис подключён к внешней сети `proxy-network` (для reverse proxy).
