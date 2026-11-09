# A browser that lives inside the test network, driven from the host over Playwright's browser server.
# The viewer instance gets NET_ADMIN so the ladder test can block UDP and TCP ports with iptables, which
# is the only honest way to make "the viewer's network blocks UDP" true (PLAN §9, UDP-blocked viewer).
# Google Chrome (not Playwright's Chromium) because LL-HLS needs H.264 decoding, as in users' browsers.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
RUN apt-get update && apt-get install -y --no-install-recommends iptables && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
RUN npm init -y >/dev/null && npm install playwright@1.64.1 && npx playwright install --with-deps chrome
COPY server.mjs /srv/server.mjs
EXPOSE 3000
CMD ["node", "/srv/server.mjs"]
