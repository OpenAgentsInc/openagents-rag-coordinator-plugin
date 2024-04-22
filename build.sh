#!/bin/bash
npm i 
export PATH="$PATH:$PWD/tmp/binaryen/bin:$PWD/tmp/extismjs/bin" 

if [ "$EXTISMJS" = "" ];
then
  export EXTISMJS="$PWD/tmp/extismjs/bin/extism-js"
fi

function build {
  d=$PWD
  cd $1
  node esbuild.cjs
  hash="`sha256sum bundle/index.js index.d.ts`"
  if [ ! -f .hash ] || [ "$hash" != "$(cat .hash)" ]; then
    echo "Rebuilding $2"
      RUST_BACKTRACE=1 $EXTISMJS  bundle/index.js -i ./index.d.ts -o $d/$2
      echo "$hash" > .hash
  fi
  cd $d
}

mkdir -p dist
build src/rag dist/rag.wasm

