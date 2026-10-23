FROM node:24-alpine

# dumb-init is PID 1 so a SIGTERM from the Gladys supervisor reaches node instead
# of being swallowed, and the integration can close its Modbus socket instead of
# leaving the wallbox holding a dead master connection.
RUN apk add --no-cache dumb-init

WORKDIR /app

# npm install --omit=dev resolves the runtime dependencies from package.json,
# which is everything the image needs: the dev dependencies are the lint tools
# and have no place in a container.
COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

ENV NODE_ENV=production

# The rootfs is read-only under the Gladys sandbox, so /data is the only place
# the process may write.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
