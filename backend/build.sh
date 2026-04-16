#!/bin/bash
echo "Building npx modules for lambda functions"
npx esbuild src/functions/api.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --outfile=dist/api.js \
  --external:pg-native \
  --minify
echo "Processed and Zipping"
cd dist && zip -r ../function.zip api.js
cd ..
echo "Done — function.zip ready to upload"
