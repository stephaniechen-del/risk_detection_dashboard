FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && python3 -m venv /opt/venv \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/venv/bin:${PATH}"
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY package*.json ./
RUN npm install --omit=dev

COPY public ./public
COPY scripts ./scripts
COPY server.js package.json README.md ./

RUN mkdir -p /app/data/uploads

EXPOSE 3000

CMD ["npm", "start"]
