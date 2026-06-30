#!/bin/bash

# Find and kill any existing process running on port 8000
PID_8000=$(lsof -t -i:8000)
if [ ! -z "$PID_8000" ]; then
    echo "Port 8000 is already in use by process(es): $PID_8000. Terminating..."
    kill -9 $PID_8000 2>/dev/null
fi

echo "Starting Bullseye AI Server on port 8000..."
echo ""
echo "============================================="
echo "🎯 Bullseye AI is now running!"
echo "👉 Web App & API: http://localhost:8000"
echo "============================================="
echo "Press Ctrl+C to stop the server."
echo ""

# Start standard python http server with registered MIME types for WASM/ONNX
python3 -c "import http.server, socketserver; Handler = http.server.SimpleHTTPRequestHandler; Handler.extensions_map.update({'.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.mjs': 'application/javascript'}); socketserver.TCPServer(('', 8000), Handler).serve_forever()"

