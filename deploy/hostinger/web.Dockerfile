FROM node:20-bullseye AS build
WORKDIR /src/frontend
COPY frontend/package.json frontend/yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000
COPY frontend/ ./
COPY deploy/hostinger/frontend.env ./.env
RUN yarn build

FROM caddy:2-alpine
COPY deploy/hostinger/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/frontend/build /srv
