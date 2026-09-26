# Static web client for Railway. VITE_DUO_DAEMON_URL (a Railway service
# variable, passed in as a build arg) bakes in the hosted daemon's origin, so
# the app opens on Sign in with Google instead of asking for an address.
# Unset, the app asks for a daemon address on Setup as it always did.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_DUO_DAEMON_URL
ENV VITE_DUO_DAEMON_URL=$VITE_DUO_DAEMON_URL
RUN npx vite build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
