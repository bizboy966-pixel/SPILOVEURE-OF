FROM node:20-bullseye AS build
ARG DOMAIN
WORKDIR /src/frontend
COPY frontend/package.json frontend/yarn.lock ./
COPY frontend/scripts ./scripts
RUN yarn install --network-timeout 600000
COPY frontend/ ./
COPY deploy/hostinger/frontend.env ./.env
RUN EXPO_PUBLIC_BACKEND_URL="https://${DOMAIN}" REACT_APP_BACKEND_URL="https://${DOMAIN}" yarn build \
    && grep -R -q "https://${DOMAIN}" build \
    || (echo "Web build is missing its configured backend URL." >&2 && exit 1)
RUN if grep -R -q "preview.emergentagent.com" build; then \
      echo "Web build still references the Emergent preview backend." >&2; exit 1; \
    fi

FROM caddy:2-alpine
COPY deploy/hostinger/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/frontend/build /srv
