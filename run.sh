#!/bin/bash

# Archery Board - Hybrid Run Script
# Starts both the FastAPI backend and the static frontend server

echo "🏹 Starting Archery Board (Hybrid Mode)..."

# Navigate to script directory
cd "$(dirname "$0")"

# Start the Python FastAPI backend in the background
echo "🚀 Starting FastAPI Backend (Port 8000)..."
cd backend
python3 -m uvicorn src.api.app:app --host 127.0.0.1 --port 8000 --reload &
BACKEND_PID=$!
cd ..

# Start the static frontend server
echo "🌐 Starting Frontend Server (Port 8080)..."
python3 -m http.server 8080 &
FRONTEND_PID=$!

echo ""
echo "✅ Archery Board is running!"
echo "👉 Frontend: http://localhost:8080"
echo "👉 Backend API: http://localhost:8000"
echo ""
echo "Press Ctrl+C to stop both servers."

# Trap Ctrl+C to kill both background processes
trap "echo 'Stopping servers...'; kill $BACKEND_PID; kill $FRONTEND_PID; exit" INT TERM

# Keep script running
wait $BACKEND_PID
wait $FRONTEND_PID
