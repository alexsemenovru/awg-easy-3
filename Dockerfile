# syntax=docker/dockerfile:1.7
ARG AWG_GO_COMMIT=1b86b2ae0e493e7ea93f8c1a0f0cb6735b1551f1
ARG AWG_TOOLS_COMMIT=ee0f0a9aa34ff0a0da4b3433b9512781cfe02843
FROM --platform=linux/amd64 golang:1.25.12-alpine3.23@sha256:f128118f1f3a7f38949c57f03d29d13e4afdb06b86f840f8f43e8031e6c1a73a AS awg-go
ARG AWG_GO_COMMIT
RUN apk add --no-cache build-base git
RUN git clone --filter=blob:none https://github.com/amnezia-vpn/amneziawg-go.git /src && git -C /src checkout --detach "$AWG_GO_COMMIT" && test "$(git -C /src rev-parse HEAD)" = "$AWG_GO_COMMIT"
WORKDIR /src
RUN go mod download && go mod verify && CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-linkmode external -extldflags "-static" -s -w' -o /out/amneziawg-go .
FROM --platform=linux/amd64 alpine:3.23@sha256:1beb0dc0a51de7ff38e3b5274078a2e0b81113ba5c7535e1a03d5913a5edbda3 AS awg-tools
ARG AWG_TOOLS_COMMIT
RUN apk add --no-cache build-base git linux-headers
RUN git clone --filter=blob:none https://github.com/amnezia-vpn/amneziawg-tools.git /src && git -C /src checkout --detach "$AWG_TOOLS_COMMIT" && test "$(git -C /src rev-parse HEAD)" = "$AWG_TOOLS_COMMIT" && make -C /src/src WITH_SYSTEMDUNITS=no WITH_BASHCOMPLETION=no
RUN install -Dm755 /src/src/wg /out/awg && install -Dm755 /src/src/wg-quick/linux.bash /out/awg-quick
FROM --platform=linux/amd64 node:22.18.0-alpine3.22@sha256:dbb65b3b08bd9d4d4a85299ad4d668b0e709a0601cecb5969f4dbb1dd89408aa AS node-deps
WORKDIR /app
COPY src/package.json src/pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate && pnpm install --prod --frozen-lockfile
FROM --platform=linux/amd64 node:22.18.0-alpine3.22@sha256:dbb65b3b08bd9d4d4a85299ad4d668b0e709a0601cecb5969f4dbb1dd89408aa
ARG AWG_GO_COMMIT
ARG AWG_TOOLS_COMMIT
LABEL org.opencontainers.image.title="AWG-Easy 3" org.opencontainers.image.description="Easy web panel for AmneziaWG 3.x" org.opencontainers.image.source="https://github.com/alexsemenovru/awg-easy-3" org.opencontainers.image.licenses="CC-BY-NC-SA-4.0" org.opencontainers.image.awg-go-revision="$AWG_GO_COMMIT" org.opencontainers.image.awg-tools-revision="$AWG_TOOLS_COMMIT"
RUN apk add --no-cache bash ca-certificates dumb-init iproute2 nftables
COPY --from=awg-go /out/amneziawg-go /usr/local/bin/amneziawg-go
COPY --from=awg-tools /out/awg /usr/local/bin/awg
COPY --from=awg-tools /out/awg-quick /usr/local/bin/awg-quick
RUN ln -s /usr/local/bin/awg /usr/local/bin/wg && ln -s /usr/local/bin/awg-quick /usr/local/bin/wg-quick && printf 'awg-go=%s\nawg-tools=%s\n' "$AWG_GO_COMMIT" "$AWG_TOOLS_COMMIT" > /usr/local/share/awg-build-revisions
WORKDIR /app
COPY src/ ./
COPY --from=node-deps /app/node_modules ./node_modules
ENV NODE_ENV=production AWG_EASY_DATA_DIR=/data AWG_EASY_RUNTIME_DIR=/run/awg-easy-3 WG_QUICK_USERSPACE_IMPLEMENTATION=amneziawg-go
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD awg show awg0 >/dev/null && wget -q -T 3 -O /dev/null http://10.8.0.1:51821/api/v1/session || exit 1
ENTRYPOINT ["/usr/bin/dumb-init", "--", "node", "/app/server.js"]
CMD ["serve"]
