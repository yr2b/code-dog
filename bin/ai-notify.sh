#!/bin/bash
TITLE="${1:-AI Notification}"
MESSAGE="${2:-Task Completed Successfully!}"
STATUS="${3:-success}"

curl -s -X POST http://localhost:4000/api/notify \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"$TITLE\", \"message\":\"$MESSAGE\", \"status\":\"$STATUS\"}"
