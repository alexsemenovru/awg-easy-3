FROM awg-easy-3:dev-20260925
COPY pride-panels.css /app/www/css/pride-panels.css
COPY patch-index.sh /tmp/patch-index.sh
RUN sh /tmp/patch-index.sh /app/www/index.html && rm /tmp/patch-index.sh
