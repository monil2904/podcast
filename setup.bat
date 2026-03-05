@echo off
mkdir "podcast-studio\public" 2>nul
mkdir "podcast-studio\server" 2>nul
copy /y "index.html" "podcast-studio\public\index.html"
copy /y "join.html" "podcast-studio\public\join.html"
copy /y "session.html" "podcast-studio\public\session.html"
copy /y "server_index.js" "podcast-studio\server\index.js"
echo Setup Complete
