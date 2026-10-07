# syntax=docker/dockerfile:1.7
# One image, several process roles (APP_ROLE = api | worker | scheduler | all).
ARG NODE_VERSION=22.20.0

FROM node:${NODE_VERSION}-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache tini wget
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 CMD wget -qO- http://127.0.0.1:${APP_PORT:-3000}/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
