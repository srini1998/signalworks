FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
WORKDIR /app
COPY server.mjs /app/server.mjs
RUN mkdir -p /srv/sink && chown node:node /srv/sink
USER node
ENV SINK_LOG=/srv/sink/receipts.jsonl
CMD ["node", "/app/server.mjs"]
