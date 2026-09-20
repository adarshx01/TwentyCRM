FROM node:22-alpine AS build
WORKDIR /app
COPY apps/outreach/package.json apps/outreach/package-lock.json ./
RUN npm ci
COPY apps/outreach/tsconfig.json apps/outreach/tsconfig.build.json ./
COPY apps/outreach/src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY apps/outreach/package.json apps/outreach/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
USER node
EXPOSE 3100
CMD ["node", "dist/main.js"]
