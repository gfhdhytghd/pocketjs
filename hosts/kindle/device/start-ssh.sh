#!/bin/sh
# Managed by PocketJS Kindle bootstrap. Local edits will be replaced.

set -u
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

POCKETJS_DEV_ROOT="${POCKETJS_DEV_ROOT:-/mnt/us/pocketjs-dev}"
POCKETJS_LOCAL_ROOT="${POCKETJS_LOCAL_ROOT:-/var/local/pocketjs}"
POCKETJS_TMP_ROOT="${POCKETJS_TMP_ROOT:-/var/tmp}"
POCKETJS_PROC_ROOT="${POCKETJS_PROC_ROOT:-/proc}"
POCKETJS_USERSTORE_ROOT="${POCKETJS_USERSTORE_ROOT:-/mnt/us}"
POCKETJS_USERSTORE_ALIAS_ROOT="${POCKETJS_USERSTORE_ALIAS_ROOT:-/mnt/base-us}"
POCKETJS_DROPBEAR="$POCKETJS_DEV_ROOT/bin/dropbear"
POCKETJS_PID_FILE="$POCKETJS_LOCAL_ROOT/run/dropbear.pid"
POCKETJS_IDENTITY_FILE="$POCKETJS_LOCAL_ROOT/run/dropbear.identity"
POCKETJS_LOG_FILE="$POCKETJS_LOCAL_ROOT/logs/dropbear.log"
POCKETJS_USBNET_START="${POCKETJS_USBNET_START:-$POCKETJS_DEV_ROOT/usbnet-start.sh}"
POCKETJS_USBNET_STOP="${POCKETJS_USBNET_STOP:-$POCKETJS_DEV_ROOT/usbnet-stop.sh}"
POCKETJS_USB_MODE="${POCKETJS_USB_MODE:-$POCKETJS_DEV_ROOT/usb-mode.sh}"
POCKETJS_DROPBEAR_TERM_WAIT="${POCKETJS_DROPBEAR_TERM_WAIT:-10}"
POCKETJS_DROPBEAR_KILL_WAIT="${POCKETJS_DROPBEAR_KILL_WAIT:-5}"
POCKETJS_DROPBEAR_FREEZE_WAIT="${POCKETJS_DROPBEAR_FREEZE_WAIT:-3}"
POCKETJS_SIGNAL_COMMAND="${POCKETJS_SIGNAL_COMMAND:-kill}"
POCKETJS_PORT="${POCKETJS_SSH_PORT:-@@SSH_PORT@@}"
POCKETJS_KINDLE_IP="${POCKETJS_KINDLE_USB_IP:-@@KINDLE_USB_IP@@}"
pocketjs_usbnet_ready=0

for pocketjs_number in "$POCKETJS_DROPBEAR_TERM_WAIT" "$POCKETJS_DROPBEAR_KILL_WAIT" \
    "$POCKETJS_DROPBEAR_FREEZE_WAIT"; do
    case "$pocketjs_number" in
        ''|*[!0-9]*)
            echo "PocketJS: invalid Dropbear stop timing value: $pocketjs_number" >&2
            exit 2
            ;;
    esac
done

# Start may need to roll USBNetwork back to Mass Storage. Copy every script
# involved in that path to tmpfs before changing the gadget.
if [ "${POCKETJS_SSH_START_REEXEC:-0}" != "1" ]; then
    if [ ! -d "$POCKETJS_TMP_ROOT" ] || [ -L "$POCKETJS_TMP_ROOT" ]; then
        echo "PocketJS: unsafe or missing tmpfs root: $POCKETJS_TMP_ROOT" >&2
        exit 1
    fi
    POCKETJS_SSH_START_TMP_DIR="$POCKETJS_TMP_ROOT/pocketjs-start-ssh.$$"
    if ! (umask 077 && mkdir "$POCKETJS_SSH_START_TMP_DIR") 2>/dev/null; then
        echo "PocketJS: could not exclusively create SSH start tmpfs directory" >&2
        exit 1
    fi
    POCKETJS_SSH_START_TMP="$POCKETJS_SSH_START_TMP_DIR/start-ssh.sh"
    POCKETJS_USBNET_START_TMP="$POCKETJS_SSH_START_TMP_DIR/usbnet-start.sh"
    POCKETJS_USBNET_STOP_TMP="$POCKETJS_SSH_START_TMP_DIR/usbnet-stop.sh"
    POCKETJS_USB_MODE_TMP="$POCKETJS_SSH_START_TMP_DIR/usb-mode.sh"
    POCKETJS_DROPBEAR_TREE="$POCKETJS_SSH_START_TMP_DIR/dropbear-tree"
    if ! cp -p "$0" "$POCKETJS_SSH_START_TMP" ||
        ! cp -p "$POCKETJS_USBNET_START" "$POCKETJS_USBNET_START_TMP" ||
        ! cp -p "$POCKETJS_USBNET_STOP" "$POCKETJS_USBNET_STOP_TMP" ||
        ! cp -p "$POCKETJS_USB_MODE" "$POCKETJS_USB_MODE_TMP" ||
        ! chmod 700 "$POCKETJS_SSH_START_TMP" "$POCKETJS_USBNET_START_TMP" \
            "$POCKETJS_USBNET_STOP_TMP" "$POCKETJS_USB_MODE_TMP"; then
        rm -f "$POCKETJS_SSH_START_TMP" "$POCKETJS_USBNET_START_TMP" \
            "$POCKETJS_USBNET_STOP_TMP" "$POCKETJS_USB_MODE_TMP"
        rmdir "$POCKETJS_SSH_START_TMP_DIR" 2>/dev/null || true
        exit 1
    fi
    POCKETJS_USBNET_START="$POCKETJS_USBNET_START_TMP"
    POCKETJS_USBNET_STOP="$POCKETJS_USBNET_STOP_TMP"
    POCKETJS_USB_MODE="$POCKETJS_USB_MODE_TMP"
    export POCKETJS_SSH_START_REEXEC=1 POCKETJS_SSH_START_TMP
    export POCKETJS_SSH_START_TMP_DIR
    export POCKETJS_USBNET_START POCKETJS_USBNET_START_TMP
    export POCKETJS_USBNET_STOP POCKETJS_USBNET_STOP_TMP
    export POCKETJS_USB_MODE POCKETJS_USB_MODE_TMP
    export POCKETJS_DROPBEAR_TREE
    cd "$POCKETJS_SSH_START_TMP_DIR" || exit 1
    exec sh "$POCKETJS_SSH_START_TMP" "$@"
fi

cleanup_tmp_copies() {
    for pocketjs_tmp_file in \
        "${POCKETJS_SSH_START_TMP:-}" \
        "${POCKETJS_USBNET_START_TMP:-}" \
        "${POCKETJS_USBNET_STOP_TMP:-}" \
        "${POCKETJS_USB_MODE_TMP:-}" \
        "${POCKETJS_DROPBEAR_TREE:-}"; do
        [ -n "$pocketjs_tmp_file" ] && rm -f "$pocketjs_tmp_file"
    done
    if [ -n "${POCKETJS_SSH_START_TMP_DIR:-}" ]; then
        rmdir "$POCKETJS_SSH_START_TMP_DIR" 2>/dev/null || true
    fi
}
trap cleanup_tmp_copies EXIT

path_is_in_userstore() {
    case "${1:-}" in
        "$POCKETJS_USERSTORE_ROOT"|"$POCKETJS_USERSTORE_ROOT"/*|\
        "$POCKETJS_USERSTORE_ALIAS_ROOT"|"$POCKETJS_USERSTORE_ALIAS_ROOT"/*) return 0 ;;
        *) return 1 ;;
    esac
}

detach_from_launcher_fds() {
    exec </dev/null >>"$POCKETJS_LOG_FILE" 2>&1 || return 1
    pocketjs_high_fd_supported=no
    if (eval 'exec 10>&-') 2>/dev/null; then
        pocketjs_high_fd_supported=yes
    fi
    pocketjs_self_fd_root="${POCKETJS_SELF_FD_ROOT:-/proc/$$/fd}"
    for pocketjs_fd_path in "$pocketjs_self_fd_root/"[0-9]*; do
        [ -e "$pocketjs_fd_path" ] || [ -L "$pocketjs_fd_path" ] || continue
        pocketjs_fd=${pocketjs_fd_path##*/}
        case "$pocketjs_fd" in
            0|1|2|*[!0-9]*) continue ;;
        esac
        pocketjs_fd_target=$(readlink "$pocketjs_fd_path" 2>/dev/null || true)
        path_is_in_userstore "$pocketjs_fd_target" || continue
        case "$pocketjs_fd" in
            [3-9]) eval "exec ${pocketjs_fd}>&-" || return 1 ;;
            *)
                [ "$pocketjs_high_fd_supported" = yes ] || return 1
                eval "exec ${pocketjs_fd}>&-" || return 1
                ;;
        esac
    done
    return 0
}

rollback_usbnet_on_failure() {
    pocketjs_status=$1
    trap - EXIT HUP INT TERM
    if [ "$pocketjs_status" -ne 0 ] && [ "$pocketjs_usbnet_ready" -eq 1 ]; then
        cd "$POCKETJS_TMP_ROOT" 2>/dev/null || true
        detach_from_launcher_fds
        pocketjs_detach_status=$?
        if [ "$pocketjs_detach_status" -eq 0 ]; then
            echo "PocketJS: SSH startup failed; restoring the previous USB mode" >&2
            if ! sh "$POCKETJS_USBNET_STOP"; then
                echo "PocketJS: USB rollback failed; run PocketJS Stop USB SSH locally" >&2
            fi
        else
            echo "PocketJS: could not detach USB rollback from launcher descriptors; keeping USBNetwork active" >&2
        fi
    fi
    cleanup_tmp_copies
    exit "$pocketjs_status"
}

valid_number() {
    case "${1:-}" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

process_name() {
    [ -r "$POCKETJS_PROC_ROOT/$1/comm" ] || return 1
    sed -n '1p' "$POCKETJS_PROC_ROOT/$1/comm" 2>/dev/null
}

process_stat_tail() {
    [ -r "$POCKETJS_PROC_ROOT/$1/stat" ] || return 1
    # /proc/PID/stat's comm field is parenthesized but may itself contain
    # spaces or ')'. Strip through the final ") " before selecting fields.
    sed -n '1{s/^.*) //;p;}' "$POCKETJS_PROC_ROOT/$1/stat" 2>/dev/null
}

process_starttime() {
    process_stat_tail "$1" | awk '{ print $20 }'
}

process_state() {
    process_stat_tail "$1" | awk '{ print $1 }'
}

process_executable() {
    [ -L "$POCKETJS_PROC_ROOT/$1/exe" ] || return 1
    readlink "$POCKETJS_PROC_ROOT/$1/exe" 2>/dev/null
}

dropbear_binary_matches() {
    pocketjs_actual_binary=$(process_executable "$1" 2>/dev/null || true)
    case "$pocketjs_actual_binary" in
        "$POCKETJS_DROPBEAR"|"$POCKETJS_DROPBEAR (deleted)") return 0 ;;
        *) return 1 ;;
    esac
}

dropbear_process_matches() {
    pocketjs_expected_pid=$1
    pocketjs_expected_starttime=$2
    valid_number "$pocketjs_expected_pid" || return 1
    valid_number "$pocketjs_expected_starttime" || return 1
    [ "$(process_name "$pocketjs_expected_pid" 2>/dev/null || true)" = "dropbear" ] ||
        return 1
    dropbear_binary_matches "$pocketjs_expected_pid" || return 1
    [ "$(process_starttime "$pocketjs_expected_pid" 2>/dev/null || true)" = "$pocketjs_expected_starttime" ]
}

process_parent_pid() {
    [ -r "$POCKETJS_PROC_ROOT/$1/status" ] || return 1
    sed -n 's/^PPid:[[:space:]]*//p' "$POCKETJS_PROC_ROOT/$1/status" 2>/dev/null |
        sed -n '1p'
}

tracked_has_identity() {
    grep -q "^$1 $2$" "$POCKETJS_DROPBEAR_TREE" 2>/dev/null
}

tracked_has_current_pid() {
    pocketjs_tracked_current_start=$(process_starttime "$1" 2>/dev/null || true)
    valid_number "$pocketjs_tracked_current_start" || return 1
    tracked_has_identity "$1" "$pocketjs_tracked_current_start"
}

track_process_identity() {
    pocketjs_track_pid=$1
    pocketjs_track_start=$2
    valid_number "$pocketjs_track_pid" || return 2
    valid_number "$pocketjs_track_start" || return 2
    tracked_has_identity "$pocketjs_track_pid" "$pocketjs_track_start" && return 1
    printf '%s %s\n' "$pocketjs_track_pid" "$pocketjs_track_start" \
        >>"$POCKETJS_DROPBEAR_TREE" || return 2
    return 0
}

process_has_pocketjs_ssh_environment() {
    [ -r "$POCKETJS_PROC_ROOT/$1/environ" ] || return 1
    pocketjs_ssh_connection=$(
        tr '\000' '\n' <"$POCKETJS_PROC_ROOT/$1/environ" 2>/dev/null |
            sed -n 's/^SSH_CONNECTION=//p' |
            sed -n '1p'
    )
    case "$pocketjs_ssh_connection" in
        *" $POCKETJS_KINDLE_IP $POCKETJS_PORT") return 0 ;;
        *) return 1 ;;
    esac
}

capture_pocketjs_dropbear_pass() {
    pocketjs_capture_added=no
    [ -f "$POCKETJS_DROPBEAR_TREE" ] || return 1
    for pocketjs_proc_dir in "$POCKETJS_PROC_ROOT"/[0-9]*; do
        [ -d "$pocketjs_proc_dir" ] || continue
        pocketjs_scan_pid=${pocketjs_proc_dir##*/}
        pocketjs_scan_start_before=$(process_starttime "$pocketjs_scan_pid" 2>/dev/null || true)
        valid_number "$pocketjs_scan_start_before" || continue

        pocketjs_scan_selected=no
        if dropbear_binary_matches "$pocketjs_scan_pid" ||
            process_has_pocketjs_ssh_environment "$pocketjs_scan_pid"; then
            pocketjs_scan_selected=yes
        else
            pocketjs_scan_parent=$(process_parent_pid "$pocketjs_scan_pid" 2>/dev/null || true)
            if valid_number "$pocketjs_scan_parent" &&
                tracked_has_current_pid "$pocketjs_scan_parent"; then
                pocketjs_scan_selected=yes
            fi
        fi
        [ "$pocketjs_scan_selected" = yes ] || continue

        pocketjs_scan_start_after=$(process_starttime "$pocketjs_scan_pid" 2>/dev/null || true)
        [ "$pocketjs_scan_start_before" = "$pocketjs_scan_start_after" ] || continue
        track_process_identity "$pocketjs_scan_pid" "$pocketjs_scan_start_before"
        pocketjs_track_status=$?
        case "$pocketjs_track_status" in
            0) pocketjs_capture_added=yes ;;
            1) ;;
            *) return 1 ;;
        esac
    done
    return 0
}

tracked_process_matches() {
    pocketjs_tracked_pid=$1
    pocketjs_tracked_start=$2
    valid_number "$pocketjs_tracked_pid" || return 1
    valid_number "$pocketjs_tracked_start" || return 1
    [ "$(process_starttime "$pocketjs_tracked_pid" 2>/dev/null || true)" = "$pocketjs_tracked_start" ]
}

any_tracked_process() {
    while read -r pocketjs_tracked_pid pocketjs_tracked_start; do
        if tracked_process_matches "$pocketjs_tracked_pid" "$pocketjs_tracked_start"; then
            return 0
        fi
    done <"$POCKETJS_DROPBEAR_TREE"
    return 1
}

signal_tracked_processes() {
    pocketjs_signal=$1
    pocketjs_signal_failed=no
    while read -r pocketjs_tracked_pid pocketjs_tracked_start; do
        tracked_process_matches "$pocketjs_tracked_pid" "$pocketjs_tracked_start" || continue
        if ! "$POCKETJS_SIGNAL_COMMAND" "-$pocketjs_signal" "$pocketjs_tracked_pid" 2>/dev/null &&
            tracked_process_matches "$pocketjs_tracked_pid" "$pocketjs_tracked_start"; then
            pocketjs_signal_failed=yes
        fi
    done <"$POCKETJS_DROPBEAR_TREE"
    [ "$pocketjs_signal_failed" = no ]
}

continue_tracked_processes() {
    signal_tracked_processes CONT >/dev/null 2>&1 || true
}

verify_tracked_processes_stopped() {
    while read -r pocketjs_tracked_pid pocketjs_tracked_start; do
        tracked_process_matches "$pocketjs_tracked_pid" "$pocketjs_tracked_start" || continue
        pocketjs_tracked_state=$(process_state "$pocketjs_tracked_pid" 2>/dev/null || true)
        [ "$(process_starttime "$pocketjs_tracked_pid" 2>/dev/null || true)" = \
            "$pocketjs_tracked_start" ] || continue
        case "$pocketjs_tracked_state" in
            T|t) ;;
            *) return 1 ;;
        esac
    done <"$POCKETJS_DROPBEAR_TREE"
    return 0
}

wait_for_tracked_processes_stopped() {
    pocketjs_freeze_wait=0
    while ! verify_tracked_processes_stopped; do
        [ "$pocketjs_freeze_wait" -lt "$POCKETJS_DROPBEAR_FREEZE_WAIT" ] || return 1
        sleep 1
        pocketjs_freeze_wait=$((pocketjs_freeze_wait + 1))
    done
    return 0
}

freeze_pocketjs_dropbear_tree() {
    pocketjs_freeze_round=0
    if ! capture_pocketjs_dropbear_pass; then
        continue_tracked_processes
        return 1
    fi
    while [ "$pocketjs_freeze_round" -lt 32 ]; do
        if ! signal_tracked_processes STOP ||
            ! wait_for_tracked_processes_stopped; then
            continue_tracked_processes
            echo "PocketJS: could not freeze every Dropbear/session process; keeping USBNetwork active" >&2
            return 1
        fi
        if ! capture_pocketjs_dropbear_pass; then
            continue_tracked_processes
            return 1
        fi
        [ "$pocketjs_capture_added" = no ] && return 0
        pocketjs_freeze_round=$((pocketjs_freeze_round + 1))
    done
    continue_tracked_processes
    echo "PocketJS: Dropbear process tree did not stabilize; keeping USBNetwork active" >&2
    return 1
}

capture_pocketjs_dropbear_tree_to_stability() {
    pocketjs_capture_round=0
    while [ "$pocketjs_capture_round" -lt 32 ]; do
        capture_pocketjs_dropbear_pass || return 1
        [ "$pocketjs_capture_added" = no ] && return 0
        pocketjs_capture_round=$((pocketjs_capture_round + 1))
    done
    return 1
}

final_dropbear_rescan_is_empty() {
    capture_pocketjs_dropbear_tree_to_stability || return 1
    ! any_tracked_process
}

any_pocketjs_dropbear() {
    : >"$POCKETJS_DROPBEAR_TREE" || return 0
    if ! capture_pocketjs_dropbear_tree_to_stability; then
        return 0
    fi
    any_tracked_process
}

terminate_all_pocketjs_dropbear() {
    : >"$POCKETJS_DROPBEAR_TREE" || return 1
    freeze_pocketjs_dropbear_tree || return 1
    if ! any_tracked_process; then
        final_dropbear_rescan_is_empty
        return $?
    fi

    if ! signal_tracked_processes TERM; then
        continue_tracked_processes
        return 1
    fi
    continue_tracked_processes

    pocketjs_wait=0
    while any_tracked_process &&
        [ "$pocketjs_wait" -lt "$POCKETJS_DROPBEAR_TERM_WAIT" ]; do
        sleep 1
        pocketjs_wait=$((pocketjs_wait + 1))
    done
    if any_tracked_process; then
        freeze_pocketjs_dropbear_tree || return 1
        echo "PocketJS: Dropbear/session descendant ignored SIGTERM; sending SIGKILL" >&2
        if ! signal_tracked_processes KILL; then
            continue_tracked_processes
            return 1
        fi
        pocketjs_wait=0
        while any_tracked_process &&
            [ "$pocketjs_wait" -lt "$POCKETJS_DROPBEAR_KILL_WAIT" ]; do
            sleep 1
            pocketjs_wait=$((pocketjs_wait + 1))
        done
    fi
    if ! final_dropbear_rescan_is_empty; then
        continue_tracked_processes
        return 1
    fi
    return 0
}

rotate_dropbear_log() {
    [ -f "$POCKETJS_LOG_FILE" ] || return 0
    pocketjs_log_size=$(
        wc -c <"$POCKETJS_LOG_FILE" 2>/dev/null |
            tr -d '[:space:]'
    )
    case "$pocketjs_log_size" in
        ''|*[!0-9]*) return 0 ;;
    esac
    [ "$pocketjs_log_size" -gt 1048576 ] || return 0
    pocketjs_rotate_dir="$POCKETJS_LOCAL_ROOT/logs/.pocketjs-rotate.$$"
    if ! (umask 077 && mkdir "$pocketjs_rotate_dir") 2>/dev/null; then
        return 1
    fi
    if tail -c 524288 "$POCKETJS_LOG_FILE" >"$pocketjs_rotate_dir/log" 2>/dev/null &&
        chmod 600 "$pocketjs_rotate_dir/log" 2>/dev/null &&
        mv -f "$pocketjs_rotate_dir/log" "$POCKETJS_LOG_FILE"; then
        rmdir "$pocketjs_rotate_dir" 2>/dev/null || true
        return 0
    fi
    rm -f "$pocketjs_rotate_dir/log"
    rmdir "$pocketjs_rotate_dir" 2>/dev/null || true
    return 1
}

load_dropbear_identity() {
    [ -f "$POCKETJS_IDENTITY_FILE" ] || return 1
    pocketjs_identity_name=$(sed -n 's/^name=//p' "$POCKETJS_IDENTITY_FILE" 2>/dev/null || true)
    pocketjs_identity_pid=$(sed -n 's/^pid=//p' "$POCKETJS_IDENTITY_FILE" 2>/dev/null || true)
    pocketjs_identity_starttime=$(sed -n 's/^starttime=//p' "$POCKETJS_IDENTITY_FILE" 2>/dev/null || true)
    pocketjs_identity_binary=$(sed -n 's/^binary=//p' "$POCKETJS_IDENTITY_FILE" 2>/dev/null || true)
    [ "$pocketjs_identity_name" = "dropbear" ] || return 1
    valid_number "$pocketjs_identity_pid" || return 1
    valid_number "$pocketjs_identity_starttime" || return 1
    [ "$pocketjs_identity_binary" = "$POCKETJS_DROPBEAR" ]
}

persist_dropbear_identity() {
    pocketjs_identity_pid=$1
    pocketjs_identity_starttime=$2
    pocketjs_identity_tmp="$POCKETJS_IDENTITY_FILE.tmp.$$"

    rm -f "$pocketjs_identity_tmp"
    if ! {
        printf 'name=dropbear\n'
        printf 'pid=%s\n' "$pocketjs_identity_pid"
        printf 'starttime=%s\n' "$pocketjs_identity_starttime"
        printf 'binary=%s\n' "$POCKETJS_DROPBEAR"
    } >"$pocketjs_identity_tmp"; then
        rm -f "$pocketjs_identity_tmp"
        return 1
    fi
    if ! mv -f "$pocketjs_identity_tmp" "$POCKETJS_IDENTITY_FILE"; then
        rm -f "$pocketjs_identity_tmp"
        return 1
    fi
    if ! sync >/dev/null 2>&1 || ! load_dropbear_identity ||
        [ "$pocketjs_identity_pid" != "$1" ] ||
        [ "$pocketjs_identity_starttime" != "$2" ]; then
        return 1
    fi
}

notify() {
    message=$1
    if [ -x "$POCKETJS_DEV_ROOT/bin/fbink" ]; then
        "$POCKETJS_DEV_ROOT/bin/fbink" -q -m "$message" >/dev/null 2>&1 || true
    elif command -v eips >/dev/null 2>&1; then
        eips 0 2 "$message" >/dev/null 2>&1 || true
    fi
}

notify_system() {
    message=$1
    if command -v eips >/dev/null 2>&1; then
        eips 0 2 "$message" >/dev/null 2>&1 || true
    fi
}

umask 077
mkdir -p "$POCKETJS_LOCAL_ROOT/run" "$POCKETJS_LOCAL_ROOT/logs" \
    "$POCKETJS_DEV_ROOT/settings/SSH" || exit 1
chmod 700 "$POCKETJS_LOCAL_ROOT" "$POCKETJS_LOCAL_ROOT/run" \
    "$POCKETJS_LOCAL_ROOT/logs" 2>/dev/null || true
rotate_dropbear_log || exit 1
: >>"$POCKETJS_LOG_FILE" || exit 1
chmod 600 "$POCKETJS_LOG_FILE" 2>/dev/null || true

if [ ! -x "$POCKETJS_DROPBEAR" ]; then
    echo "PocketJS: missing executable $POCKETJS_DROPBEAR" >&2
    notify "PocketJS SSH failed: dropbear is missing"
    exit 1
fi

if [ ! -s "$POCKETJS_DEV_ROOT/settings/SSH/authorized_keys" ]; then
    echo "PocketJS: authorized_keys is missing or empty" >&2
    notify "PocketJS SSH failed: no authorized key"
    exit 1
fi

pocketjs_listener_valid=no
if [ -f "$POCKETJS_PID_FILE" ]; then
    pocketjs_pid=$(sed -n '1p' "$POCKETJS_PID_FILE" 2>/dev/null || true)
    if valid_number "$pocketjs_pid" &&
        load_dropbear_identity &&
        [ "$pocketjs_identity_pid" = "$pocketjs_pid" ] &&
        dropbear_process_matches "$pocketjs_identity_pid" "$pocketjs_identity_starttime"; then
        pocketjs_listener_valid=yes
    fi
fi

if any_pocketjs_dropbear && [ "$pocketjs_listener_valid" != yes ]; then
    echo "PocketJS: an untracked PocketJS Dropbear process is already running; refusing to start another" >&2
    notify "PocketJS SSH failed: untracked Dropbear is active"
    exit 1
fi

if [ "$pocketjs_listener_valid" != yes ]; then
    rm -f "$POCKETJS_PID_FILE" "$POCKETJS_IDENTITY_FILE"
fi

detach_from_launcher_fds
pocketjs_detach_status=$?
if [ "$pocketjs_detach_status" -ne 0 ]; then
    echo "PocketJS: could not detach SSH startup from launcher descriptors" >&2
    notify_system "PocketJS SSH failed: launcher log is still attached"
    exit 1
fi

if ! sh "$POCKETJS_USBNET_START"; then
    echo "PocketJS: USBNetwork could not be enabled" >&2
    # usbnet-start may already have restored Mass Storage. Do not touch an
    # fbink binary on /mnt/us while that rollback state is unknown.
    notify_system "PocketJS SSH failed: USBNetwork unavailable"
    exit 1
fi
pocketjs_usbnet_ready=1
trap 'rollback_usbnet_on_failure $?' EXIT
trap 'exit 1' HUP INT TERM

if [ "$pocketjs_listener_valid" = yes ]; then
    echo "PocketJS SSH is already running (pid $pocketjs_pid, $POCKETJS_KINDLE_IP:$POCKETJS_PORT)"
    notify "PocketJS SSH already running on USB port $POCKETJS_PORT"
    exit 0
fi

chmod 700 "$POCKETJS_DEV_ROOT/settings/SSH" 2>/dev/null || true
chmod 600 "$POCKETJS_DEV_ROOT/settings/SSH/authorized_keys" 2>/dev/null || true
if ! cd "$POCKETJS_DEV_ROOT"; then
    echo "PocketJS: cannot enter $POCKETJS_DEV_ROOT" >&2
    notify "PocketJS SSH failed: storage unavailable"
    exit 1
fi

echo "[$(date 2>/dev/null || echo unknown-time)] starting dropbear on USB $POCKETJS_KINDLE_IP:$POCKETJS_PORT" \
    >>"$POCKETJS_LOG_FILE"

# This KOReader build of Dropbear looks for host keys and authorized_keys
# below ./settings/SSH. -n bypasses Kindle's nonstandard account database;
# -s still disables every password login, so the dedicated key is mandatory.
"$POCKETJS_DROPBEAR" \
    -E -R -n -s \
    -l usb0 \
    -p "$POCKETJS_KINDLE_IP:$POCKETJS_PORT" \
    -P "$POCKETJS_PID_FILE" \
    >>"$POCKETJS_LOG_FILE" 2>&1

sleep 1
if [ -f "$POCKETJS_PID_FILE" ]; then
    pocketjs_pid=$(sed -n '1p' "$POCKETJS_PID_FILE" 2>/dev/null || true)
    if valid_number "$pocketjs_pid"; then
        pocketjs_starttime=$(process_starttime "$pocketjs_pid" 2>/dev/null || true)
    else
        pocketjs_starttime=
    fi
    if valid_number "$pocketjs_starttime" &&
        dropbear_process_matches "$pocketjs_pid" "$pocketjs_starttime" &&
        persist_dropbear_identity "$pocketjs_pid" "$pocketjs_starttime" &&
        dropbear_process_matches "$pocketjs_pid" "$pocketjs_starttime"; then
        echo "PocketJS SSH started (pid $pocketjs_pid, $POCKETJS_KINDLE_IP:$POCKETJS_PORT)"
        notify "PocketJS USB SSH started on port $POCKETJS_PORT"
        exit 0
    fi
fi

if ! terminate_all_pocketjs_dropbear; then
    echo "PocketJS: failed to stop the partially started Dropbear; keeping USBNetwork active" >&2
    pocketjs_usbnet_ready=0
    notify "PocketJS SSH failed: Dropbear cleanup incomplete"
    exit 1
fi
rm -f "$POCKETJS_PID_FILE" "$POCKETJS_IDENTITY_FILE"
echo "PocketJS SSH did not start; inspect $POCKETJS_LOG_FILE" >&2
notify "PocketJS SSH failed; run diagnostics"
exit 1
