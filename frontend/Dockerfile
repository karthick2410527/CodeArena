# CodeArena web client: build the static bundle, serve it with nginx.
#
# nginx also proxies /api to the API service, so the browser sees a single
# origin and CORS never enters the picture.

FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Dependencies first so editing the app does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Empty means "call the same origin", which is what the nginx proxy provides.
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=builder /build/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
