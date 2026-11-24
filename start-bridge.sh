#!/bin/sh
set -e
script_dir=$(dirname -- "$0")
CDPATH= cd -- "$script_dir"

if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' '[Bridge] Node.js is required. Install it and add it to PATH.' >&2
    exit 1
fi

if ! node -e "require('ws'); require.resolve('serialport')" >/dev/null 2>&1; then
    if ! command -v npm >/dev/null 2>&1; then
        printf '%s\n' '[Bridge] npm is required to install the dependencies.' >&2
        exit 1
    fi
    printf '%s\n' '[Bridge] Installing dependencies...'
    npm install --no-save
fi

exec node bridge.js --replace --open
