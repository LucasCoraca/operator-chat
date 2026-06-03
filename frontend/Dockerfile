# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM nginx:alpine

# openssl is needed to generate the self-signed TLS cert at startup
RUN apk add --no-cache openssl

# Copy nginx configuration (server blocks + shared location include)
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY app-locations.conf /etc/nginx/app-locations.conf

# Self-signed cert generator, run by nginx's entrypoint before startup
COPY 40-generate-cert.sh /docker-entrypoint.d/40-generate-cert.sh
RUN chmod +x /docker-entrypoint.d/40-generate-cert.sh

# Copy built application from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose HTTP and HTTPS ports
EXPOSE 80 443

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:80/health || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]