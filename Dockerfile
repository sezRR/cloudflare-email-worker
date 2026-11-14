FROM node:26-slim

WORKDIR /app

RUN npm install -g pnpm@12.18.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src

# The cursor lives here. Created and owned up front so the named volume mounted over it
# inherits the ownership and the unprivileged user can write to it.
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node

# Node runs the TypeScript sources directly; there is no build step.
CMD ["node", "src/main.ts"]
