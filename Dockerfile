# StayLeased — demo deployment image.
# The seeded demo world is baked in at BUILD time, so the container boots
# instantly and every restart/redeploy resets to the same pristine world
# (perfect for a public demo; nothing real is ever stored).
FROM node:22-slim

WORKDIR /app

# runtime needs only pdf-lib; skip dev deps (typescript/playwright)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY docs ./docs

# build the deterministic demo world into the image (~60s, faker seed 42)
RUN node --experimental-strip-types --no-warnings src/seed/seed.ts

ENV STAYLEASED_MODE=demo
ENV PORT=3000
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server/main.ts"]
