#!/usr/bin/env bash
# Reads the fuses of packaged apps and fails if one lets code run outside the app's control:
# RunAsNode or EnableNodeCliInspectArguments enabled. Pass .app bundles or executables.
set -euo pipefail
if [ "$#" -eq 0 ]; then
  echo "usage: $0 <app>..." >&2
  exit 2
fi
status=0
for app in "$@"; do
  echo "== $app"
  # `pnpm dlx` installs into its own directory; `npx` inside the pnpm workspace finds the
  # transitive copy of @electron/fuses but not its bin.
  out=$(pnpm dlx @electron/fuses@1.8.0 read --app "$app")
  echo "$out"
  if ! grep -q 'RunAsNode is ' <<<"$out"; then
    echo "error: could not read the fuses of $app" >&2
    status=1
  elif grep -E '(RunAsNode|EnableNodeCliInspectArguments) is Enabled' <<<"$out" >/dev/null; then
    echo "error: $app has RunAsNode or EnableNodeCliInspectArguments enabled" >&2
    status=1
  fi
done
exit "$status"
