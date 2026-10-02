#!/usr/bin/env bash
# Run MiniSync in this terminal (no install). Extra arguments are passed through, e.g. --roms DIR --token SECRET
cd "$(dirname "$0")" && exec python3 companion/minisync.py "$@"
