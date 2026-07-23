# StayLeased deployment image.
#
# Two ways to run it:
#  - Demo (free tier, no disk): the seeded demo world is baked in at BUILD time
#    below, so the container boots instantly and every restart resets pristine.
#  - Working mode (persistent disk): set STAYLEASED_DB=/data/stayleased.db with
#    a disk mounted at /data. On the first boot the app seeds the demo org onto
#    the disk (~1-2 min; the server starts listening after); every boot after
#    that reuses the same database, so customer signups, imports and payments
#    survive restarts and deploys.
FROM node:22-slim

WORKDIR /app

# runtime needs only pdf-lib; skip dev deps (typescript/playwright)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY docs ./docs

# build the deterministic demo world into the image (~60s, faker seed 42) --
# used only when STAYLEASED_DB is not pointed at a persistent disk
RUN node --experimental-strip-types --no-warnings src/seed/seed.ts

ENV STAYLEASED_MODE=demo
ENV PORT=3000
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server/main.ts"]
