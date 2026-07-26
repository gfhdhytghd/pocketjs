#!/bin/sh
# Managed by PocketJS Kindle bootstrap. Local edits will be replaced.

set -u
POCKETJS_SYSTEM_PATH="${POCKETJS_SYSTEM_PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
PATH="$POCKETJS_SYSTEM_PATH"
export PATH

POCKETJS_DEV_ROOT="${POCKETJS_DEV_ROOT:-/mnt/us/pocketjs-dev}"
POCKETJS_TMP_ROOT="${POCKETJS_TMP_ROOT:-/var/tmp}"
POCKETJS_PROC_ROOT="${POCKETJS_PROC_ROOT:-/proc}"
POCKETJS_CONTROL_ROOT="${POCKETJS_CONTROL_ROOT:-/var/run/pocketjs}"
POCKETJS_RUNTIME_TERM_WAIT="${POCKETJS_RUNTIME_TERM_WAIT:-15}"
POCKETJS_RUNTIME_KILL_WAIT="${POCKETJS_RUNTIME_KILL_WAIT:-5}"
POCKETJS_UI_RESUME_WAIT="${POCKETJS_UI_RESUME_WAIT:-5}"
POCKETJS_LAUNCH_LOCK_WAIT="${POCKETJS_LAUNCH_LOCK_WAIT:-10}"
POCKETJS_RUNTIME_PID_FILE="$POCKETJS_DEV_ROOT/run/runtime.pid"
POCKETJS_RUNTIME_IDENTITY="$POCKETJS_DEV_ROOT/run/runtime.identity"
POCKETJS_UI_STATE="$POCKETJS_DEV_ROOT/run/runtime-ui-stopped"
POCKETJS_POWERD_STATE="$POCKETJS_DEV_ROOT/run/runtime-powerd-state"
POCKETJS_LAUNCH_LOCK="$POCKETJS_CONTROL_ROOT/runtime-launch.lock"
POCKETJS_STOP_LOCK="$POCKETJS_CONTROL_ROOT/runtime-stop.lock"
pocketjs_launch_lock_owned=0
pocketjs_stop_lock_owned=0

for pocketjs_number in \
    "$POCKETJS_RUNTIME_TERM_WAIT" \
    "$POCKETJS_RUNTIME_KILL_WAIT" \
    "$POCKETJS_UI_RESUME_WAIT" \
    "$POCKETJS_LAUNCH_LOCK_WAIT"; do
    case "$pocketjs_number" in
        ''|*[!0-9]*)
            echo "PocketJS: invalid runtime stop timing value: $pocketjs_number" >&2
            exit 2
            ;;
    esac
done

# The stop path may be followed immediately by a USB Mass Storage export.
# Reexec from tmpfs so this script cannot be the process retaining /mnt/us.
if [ "${POCKETJS_RUNTIME_STOP_REEXEC:-0}" != "1" ]; then
    if [ ! -d "$POCKETJS_TMP_ROOT" ] || [ -L "$POCKETJS_TMP_ROOT" ]; then
        echo "PocketJS: unsafe or missing tmpfs root: $POCKETJS_TMP_ROOT" >&2
        exit 1
    fi
    POCKETJS_RUNTIME_STOP_TMP_DIR="$POCKETJS_TMP_ROOT/pocketjs-stop-runtime.$$"
    if ! (umask 077 && mkdir "$POCKETJS_RUNTIME_STOP_TMP_DIR") 2>/dev/null; then
        echo "PocketJS: could not exclusively create runtime stop tmpfs directory" >&2
        exit 1
    fi
    POCKETJS_RUNTIME_STOP_TMP="$POCKETJS_RUNTIME_STOP_TMP_DIR/stop-runtime.sh"
    if ! cp -p "$0" "$POCKETJS_RUNTIME_STOP_TMP" ||
        ! chmod 700 "$POCKETJS_RUNTIME_STOP_TMP"; then
        rm -f "$POCKETJS_RUNTIME_STOP_TMP"
        rmdir "$POCKETJS_RUNTIME_STOP_TMP_DIR" 2>/dev/null || true
        exit 1
    fi
    export POCKETJS_RUNTIME_STOP_REEXEC=1 POCKETJS_RUNTIME_STOP_TMP
    export POCKETJS_RUNTIME_STOP_TMP_DIR
    cd "$POCKETJS_RUNTIME_STOP_TMP_DIR" || exit 1
    exec sh "$POCKETJS_RUNTIME_STOP_TMP" "$@"
fi

release_owned_lock() {
    pocketjs_release_lock=$1
    [ -d "$pocketjs_release_lock" ] || return 0
    [ "$(sed -n '1p' "$pocketjs_release_lock/owner" 2>/dev/null || true)" = "$$" ] ||
        return 0
    rm -f "$pocketjs_release_lock/owner"
    rmdir "$pocketjs_release_lock" 2>/dev/null || true
}

cleanup_stop() {
    if [ "$pocketjs_launch_lock_owned" -eq 1 ]; then
        release_owned_lock "$POCKETJS_LAUNCH_LOCK"
    fi
    if [ "$pocketjs_stop_lock_owned" -eq 1 ]; then
        release_owned_lock "$POCKETJS_STOP_LOCK"
    fi
    if [ -n "${POCKETJS_RUNTIME_STOP_TMP:-}" ]; then
        rm -f "$POCKETJS_RUNTIME_STOP_TMP"
    fi
    if [ -n "${POCKETJS_RUNTIME_STOP_TMP_DIR:-}" ]; then
        rmdir "$POCKETJS_RUNTIME_STOP_TMP_DIR" 2>/dev/null || true
    fi
}
trap cleanup_stop EXIT

valid_pid() {
    case "${1:-}" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

valid_prevent_screensaver() {
    case "${1:-}" in
        0|1) return 0 ;;
        *) return 1 ;;
    esac
}

read_powerd_prevent_screensaver() {
    lipc-get-prop -i -e -- com.lab126.powerd preventScreenSaver 2>/dev/null |
        sed -n '1p'
}

restore_recorded_powerd() {
    if [ ! -e "$POCKETJS_POWERD_STATE" ] && [ ! -L "$POCKETJS_POWERD_STATE" ]; then
        return 0
    fi
    if [ -L "$POCKETJS_POWERD_STATE" ] || [ ! -f "$POCKETJS_POWERD_STATE" ]; then
        echo "PocketJS: invalid powerd recovery record; keeping it for manual recovery" >&2
        return 1
    fi
    pocketjs_powerd_record=$(sed -n '1p' "$POCKETJS_POWERD_STATE" 2>/dev/null || true)
    if [ "$(sed -n '2p' "$POCKETJS_POWERD_STATE" 2>/dev/null || true)" != "" ]; then
        echo "PocketJS: invalid powerd recovery record; keeping it for manual recovery" >&2
        return 1
    fi
    case "$pocketjs_powerd_record" in
        preventScreenSaver=0|preventScreenSaver=1)
            pocketjs_powerd_original=${pocketjs_powerd_record#*=}
            ;;
        *)
            echo "PocketJS: invalid powerd recovery record; keeping it for manual recovery" >&2
            return 1
            ;;
    esac
    for pocketjs_powerd_tool in lipc-get-prop lipc-set-prop; do
        if ! command -v "$pocketjs_powerd_tool" >/dev/null 2>&1; then
            echo "PocketJS: powerd recovery tool is missing: $pocketjs_powerd_tool" >&2
            return 1
        fi
    done
    pocketjs_powerd_current=$(read_powerd_prevent_screensaver)
    if ! valid_prevent_screensaver "$pocketjs_powerd_current"; then
        echo "PocketJS: could not read preventScreenSaver while restoring powerd" >&2
        return 1
    fi
    if [ "$pocketjs_powerd_current" != "$pocketjs_powerd_original" ]; then
        if ! lipc-set-prop -i -- com.lab126.powerd preventScreenSaver \
            "$pocketjs_powerd_original" >/dev/null 2>&1; then
            echo "PocketJS: could not restore preventScreenSaver=$pocketjs_powerd_original" >&2
            return 1
        fi
    fi
    pocketjs_powerd_readback=$(read_powerd_prevent_screensaver)
    if [ "$pocketjs_powerd_readback" != "$pocketjs_powerd_original" ]; then
        echo "PocketJS: preventScreenSaver restore read-back mismatch (wanted $pocketjs_powerd_original, got ${pocketjs_powerd_readback:-empty})" >&2
        return 1
    fi
    rm -f "$POCKETJS_POWERD_STATE"
    echo "PocketJS: restored preventScreenSaver=$pocketjs_powerd_original"
}

process_starttime() {
    [ -r "$POCKETJS_PROC_ROOT/$1/stat" ] || return 1
    pocketjs_stat=$(sed -n '1p' "$POCKETJS_PROC_ROOT/$1/stat" 2>/dev/null) ||
        return 1
    case "$pocketjs_stat" in
        *") "*) pocketjs_stat_fields=${pocketjs_stat##*) } ;;
        *) return 1 ;;
    esac
    set -- $pocketjs_stat_fields
    [ "$#" -ge 20 ] || return 1
    printf '%s\n' "${20}"
}

process_state() {
    [ -r "$POCKETJS_PROC_ROOT/$1/stat" ] || return 1
    pocketjs_stat=$(sed -n '1p' "$POCKETJS_PROC_ROOT/$1/stat" 2>/dev/null) ||
        return 1
    case "$pocketjs_stat" in
        *") "*) pocketjs_stat_fields=${pocketjs_stat##*) } ;;
        *) return 1 ;;
    esac
    set -- $pocketjs_stat_fields
    [ "$#" -ge 1 ] || return 1
    printf '%s\n' "$1"
}

process_name() {
    [ -r "$POCKETJS_PROC_ROOT/$1/comm" ] || return 1
    sed -n '1p' "$POCKETJS_PROC_ROOT/$1/comm" 2>/dev/null
}

process_executable() {
    [ -L "$POCKETJS_PROC_ROOT/$1/exe" ] || return 1
    readlink "$POCKETJS_PROC_ROOT/$1/exe" 2>/dev/null
}

runtime_process_matches() {
    pocketjs_expected_pid=$1
    pocketjs_expected_start=$2
    pocketjs_expected_binary=$3
    valid_pid "$pocketjs_expected_pid" || return 1
    valid_pid "$pocketjs_expected_start" || return 1
    case "$pocketjs_expected_binary" in
        "$POCKETJS_DEV_ROOT"/*/pocketjs-kindle) ;;
        *) return 1 ;;
    esac
    [ "$(process_starttime "$pocketjs_expected_pid" 2>/dev/null || true)" = "$pocketjs_expected_start" ] ||
        return 1
    pocketjs_actual_binary=$(process_executable "$pocketjs_expected_pid" 2>/dev/null || true)
    case "$pocketjs_actual_binary" in
        "$pocketjs_expected_binary"|"$pocketjs_expected_binary (deleted)"|\
        "$POCKETJS_DEV_ROOT"/*/pocketjs-kindle|\
        "$POCKETJS_DEV_ROOT"/*/pocketjs-kindle\ \(deleted\)) return 0 ;;
        *) return 1 ;;
    esac
}

runtime_binary_matches() {
    pocketjs_candidate_binary=$(process_executable "$1" 2>/dev/null || true)
    case "$pocketjs_candidate_binary" in
        "$POCKETJS_DEV_ROOT"/*/pocketjs-kindle|\
        "$POCKETJS_DEV_ROOT"/*/pocketjs-kindle\ \(deleted\)) return 0 ;;
        *) return 1 ;;
    esac
}

any_pocketjs_runtime() {
    for pocketjs_proc_dir in "$POCKETJS_PROC_ROOT"/[0-9]*; do
        [ -d "$pocketjs_proc_dir" ] || continue
        pocketjs_scan_pid=${pocketjs_proc_dir##*/}
        if runtime_binary_matches "$pocketjs_scan_pid"; then
            return 0
        fi
    done
    return 1
}

ui_process_matches() {
    pocketjs_expected_name=$1
    pocketjs_expected_pid=$2
    pocketjs_expected_starttime=$3
    valid_pid "$pocketjs_expected_pid" || return 1
    [ "$(process_name "$pocketjs_expected_pid" 2>/dev/null || true)" = "$pocketjs_expected_name" ] ||
        return 1
    [ "$(process_starttime "$pocketjs_expected_pid" 2>/dev/null || true)" = "$pocketjs_expected_starttime" ]
}

resume_recorded_ui() {
    [ -f "$POCKETJS_UI_STATE" ] || return 0
    pocketjs_resume_failed=0
    pocketjs_resume_records=0
    while read -r pocketjs_name pocketjs_ui_pid pocketjs_ui_starttime; do
        pocketjs_resume_records=$((pocketjs_resume_records + 1))
        case "$pocketjs_name" in
            KPPMainAppV2|KPPMainApp|awesome) ;;
            *)
                pocketjs_resume_failed=1
                continue
                ;;
        esac
        if ! valid_pid "$pocketjs_ui_pid" ||
            ! valid_pid "$pocketjs_ui_starttime"; then
            pocketjs_resume_failed=1
            continue
        fi
        # A mismatched identity means the originally paused process exited; do
        # not signal a reused PID, but the stale record is resolved.
        ui_process_matches "$pocketjs_name" "$pocketjs_ui_pid" "$pocketjs_ui_starttime" ||
            continue
        pocketjs_state=$(process_state "$pocketjs_ui_pid" 2>/dev/null || true)
        case "$pocketjs_state" in
            T|t)
                if ! kill -CONT "$pocketjs_ui_pid" 2>/dev/null &&
                    ui_process_matches "$pocketjs_name" "$pocketjs_ui_pid" "$pocketjs_ui_starttime"; then
                    pocketjs_resume_failed=1
                    continue
                fi
                pocketjs_resume_wait=0
                while ui_process_matches "$pocketjs_name" "$pocketjs_ui_pid" "$pocketjs_ui_starttime"; do
                    pocketjs_state=$(process_state "$pocketjs_ui_pid" 2>/dev/null || true)
                    case "$pocketjs_state" in
                        T|t) ;;
                        R|S|D|I) break ;;
                        *)
                            pocketjs_resume_failed=1
                            break
                            ;;
                    esac
                    if [ "$pocketjs_resume_wait" -ge "$POCKETJS_UI_RESUME_WAIT" ]; then
                        pocketjs_resume_failed=1
                        break
                    fi
                    sleep 1
                    pocketjs_resume_wait=$((pocketjs_resume_wait + 1))
                done
                ;;
            R|S|D|I) ;;
            *) pocketjs_resume_failed=1 ;;
        esac
    done <"$POCKETJS_UI_STATE"
    if [ "$pocketjs_resume_records" -eq 0 ] || [ "$pocketjs_resume_failed" -ne 0 ]; then
        echo "PocketJS: Kindle UI resume could not be verified; keeping recovery state" >&2
        return 1
    fi
    rm -f "$POCKETJS_UI_STATE"
}

restore_runtime_environment() {
    pocketjs_restore_failed=0
    if ! resume_recorded_ui; then
        pocketjs_restore_failed=1
    fi
    if ! restore_recorded_powerd; then
        pocketjs_restore_failed=1
    fi
    [ "$pocketjs_restore_failed" -eq 0 ]
}

acquire_stop_gate() {
    if ! mkdir "$POCKETJS_STOP_LOCK" 2>/dev/null; then
        pocketjs_lock_owner=$(sed -n '1p' "$POCKETJS_STOP_LOCK/owner" 2>/dev/null || true)
        if valid_pid "$pocketjs_lock_owner" && kill -0 "$pocketjs_lock_owner" 2>/dev/null; then
            echo "PocketJS: another runtime stop operation is active (pid $pocketjs_lock_owner)" >&2
        else
            echo "PocketJS: stale runtime stop lock found; reboot before retrying" >&2
        fi
        return 1
    fi
    if ! printf '%s\n' "$$" >"$POCKETJS_STOP_LOCK/owner" ||
        [ "$(sed -n '1p' "$POCKETJS_STOP_LOCK/owner" 2>/dev/null || true)" != "$$" ]; then
        rm -f "$POCKETJS_STOP_LOCK/owner"
        rmdir "$POCKETJS_STOP_LOCK" 2>/dev/null || true
        return 1
    fi
    pocketjs_stop_lock_owned=1
}

acquire_launch_lock_for_stop() {
    pocketjs_lock_wait=0
    while ! mkdir "$POCKETJS_LAUNCH_LOCK" 2>/dev/null; do
        pocketjs_lock_owner=$(sed -n '1p' "$POCKETJS_LAUNCH_LOCK/owner" 2>/dev/null || true)
        if valid_pid "$pocketjs_lock_owner" && kill -0 "$pocketjs_lock_owner" 2>/dev/null; then
            if [ "$pocketjs_lock_wait" -ge "$POCKETJS_LAUNCH_LOCK_WAIT" ]; then
                echo "PocketJS: runtime launcher did not release its lock; refusing UI recovery" >&2
                return 1
            fi
            sleep 1
            pocketjs_lock_wait=$((pocketjs_lock_wait + 1))
            continue
        fi
        # This stop owns the stop gate, so no conforming new launcher can enter.
        # A dead/invalid launch owner is therefore safe to remove without a
        # competing stale-lock recovery race.
        rm -f "$POCKETJS_LAUNCH_LOCK/owner"
        if ! rmdir "$POCKETJS_LAUNCH_LOCK" 2>/dev/null; then
            echo "PocketJS: could not recover stale runtime launch lock" >&2
            return 1
        fi
    done
    if ! printf '%s\n' "$$" >"$POCKETJS_LAUNCH_LOCK/owner" ||
        [ "$(sed -n '1p' "$POCKETJS_LAUNCH_LOCK/owner" 2>/dev/null || true)" != "$$" ]; then
        rm -f "$POCKETJS_LAUNCH_LOCK/owner"
        rmdir "$POCKETJS_LAUNCH_LOCK" 2>/dev/null || true
        return 1
    fi
    pocketjs_launch_lock_owned=1
}

verify_stopped_generation() {
    pocketjs_generation_pid=$1
    if any_pocketjs_runtime; then
        echo "PocketJS: another PocketJS runtime became active; refusing UI resume" >&2
        return 1
    fi
    if [ -f "$POCKETJS_RUNTIME_PID_FILE" ]; then
        [ "$(sed -n '1p' "$POCKETJS_RUNTIME_PID_FILE" 2>/dev/null || true)" = "$pocketjs_generation_pid" ] ||
            {
                echo "PocketJS: runtime generation changed during stop; refusing cleanup" >&2
                return 1
            }
    fi
    if [ -f "$POCKETJS_RUNTIME_IDENTITY" ]; then
        [ "$(sed -n 's/^pid=//p' "$POCKETJS_RUNTIME_IDENTITY" 2>/dev/null || true)" = "$pocketjs_generation_pid" ] ||
            {
                echo "PocketJS: runtime identity changed during stop; refusing cleanup" >&2
                return 1
            }
    fi
}

umask 077
mkdir -p "$POCKETJS_DEV_ROOT/run" "$POCKETJS_CONTROL_ROOT" || exit 1
chmod 700 "$POCKETJS_CONTROL_ROOT" 2>/dev/null || true
acquire_stop_gate || exit 1

if [ ! -f "$POCKETJS_RUNTIME_PID_FILE" ]; then
    if any_pocketjs_runtime; then
        echo "PocketJS: runtime pid file is missing but a PocketJS runtime is active; refusing UI resume" >&2
        exit 1
    fi
    acquire_launch_lock_for_stop || exit 1
    if any_pocketjs_runtime; then
        echo "PocketJS: a PocketJS runtime appeared during stop; refusing UI resume" >&2
        exit 1
    fi
    echo "PocketJS runtime is not running"
    restore_runtime_environment || exit 1
    exit 0
fi

pocketjs_pid=$(sed -n '1p' "$POCKETJS_RUNTIME_PID_FILE" 2>/dev/null || true)
if ! valid_pid "$pocketjs_pid"; then
    echo "PocketJS: refusing invalid runtime pid file" >&2
    exit 1
fi

pocketjs_expected_pid=$(sed -n 's/^pid=//p' "$POCKETJS_RUNTIME_IDENTITY" 2>/dev/null || true)
pocketjs_expected_start=$(sed -n 's/^starttime=//p' "$POCKETJS_RUNTIME_IDENTITY" 2>/dev/null || true)
pocketjs_expected_binary=$(sed -n 's/^binary=//p' "$POCKETJS_RUNTIME_IDENTITY" 2>/dev/null || true)
if [ "$pocketjs_expected_pid" != "$pocketjs_pid" ] ||
    ! runtime_process_matches "$pocketjs_pid" "$pocketjs_expected_start" "$pocketjs_expected_binary"; then
    if [ ! -d "$POCKETJS_PROC_ROOT/$pocketjs_pid" ]; then
        if any_pocketjs_runtime; then
            echo "PocketJS: recorded runtime exited but another PocketJS runtime is active; refusing UI resume" >&2
            exit 1
        fi
        acquire_launch_lock_for_stop || exit 1
        verify_stopped_generation "$pocketjs_pid" || exit 1
        rm -f "$POCKETJS_RUNTIME_PID_FILE" "$POCKETJS_RUNTIME_IDENTITY"
        restore_runtime_environment || exit 1
        echo "PocketJS runtime was already stopped; stale state cleaned"
        exit 0
    fi
    echo "PocketJS: runtime PID identity mismatch; refusing to signal pid $pocketjs_pid" >&2
    exit 1
fi

echo "Stopping PocketJS runtime (pid $pocketjs_pid)"
kill -TERM "$pocketjs_pid" 2>/dev/null || true
pocketjs_wait=0
while runtime_process_matches "$pocketjs_pid" "$pocketjs_expected_start" "$pocketjs_expected_binary" &&
    [ "$pocketjs_wait" -lt "$POCKETJS_RUNTIME_TERM_WAIT" ]; do
    sleep 1
    pocketjs_wait=$((pocketjs_wait + 1))
done

if runtime_process_matches "$pocketjs_pid" "$pocketjs_expected_start" "$pocketjs_expected_binary"; then
    echo "PocketJS runtime ignored SIGTERM; sending SIGKILL" >&2
    kill -KILL "$pocketjs_pid" 2>/dev/null || true
    pocketjs_wait=0
    while runtime_process_matches "$pocketjs_pid" "$pocketjs_expected_start" "$pocketjs_expected_binary" &&
        [ "$pocketjs_wait" -lt "$POCKETJS_RUNTIME_KILL_WAIT" ]; do
        sleep 1
        pocketjs_wait=$((pocketjs_wait + 1))
    done
fi

if runtime_process_matches "$pocketjs_pid" "$pocketjs_expected_start" "$pocketjs_expected_binary"; then
    echo "PocketJS: runtime survived SIGKILL; keeping identity and UI/power recovery state" >&2
    exit 1
fi

# The stop gate prevents a new launcher from entering while we wait for the old
# launcher to finish its EXIT cleanup. Owning the launch lock then makes the
# final no-runtime check, UI resume, and identity cleanup one generation.
acquire_launch_lock_for_stop || exit 1
verify_stopped_generation "$pocketjs_pid" || exit 1
restore_runtime_environment || exit 1
rm -f "$POCKETJS_RUNTIME_PID_FILE" "$POCKETJS_RUNTIME_IDENTITY"
if [ -x "$POCKETJS_DEV_ROOT/bin/fbink" ]; then
    "$POCKETJS_DEV_ROOT/bin/fbink" -q -f -s >/dev/null 2>&1 || true
fi
echo "PocketJS runtime stopped"
