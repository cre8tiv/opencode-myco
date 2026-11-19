#!/usr/bin/env bash
# Installs or updates myco for OpenCode (macOS, Linux). Run it again to update.
#
#   curl -fsSL https://raw.githubusercontent.com/cre8tiv/opencode-myco/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/cre8tiv/opencode-myco/main/install.sh | bash -s -- --ref <tag-or-sha> --models ~/models.json
#
# What it does, and nothing else: it keeps a shallow checkout of the repository in
# ~/.local/share/myco/src (or $MYCO_SRC), moved to --ref (default: main), and runs
# scripts/install.mjs from it. That installs agents, skills and the plugin into OpenCode's config
# directory and leaves your own agents, skills and models.json alone. No sudo, no other files.
#
#   --ref <ref>   a branch, tag or commit to install (default: main). Pin one to install a known version.
#   anything else is passed to the installer: --global (the default here), --project, --target <dir>,
#   --models <file>, --allow-autonomous-merge. See the README.
#
# Needs git and Node.js 22 or newer. MYCO_REPO overrides the repository, for a fork.
set -euo pipefail

REPO="${MYCO_REPO:-https://github.com/cre8tiv/opencode-myco}"
SRC="${MYCO_SRC:-${XDG_DATA_HOME:-$HOME/.local/share}/myco/src}"
REF=main
ARGS=()

die() { echo "myco install: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
    --ref=*) REF="${1#--ref=}"; shift ;;
    -h|--help) sed -n '2,16p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js 22 or newer is required (https://nodejs.org)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"

# Global unless told where: OpenCode finds a project install only where .opencode is committed.
mode=
for a in ${ARGS[@]+"${ARGS[@]}"}; do
  case "$a" in --global|--project|--target) mode=1 ;; esac
done
[ -n "$mode" ] || ARGS+=(--global)

echo "Fetching $REPO ($REF) into $SRC"
mkdir -p "$SRC"
if [ ! -d "$SRC/.git" ]; then
  [ -z "$(ls -A "$SRC")" ] || die "$SRC exists and is not a myco checkout; move it away or set MYCO_SRC"
  git -C "$SRC" init -q
fi
if git -C "$SRC" remote get-url origin >/dev/null 2>&1; then
  git -C "$SRC" remote set-url origin "$REPO"
else
  git -C "$SRC" remote add origin "$REPO"
fi
git -C "$SRC" fetch -q --depth 1 origin "$REF" || die "could not fetch '$REF' from $REPO"
git -C "$SRC" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD \
  || die "could not check out '$REF' in $SRC (local changes there? delete the directory and run again)"
echo "At $(git -C "$SRC" rev-parse --short HEAD)"

echo "Installing: ${ARGS[*]}"
exec node "$SRC/scripts/install.mjs" "${ARGS[@]}"
