FROM node:20-alpine

# better-sqlite3 needs python and build tools to compile
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy app files
COPY server.js .
COPY index.html .
COPY catalog.css .
COPY app.js .

# Data directory for the SQLite database
VOLUME ["/data"]

EXPOSE 3030

CMD ["node", "server.js"]
