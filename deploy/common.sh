# Shared helpers for deploy/backup, deploy/deploy, deploy/health and deploy/rollback. Sourced, not executed.
# Never prints runtime.env contents: only the single LINKO_DATA_DIR path is read from it.
umask 077

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

DEPLOY_ROOT="${LINKO_DEPLOY_ROOT:-$HOME/.local/share/linko-mymarketer}"
RELEASES_DIR="${DEPLOY_RELEASES_DIR:-$DEPLOY_ROOT/releases}"
CURRENT_LINK="$RELEASES_DIR/current"
SERVICE_NAME="${DEPLOY_SERVICE:-linko-mymarketer.service}"
UNIT_DIR="${DEPLOY_UNIT_DIR:-$HOME/.config/systemd/user}"
UNIT_PATH="$UNIT_DIR/$SERVICE_NAME"
ENV_FILE="${DEPLOY_ENV_FILE:-$HOME/.config/linko-mymarketer/runtime.env}"
RELEASE_ID_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'

# A stable default connects separate backup and rollback invocations in the serialized queue.
DEPLOY_BACKUP_DIR="${DEPLOY_BACKUP_DIR-$DEPLOY_ROOT/backups/pre-deploy}"
systemctl_user() { timeout "${DEPLOY_SYSTEMCTL_TIMEOUT_SECONDS:-60}" systemctl --user "$@"; }

# The private data directory: explicit override, else LINKO_DATA_DIR from the runtime environment file, else the default.
data_dir() {
  if [ -n "${DEPLOY_DATA_DIR:-}" ]; then printf '%s\n' "$DEPLOY_DATA_DIR"; return; fi
  local value=""
  if [ -r "$ENV_FILE" ]; then
    value="$(grep -E '^LINKO_DATA_DIR=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  fi
  printf '%s\n' "${value:-$DEPLOY_ROOT/private}"
}

# The release the service is serving now: the `current` symlink, else the legacy pinned WorkingDirectory in the installed unit.
active_release() {
  if [ -L "$CURRENT_LINK" ]; then basename "$(readlink "$CURRENT_LINK")"; return; fi
  if [ -r "$UNIT_PATH" ]; then
    local dir
    dir="$(sed -n 's/^WorkingDirectory=//p' "$UNIT_PATH" | head -n 1)"
    case "$dir" in
      */releases/current/app) ;;
      */releases/*/app) dir="${dir%/app}"; printf '%s\n' "${dir##*/}"; return ;;
    esac
  fi
  printf '\n'
}

# Atomically repoint releases/current at a release directory name.
switch_current() {
  local id="$1" tmp="$RELEASES_DIR/.current.$$"
  [[ "$id" =~ $RELEASE_ID_PATTERN ]] || die "invalid release id"
  [ -d "$RELEASES_DIR/$id/app" ] || die "release $id has no app directory"
  if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then die "$CURRENT_LINK exists and is not a symlink"; fi
  rm -f "$tmp"
  ln -s "$id" "$tmp"
  mv -T "$tmp" "$CURRENT_LINK"
}

# Read one key from a key=value record without sourcing it.
record_value() { grep -E "^$2=" "$1" | head -n 1 | cut -d= -f2- || true; }
