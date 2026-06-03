#!/bin/sh
# Generate a self-signed TLS certificate at container startup if one isn't
# present. Runs via nginx's official /docker-entrypoint.d/ hook before nginx
# launches. Set CERT_HOST (IP or hostname) to add it to the cert's SAN so the
# browser warning is cleaner; otherwise just accept the warning once.
set -e

CERT_DIR=/etc/nginx/certs
CRT="$CERT_DIR/server.crt"
KEY="$CERT_DIR/server.key"

mkdir -p "$CERT_DIR"

if [ -f "$CRT" ] && [ -f "$KEY" ]; then
    echo "TLS certificate already present at $CRT"
    exit 0
fi

SAN="DNS:localhost,IP:127.0.0.1"
if [ -n "$CERT_HOST" ]; then
    # Treat a value made only of digits and dots as an IP, otherwise a hostname.
    if echo "$CERT_HOST" | grep -Eq '^[0-9.]+$'; then
        SAN="$SAN,IP:$CERT_HOST"
    else
        SAN="$SAN,DNS:$CERT_HOST"
    fi
fi

echo "Generating self-signed TLS certificate (SAN: $SAN)..."
openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "$KEY" -out "$CRT" \
    -subj "/CN=${CERT_HOST:-localhost}" \
    -addext "subjectAltName=$SAN"

echo "TLS certificate written to $CRT"
