# Проверка правил зачётов: сборка падает, если test.js не прошёл
FROM node:24-alpine AS test
WORKDIR /app
COPY test.js ./
COPY js ./js
COPY db ./db
RUN node test.js

# Статика сайта за nginx
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
# BuildKit пропускает стадии, от которых ничего не берут, — эта ссылка заставляет прогнать тесты
COPY --from=test /app/test.js /tmp/.tested
RUN rm /tmp/.tested
COPY index.html calc-help.html favicon.svg /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
