#!/bin/sh
# Builds the paste submodule into public/ with our patches applied, then reverts them
# so the submodule stays on its pinned upstream commit.
set -eu
cd "$(dirname "$0")/.."

git -C paste apply ../patches/branding.patch
trap 'git -C paste apply -R ../patches/branding.patch' EXIT

VITE_BYTEBIN_URL=/ pnpm --filter paste exec vite build --outDir ../public --emptyOutDir
