#!/bin/bash

# ============================================
# TonShop — Start Script
# Runs the Node.js server and cloudflared tunnel
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        TonShop — Запуск              ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# Check node_modules
if [ ! -d "node_modules" ]; then
  echo -e "${YELLOW}[*] Установка зависимостей...${NC}"
  npm install
fi

# Check cloudflared
if ! command -v cloudflared &> /dev/null; then
  echo -e "${YELLOW}[!] cloudflared не найден. Установка...${NC}"
  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    brew install cloudflare/cloudflare/cloudflared 2>/dev/null || {
      curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz -o /tmp/cf.tgz
      tar -xzf /tmp/cf.tgz -C /usr/local/bin/
    }
  else
    echo "Скачайте cloudflared вручную: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
    exit 1
  fi
fi

# Get port from config
PORT=$(node -e "const c=require('./config.json');console.log(c.site.port||3000)")

# Start Node.js server in background
echo -e "${GREEN}[+] Запуск сервера на порту ${PORT}...${NC}"
node server.js &
SERVER_PID=$!
sleep 2

# Check server started
if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo -e "\033[0;31m[✗] Сервер не запустился!${NC}"
  exit 1
fi

echo -e "${GREEN}[✓] Сервер запущен (PID: ${SERVER_PID})${NC}"

# Start cloudflared tunnel
echo -e "${CYAN}[+] Запуск cloudflared tunnel...${NC}"
echo ""

cloudflared tunnel --url http://localhost:$PORT 2>&1 | while IFS= read -r line; do
  # Find and display the tunnel URL
  if echo "$line" | grep -q "https://.*trycloudflare.com"; then
    URL=$(echo "$line" | grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com')
    if [ -n "$URL" ]; then
      echo ""
      echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
      echo -e "${GREEN}║  🌐 Маркетплейс:  ${URL}${NC}"
      echo -e "${GREEN}║  🔧 Админ-панель:  ${URL}/admin${NC}"
      echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
      echo ""
    fi
  fi
  echo "$line"
done &

TUNNEL_PID=$!

# Trap to cleanup on exit
cleanup() {
  echo ""
  echo -e "${YELLOW}[*] Остановка...${NC}"
  kill $SERVER_PID 2>/dev/null
  kill $TUNNEL_PID 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

echo -e "${YELLOW}[i] Нажмите Ctrl+C для остановки${NC}"
echo ""

# Wait
wait $SERVER_PID
