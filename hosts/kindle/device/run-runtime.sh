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
POCKETJS_UI_RESUME_WAIT="${POCKETJS_UI_RESUME_WAIT:-5}"
POCKETJS_RUNTIME="${POCKETJS_RUNTIME_BIN:-$POCKETJS_DEV_ROOT/bin/pocketjs-kindle}"
POCKETJS_RUNTIME_PID_FILE="$POCKETJS_DEV_ROOT/run/runtime.pid"
POCKETJS_LAUNCHER_PID_FILE="$POCKETJS_DEV_ROOT/run/runtime-launcher.pid"
POCKETJS_RUNTIME_IDENTITY="$POCKETJS_DEV_ROOT/run/runtime.identity"
POCKETJS_UI_STATE="$POCKETJS_DEV_ROOT/run/runtime-ui-stopped"
POCKETJS_POWERD_STATE="$POCKETJS_DEV_ROOT/run/runtime-powerd-state"
POCKETJS_RUNTIME_LOG="$POCKETJS_DEV_ROOT/logs/runtime.log"
POCKETJS_LAUNCH_LOCK="$POCKETJS_CONTROL_ROOT/runtime-launch.lock"
POCKETJS_STOP_LOCK="$POCKETJS_CONTROL_ROOT/runtime-stop.lock"
POCKETJS_EXPORT_LOCK="$POCKETJS_CONTROL_ROOT/userstore-export.lock"
POCKETJS_RUNTIME_PID=

case "$POCKETJS_UI_RESUME_WAIT" in
    ''|*[!0-9]*)
        echo "PocketJS: invalid UI resume wait: $POCKETJS_UI_RESUME_WAIT" >&2
        exit 2
        ;;
esac

# Run the long-lived shell from tmpfs. Deploys may atomically replace files on
# /mnt/us while this launcher is waiting, and vfat/FUSE must not invalidate the
# trap/cleanup code that restores the Kindle UI.
if [ "${POCKETJS_RUNTIME_LAUNCHER_REEXEC:-0}" != "1" ]; then
    if [ ! -d "$POCKETJS_TMP_ROOT" ] || [ -L "$POCKETJS_TMP_ROOT" ]; then
        echo "PocketJS: unsafe or missing tmpfs root: $POCKETJS_TMP_ROOT" >&2
        exit 1
    fi
    POCKETJS_RUNTIME_LAUNCHER_TMP_DIR="$POCKETJS_TMP_ROOT/pocketjs-run-runtime.$$"
    if ! (umask 077 && mkdir "$POCKETJS_RUNTIME_LAUNCHER_TMP_DIR") 2>/dev/null; then
        echo "PocketJS: could not exclusively create runtime tmpfs directory" >&2
        exit 1
    fi
    POCKETJS_RUNTIME_LAUNCHER_TMP="$POCKETJS_RUNTIME_LAUNCHER_TMP_DIR/run-runtime.sh"
    if ! cp -p "$0" "$POCKETJS_RUNTIME_LAUNCHER_TMP" ||
        ! chmod 700 "$POCKETJS_RUNTIME_LAUNCHER_TMP"; then
        rm -f "$POCKETJS_RUNTIME_LAUNCHER_TMP"
        rmdir "$POCKETJS_RUNTIME_LAUNCHER_TMP_DIR" 2>/dev/null || true
        exit 1
    fi
    export POCKETJS_RUNTIME_LAUNCHER_REEXEC=1
    export POCKETJS_RUNTIME_LAUNCHER_TMP POCKETJS_RUNTIME_LAUNCHER_TMP_DIR
    cd "$POCKETJS_RUNTIME_LAUNCHER_TMP_DIR" || exit 1
    exec sh "$POCKETJS_RUNTIME_LAUNCHER_TMP" "$@"
fi

umask 077
mkdir -p "$POCKETJS_DEV_ROOT/run" "$POCKETJS_DEV_ROOT/logs" \
    "$POCKETJS_CONTROL_ROOT" || exit 1
chmod 700 "$POCKETJS_CONTROL_ROOT" 2>/dev/null || true

cleanup_launcher_tmp() {
    if [ -n "${POCKETJS_RUNTIME_LAUNCHER_TMP:-}" ]; then
        rm -f "$POCKETJS_RUNTIME_LAUNCHER_TMP"
    fi
    if [ -n "${POCKETJS_RUNTIME_LAUNCHER_TMP_DIR:-}" ]; then
        rmdir "$POCKETJS_RUNTIME_LAUNCHER_TMP_DIR" 2>/dev/null || true
    fi
}
trap cleanup_launcher_tmp EXIT

log() {
    echo "[$(date 2>/dev/null || echo unknown-time)] $*"
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

read_powerd_mode() {
    lipc-get-prop -e -- com.lab126.powerd state 2>/dev/null |
        sed -n '1p'
}

persist_powerd_original() {
    pocketjs_powerd_original=$1
    pocketjs_powerd_record="preventScreenSaver=$pocketjs_powerd_original"
    pocketjs_powerd_tmp="$POCKETJS_POWERD_STATE.tmp.$$"

    rm -f "$pocketjs_powerd_tmp"
    if ! (
        umask 077
        printf '%s\n' "$pocketjs_powerd_record" >"$pocketjs_powerd_tmp"
    ); then
        rm -f "$pocketjs_powerd_tmp"
        return 1
    fi
    if [ "$(sed -n '1p' "$pocketjs_powerd_tmp" 2>/dev/null || true)" != "$pocketjs_powerd_record" ] ||
        [ "$(sed -n '2p' "$pocketjs_powerd_tmp" 2>/dev/null || true)" != "" ]; then
        rm -f "$pocketjs_powerd_tmp"
        return 1
    fi
    if ! mv -f "$pocketjs_powerd_tmp" "$POCKETJS_POWERD_STATE"; then
        rm -f "$pocketjs_powerd_tmp"
        return 1
    fi
    # The recovery record must survive before powerd is changed. A killed
    # launcher can then be repaired by stop-runtime without guessing the
    # user's original screensaver preference.
    if ! sync >/dev/null 2>&1 ||
        [ "$(sed -n '1p' "$POCKETJS_POWERD_STATE" 2>/dev/null || true)" != "$pocketjs_powerd_record" ] ||
        [ "$(sed -n '2p' "$POCKETJS_POWERD_STATE" 2>/dev/null || true)" != "" ]; then
        return 1
    fi
}

restore_recorded_powerd() {
    if [ ! -e "$POCKETJS_POWERD_STATE" ] && [ ! -L "$POCKETJS_POWERD_STATE" ]; then
        return 0
    fi
    if [ -L "$POCKETJS_POWERD_STATE" ] || [ ! -f "$POCKETJS_POWERD_STATE" ]; then
        log "invalid powerd recovery record; keeping it for manual recovery"
        return 1
    fi
    pocketjs_powerd_record=$(sed -n '1p' "$POCKETJS_POWERD_STATE" 2>/dev/null || true)
    if [ "$(sed -n '2p' "$POCKETJS_POWERD_STATE" 2>/dev/null || true)" != "" ]; then
        log "invalid powerd recovery record; keeping it for manual recovery"
        return 1
    fi
    case "$pocketjs_powerd_record" in
        preventScreenSaver=0|preventScreenSaver=1)
            pocketjs_powerd_original=${pocketjs_powerd_record#*=}
            ;;
        *)
            log "invalid powerd recovery record; keeping it for manual recovery"
            return 1
            ;;
    esac
    for pocketjs_powerd_tool in lipc-get-prop lipc-set-prop; do
        if ! command -v "$pocketjs_powerd_tool" >/dev/null 2>&1; then
            log "powerd recovery tool is missing: $pocketjs_powerd_tool"
            return 1
        fi
    done
    pocketjs_powerd_current=$(read_powerd_prevent_screensaver)
    if ! valid_prevent_screensaver "$pocketjs_powerd_current"; then
        log "could not read preventScreenSaver while restoring powerd"
        return 1
    fi
    if [ "$pocketjs_powerd_current" != "$pocketjs_powerd_original" ]; then
        if ! lipc-set-prop -i -- com.lab126.powerd preventScreenSaver \
            "$pocketjs_powerd_original" >/dev/null 2>&1; then
            log "could not restore preventScreenSaver=$pocketjs_powerd_original"
            return 1
        fi
    fi
    pocketjs_powerd_readback=$(read_powerd_prevent_screensaver)
    if [ "$pocketjs_powerd_readback" != "$pocketjs_powerd_original" ]; then
        log "preventScreenSaver restore read-back mismatch (wanted $pocketjs_powerd_original, got ${pocketjs_powerd_readback:-empty})"
        return 1
    fi
    rm -f "$POCKETJS_POWERD_STATE"
    log "restored preventScreenSaver=$pocketjs_powerd_original"
}

prevent_screensaver_for_runtime() {
    for pocketjs_powerd_tool in lipc-get-prop lipc-set-prop; do
        if ! command -v "$pocketjs_powerd_tool" >/dev/null 2>&1; then
            log "firmware powerd tool is missing: $pocketjs_powerd_tool"
            return 1
        fi
    done
    if ! restore_recorded_powerd; then
        log "could not recover an earlier preventScreenSaver override"
        return 1
    fi

    pocketjs_powerd_original=$(read_powerd_prevent_screensaver)
    if ! valid_prevent_screensaver "$pocketjs_powerd_original"; then
        log "could not read the original preventScreenSaver value"
        return 1
    fi
    if ! persist_powerd_original "$pocketjs_powerd_original"; then
        log "could not durably record preventScreenSaver=$pocketjs_powerd_original"
        return 1
    fi

    pocketjs_powerd_mode=$(read_powerd_mode)
    case "$pocketjs_powerd_mode" in
        active) ;;
        screenSaver)
            log "Kindle is already in screenSaver state; wake it with the physical power button before starting PocketJS"
            restore_recorded_powerd || true
            return 1
            ;;
        suspended)
            log "Kindle is suspended; wake it with the physical power button before starting PocketJS"
            restore_recorded_powerd || true
            return 1
            ;;
        *)
            log "Kindle powerd is not active (state ${pocketjs_powerd_mode:-empty}); refusing to start"
            restore_recorded_powerd || true
            return 1
            ;;
    esac

    if ! lipc-set-prop -i -- com.lab126.powerd preventScreenSaver 1 \
        >/dev/null 2>&1; then
        log "powerd rejected preventScreenSaver=1"
        restore_recorded_powerd || true
        return 1
    fi
    pocketjs_powerd_readback=$(read_powerd_prevent_screensaver)
    if [ "$pocketjs_powerd_readback" != "1" ]; then
        log "preventScreenSaver read-back mismatch (wanted 1, got ${pocketjs_powerd_readback:-empty})"
        restore_recorded_powerd || true
        return 1
    fi

    # Close the race where powerd entered the screensaver between the first
    # state read and the verified preventScreenSaver write. This lifecycle
    # never synthesizes powerButton: a sleeping Kindle requires its user.
    pocketjs_powerd_mode=$(read_powerd_mode)
    case "$pocketjs_powerd_mode" in
        active) ;;
        screenSaver)
            log "Kindle entered screenSaver during startup; wake it with the physical power button before retrying"
            restore_recorded_powerd || true
            return 1
            ;;
        suspended)
            log "Kindle entered suspended state during startup; wake it with the physical power button before retrying"
            restore_recorded_powerd || true
            return 1
            ;;
        *)
            log "Kindle powerd did not remain active (state ${pocketjs_powerd_mode:-empty}); refusing to start"
            restore_recorded_powerd || true
            return 1
            ;;
    esac
    log "preventScreenSaver=1 confirmed (original $pocketjs_powerd_original)"
}

valid_pid() {
    case "${1:-}" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

process_state() {
    [ -r "$POCKETJS_PROC_ROOT/$1/stat" ] || return 1
    pocketjs_stat=$(sed -n '1p' "$POCKETJS_PROC_ROOT/$1/stat" 2>/dev/null) || return 1
    case "$pocketjs_stat" in
        *") "*) pocketjs_stat_fields=${pocketjs_stat##*) } ;;
        *) return 1 ;;
    esac
    set -- $pocketjs_stat_fields
    [ "$#" -ge 1 ] || return 1
    printf '%s\n' "$1"
}

process_starttime() {
    [ -r "$POCKETJS_PROC_ROOT/$1/stat" ] || return 1
    pocketjs_stat=$(sed -n '1p' "$POCKETJS_PROC_ROOT/$1/stat" 2>/dev/null) || return 1
    case "$pocketjs_stat" in
        *") "*) pocketjs_stat_fields=${pocketjs_stat##*) } ;;
        *) return 1 ;;
    esac
    set -- $pocketjs_stat_fields
    [ "$#" -ge 20 ] || return 1
    printf '%s\n' "${20}"
}

process_name() {
    [ -r "$POCKETJS_PROC_ROOT/$1/comm" ] || return 1
    sed -n '1p' "$POCKETJS_PROC_ROOT/$1/comm" 2>/dev/null
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

persist_ui_identity() {
    pocketjs_identity_name=$1
    pocketjs_identity_pid=$2
    pocketjs_identity_starttime=$3
    pocketjs_identity_record="$pocketjs_identity_name $pocketjs_identity_pid $pocketjs_identity_starttime"
    pocketjs_identity_tmp="$POCKETJS_UI_STATE.tmp.$$"

    rm -f "$pocketjs_identity_tmp"
    if ! (
        umask 077
        printf '%s\n' "$pocketjs_identity_record" >"$pocketjs_identity_tmp"
    ); then
        rm -f "$pocketjs_identity_tmp"
        return 1
    fi
    if [ "$(sed -n '1p' "$pocketjs_identity_tmp" 2>/dev/null || true)" != "$pocketjs_identity_record" ] ||
        [ "$(sed -n '2p' "$pocketjs_identity_tmp" 2>/dev/null || true)" != "" ]; then
        rm -f "$pocketjs_identity_tmp"
        return 1
    fi
    if ! mv -f "$pocketjs_identity_tmp" "$POCKETJS_UI_STATE"; then
        rm -f "$pocketjs_identity_tmp"
        return 1
    fi
    # The state lives on /mnt/us. Flush and read it back before stopping the UI
    # so a sudden launcher death can never leave an unrecorded stopped process.
    if ! sync >/dev/null 2>&1 ||
        [ "$(sed -n '1p' "$POCKETJS_UI_STATE" 2>/dev/null || true)" != "$pocketjs_identity_record" ] ||
        [ "$(sed -n '2p' "$POCKETJS_UI_STATE" 2>/dev/null || true)" != "" ]; then
        return 1
    fi
}

resume_recorded_ui() {
    [ -f "$POCKETJS_UI_STATE" ] || return 0
    pocketjs_resume_failed=0
    pocketjs_resume_records=0
    while read -r pocketjs_name pocketjs_pid pocketjs_starttime; do
        pocketjs_resume_records=$((pocketjs_resume_records + 1))
        case "$pocketjs_name" in
            KPPMainAppV2|KPPMainApp|awesome) ;;
            *)
                pocketjs_resume_failed=1
                continue
                ;;
        esac
        if ! valid_pid "$pocketjs_pid" || ! valid_pid "$pocketjs_starttime"; then
            pocketjs_resume_failed=1
            continue
        fi
        # A mismatched identity means the process we paused has exited. Never
        # signal a reused PID; the stale recovery record is resolved.
        ui_process_matches "$pocketjs_name" "$pocketjs_pid" "$pocketjs_starttime" || continue
        pocketjs_state=$(process_state "$pocketjs_pid" 2>/dev/null || true)
        case "$pocketjs_state" in
            T|t)
                log "resuming Kindle UI process $pocketjs_name ($pocketjs_pid)"
                if ! kill -CONT "$pocketjs_pid" 2>/dev/null &&
                    ui_process_matches "$pocketjs_name" "$pocketjs_pid" "$pocketjs_starttime"; then
                    pocketjs_resume_failed=1
                    continue
                fi
                pocketjs_resume_wait=0
                while ui_process_matches "$pocketjs_name" "$pocketjs_pid" "$pocketjs_starttime"; do
                    pocketjs_state=$(process_state "$pocketjs_pid" 2>/dev/null || true)
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
        log "Kindle UI resume could not be verified; keeping recovery state"
        return 1
    fi
    rm -f "$POCKETJS_UI_STATE"
}

pause_kindle_ui() {
    # Recover a state file left by a launcher that was SIGKILLed. We only
    # resume whitelisted processes whose PID still has the recorded identity
    # and is actually stopped.
    if ! resume_recorded_ui; then
        log "could not recover a previously paused Kindle UI"
        return 1
    fi
    rm -f "$POCKETJS_UI_STATE.tmp.$$"

    for pocketjs_name in KPPMainAppV2 KPPMainApp awesome; do
        for pocketjs_pid in $(pidof "$pocketjs_name" 2>/dev/null || true); do
            valid_pid "$pocketjs_pid" || continue
            [ "$(process_name "$pocketjs_pid" 2>/dev/null || true)" = "$pocketjs_name" ] || continue
            pocketjs_starttime=$(process_starttime "$pocketjs_pid" 2>/dev/null || true)
            valid_pid "$pocketjs_starttime" || continue
            pocketjs_state=$(process_state "$pocketjs_pid" 2>/dev/null || true)
            case "$pocketjs_state" in
                T|t)
                    log "Kindle UI process $pocketjs_name ($pocketjs_pid) was already stopped; leaving it alone"
                    continue
                    ;;
            esac

            # Persist one complete identity with atomic rename, sync, and
            # read-back verification before issuing SIGSTOP.
            if ! persist_ui_identity "$pocketjs_name" "$pocketjs_pid" "$pocketjs_starttime"; then
                log "could not persist Kindle UI identity; refusing to pause it"
                rm -f "$POCKETJS_UI_STATE"
                return 1
            fi
            # Close the PID-reuse/state race between recording and signalling.
            if ! ui_process_matches "$pocketjs_name" "$pocketjs_pid" "$pocketjs_starttime"; then
                rm -f "$POCKETJS_UI_STATE"
                continue
            fi
            pocketjs_state=$(process_state "$pocketjs_pid" 2>/dev/null || true)
            case "$pocketjs_state" in
                T|t)
                    rm -f "$POCKETJS_UI_STATE"
                    continue
                    ;;
            esac

            if ! kill -STOP "$pocketjs_pid" 2>/dev/null; then
                rm -f "$POCKETJS_UI_STATE"
                continue
            fi

            # Any failure after SIGSTOP must first undo our stop. Do not log,
            # write, or perform cleanup before that best-effort SIGCONT.
            pocketjs_stop_wait=0
            while :; do
                if ! ui_process_matches "$pocketjs_name" "$pocketjs_pid" "$pocketjs_starttime"; then
                    kill -CONT "$pocketjs_pid" 2>/dev/null || true
                    rm -f "$POCKETJS_UI_STATE"
                    log "could not verify stopped Kindle UI identity; resumed it immediately"
                    return 1
                fi
                pocketjs_state=$(process_state "$pocketjs_pid" 2>/dev/null || true)
                case "$pocketjs_state" in
                    T|t) break ;;
                    R|S|D|I)
                        if [ "$pocketjs_stop_wait" -lt 3 ]; then
                            sleep 1
                            pocketjs_stop_wait=$((pocketjs_stop_wait + 1))
                            continue
                        fi
                        ;;
                esac
                kill -CONT "$pocketjs_pid" 2>/dev/null || true
                rm -f "$POCKETJS_UI_STATE"
                log "could not verify stopped Kindle UI state; resumed it immediately"
                return 1
            done

            log "paused Kindle UI process $pocketjs_name ($pocketjs_pid)"
            return 0
        done
    done

    rm -f "$POCKETJS_UI_STATE"
    log "no supported Kindle UI process found (tried KPPMainAppV2, KPPMainApp, awesome)"
    return 1
}

remove_pid_file_if_ours() {
    pocketjs_path=$1
    pocketjs_expected=$2
    [ -f "$pocketjs_path" ] || return 0
    pocketjs_recorded=$(sed -n '1p' "$pocketjs_path" 2>/dev/null || true)
    [ "$pocketjs_recorded" = "$pocketjs_expected" ] && rm -f "$pocketjs_path"
}

remove_identity_if_ours() {
    [ -f "$POCKETJS_RUNTIME_IDENTITY" ] || return 0
    [ -n "$POCKETJS_RUNTIME_PID" ] || return 0
    [ "$(sed -n 's/^pid=//p' "$POCKETJS_RUNTIME_IDENTITY" 2>/dev/null || true)" = "$POCKETJS_RUNTIME_PID" ] &&
        rm -f "$POCKETJS_RUNTIME_IDENTITY"
}

stop_operation_active() {
    [ -d "$POCKETJS_STOP_LOCK" ]
}

export_operation_active() {
    [ -d "$POCKETJS_EXPORT_LOCK" ]
}

cleanup() {
    pocketjs_status=$1
    trap - EXIT INT TERM HUP
    if [ -n "$POCKETJS_RUNTIME_PID" ]; then
        remove_pid_file_if_ours "$POCKETJS_RUNTIME_PID_FILE" "$POCKETJS_RUNTIME_PID"
    fi
    remove_pid_file_if_ours "$POCKETJS_LAUNCHER_PID_FILE" "$$"
    remove_identity_if_ours
    if ! resume_recorded_ui; then
        pocketjs_status=1
    fi
    if ! restore_recorded_powerd; then
        pocketjs_status=1
    fi
    # The final FBInk process executes from the userstore. Keep launch
    # ownership through its completion so USB Mass Storage export cannot pass
    # its quiescence scans and race this last executable/open reference.
    if [ -x "$POCKETJS_DEV_ROOT/bin/fbink" ]; then
        "$POCKETJS_DEV_ROOT/bin/fbink" -q -f -s >/dev/null 2>&1 || true
    fi
    if [ -f "$POCKETJS_LAUNCH_LOCK/owner" ] &&
        [ "$(sed -n '1p' "$POCKETJS_LAUNCH_LOCK/owner" 2>/dev/null || true)" = "$$" ]; then
        rm -f "$POCKETJS_LAUNCH_LOCK/owner"
        rmdir "$POCKETJS_LAUNCH_LOCK" 2>/dev/null || true
    fi
    log "PocketJS runtime launcher exited with status $pocketjs_status"
    cleanup_launcher_tmp
    exit "$pocketjs_status"
}

forward_signal() {
    pocketjs_signal=$1
    if [ -n "$POCKETJS_RUNTIME_PID" ] && kill -0 "$POCKETJS_RUNTIME_PID" 2>/dev/null; then
        log "forwarding SIG$pocketjs_signal to runtime $POCKETJS_RUNTIME_PID"
        kill "-$pocketjs_signal" "$POCKETJS_RUNTIME_PID" 2>/dev/null || true
    fi
}

on_hup() {
    # HUP is PocketJS hot reload. Forward it and keep the launcher/UI ownership
    # alive; cleanup only happens if the runtime itself exits.
    forward_signal HUP
}

if [ ! -x "$POCKETJS_RUNTIME" ]; then
    log "runtime is missing or not executable: $POCKETJS_RUNTIME"
    exit 1
fi

if stop_operation_active || export_operation_active; then
    log "a runtime stop/export operation is active; refusing a new launch"
    exit 1
fi

if [ -f "$POCKETJS_RUNTIME_PID_FILE" ]; then
    pocketjs_existing_pid=$(sed -n '1p' "$POCKETJS_RUNTIME_PID_FILE" 2>/dev/null || true)
    if valid_pid "$pocketjs_existing_pid" && kill -0 "$pocketjs_existing_pid" 2>/dev/null; then
        log "runtime is already running (pid $pocketjs_existing_pid)"
        exit 1
    fi
    rm -f "$POCKETJS_RUNTIME_PID_FILE" "$POCKETJS_RUNTIME_IDENTITY"
fi

if ! mkdir "$POCKETJS_LAUNCH_LOCK" 2>/dev/null; then
    pocketjs_lock_owner=$(sed -n '1p' "$POCKETJS_LAUNCH_LOCK/owner" 2>/dev/null || true)
    if valid_pid "$pocketjs_lock_owner" && kill -0 "$pocketjs_lock_owner" 2>/dev/null; then
        log "another runtime launcher is active (pid $pocketjs_lock_owner)"
        exit 1
    fi
    log "stale runtime launch lock found; run stop-runtime or reboot before launching"
    exit 1
fi
if ! printf '%s\n' "$$" >"$POCKETJS_LAUNCH_LOCK/owner" ||
    [ "$(sed -n '1p' "$POCKETJS_LAUNCH_LOCK/owner" 2>/dev/null || true)" != "$$" ]; then
    rm -f "$POCKETJS_LAUNCH_LOCK/owner"
    rmdir "$POCKETJS_LAUNCH_LOCK" 2>/dev/null || true
    log "could not publish runtime launch lock owner"
    exit 1
fi

# A stop may have begun while this launcher was waiting on the launch lock.
# Recheck after ownership; the stop gate wins and closes the launch/stop race.
if stop_operation_active || export_operation_active; then
    rm -f "$POCKETJS_LAUNCH_LOCK/owner"
    rmdir "$POCKETJS_LAUNCH_LOCK" 2>/dev/null || true
    log "a runtime stop/export operation began during launch; refusing to start"
    exit 1
fi

trap 'cleanup $?' EXIT
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM
trap 'on_hup' HUP

# Keep one bounded log without requiring GNU logrotate on-device.
if [ -f "$POCKETJS_RUNTIME_LOG" ]; then
    pocketjs_log_size=$(wc -c <"$POCKETJS_RUNTIME_LOG" 2>/dev/null || echo 0)
    if [ "$pocketjs_log_size" -gt 1000000 ] 2>/dev/null; then
        tail -c 500000 "$POCKETJS_RUNTIME_LOG" >"$POCKETJS_RUNTIME_LOG.new" 2>/dev/null &&
            mv -f "$POCKETJS_RUNTIME_LOG.new" "$POCKETJS_RUNTIME_LOG"
    fi
fi
exec >>"$POCKETJS_RUNTIME_LOG" 2>&1

printf '%s\n' "$$" >"$POCKETJS_LAUNCHER_PID_FILE"
if ! prevent_screensaver_for_runtime; then
    exit 1
fi
if ! pause_kindle_ui; then
    exit 1
fi

# The native host refuses framebuffer ownership unless the launcher confirms
# that it successfully paused the Kindle GUI first.
export POCKETJS_GUI_PAUSED=1

log "starting PocketJS runtime: $POCKETJS_RUNTIME $*"
"$POCKETJS_RUNTIME" "$@" &
POCKETJS_RUNTIME_PID=$!
printf '%s\n' "$POCKETJS_RUNTIME_PID" >"$POCKETJS_RUNTIME_PID_FILE"
pocketjs_starttime=$(process_starttime "$POCKETJS_RUNTIME_PID" 2>/dev/null || true)
if [ -z "$pocketjs_starttime" ]; then
    log "could not record runtime process identity"
    exit 1
fi
{
    printf 'pid=%s\n' "$POCKETJS_RUNTIME_PID"
    printf 'starttime=%s\n' "$pocketjs_starttime"
    printf 'binary=%s\n' "$POCKETJS_RUNTIME"
} >"$POCKETJS_RUNTIME_IDENTITY"

pocketjs_runtime_status=0
while kill -0 "$POCKETJS_RUNTIME_PID" 2>/dev/null; do
    wait "$POCKETJS_RUNTIME_PID"
    pocketjs_runtime_status=$?
    # A trapped HUP/INT/TERM interrupts wait. Loop while the child still lives
    # so HUP remains hot reload rather than accidental launcher teardown.
done
wait "$POCKETJS_RUNTIME_PID" 2>/dev/null || true
exit "$pocketjs_runtime_status"
