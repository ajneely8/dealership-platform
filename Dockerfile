# Two images from one file:
#   --target web     Next.js dashboard + webhooks
#   --target worker  BullMQ workers + scheduler (includes Chromium for Playwright)
# NOTE: these images were written but not built on the development machine (no Docker there).
# Build them once in your environment before relying on them.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json /app/next.config.ts /app/tsconfig.json /app/drizzle.config.ts ./
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src ./src
USER node
EXPOSE 5310
CMD ["npx", "next", "start", "-p", "5310"]

# The Playwright base image ships the browser and its system libraries. Keep the tag in step
# with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
USER pwuser
CMD ["npx", "tsx", "src/workers/index.ts"]
