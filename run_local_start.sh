#!/bin/bash

# Create and start postgres container if it doesn't exist
if [ "$(docker ps -aq -f name=postgres-local)" = "" ]; then
  echo "Creating postgres container..."
  docker run --name postgres-local \
    -e POSTGRES_USER=localuser \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e POSTGRES_DB=postgres \
    -p 5432:5432 \
    -d postgres
elif [ "$(docker ps -q -f name=postgres-local)" = "" ]; then
  echo "Starting postgres container..."
  docker start postgres-local
fi

sleep 2
cd backend
npm run local