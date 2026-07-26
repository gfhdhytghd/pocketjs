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
POCKETJS_STOP_LOG_FILE="$POCKETJS_LOCAL_ROOT/logs/dropbear-stop.log"
POCKETJS_STOP_RUNTIME="${POCKETJS_STOP_RUNTIME:-$POCKETJS_DEV_ROOT/stop-runtime.sh}"
POCKETJS_USBNET_STOP="${POCKETJS_USBNET_STOP:-$POCKETJS_DEV_ROOT/usbnet-stop.sh}"
POCKETJS_USB_MODE="${POCKETJS_USB_MODE:-$POCKETJS_DEV_ROOT/usb-mode.sh}"
POCKETJS_DROPBEAR_TERM_WAIT="${POCKETJS_DROPBEAR_TERM_WAIT:-10}"
POCKETJS_DROPBEAR_KILL_WAIT="${POCKETJS_DROPBEAR_KILL_WAIT:-5}"
POCKETJS_DROPBEAR_FREEZE_WAIT="${POCKETJS_DROPBEAR_FREEZE_WAIT:-3}"
POCKETJS_SIGNAL_COMMAND="${POCKETJS_SIGNAL_COMMAND:-kill}"
POCKETJS_SSH_STOP_LAUNCHER_WAIT="${POCKETJS_SSH_STOP_LAUNCHER_WAIT:-10}"
POCKETJS_PORT="${POCKETJS_SSH_PORT:-@@SSH_PORT@@}"
POCKETJS_KINDLE_IP="${POCKETJS_KINDLE_USB_IP:-@@KINDLE_USB_IP@@}"

for pocketjs_number in "$POCKETJS_DROPBEAR_TERM_WAIT" "$POCKETJS_DROPBEAR_KILL_WAIT" \
    "$POCKETJS_DROPBEAR_FREEZE_WAIT" "$POCKETJS_SSH_STOP_LAUNCHER_WAIT"; do
    case "$pocketjs_number" in
        ''|*[!0-9]*)
            echo "PocketJS: invalid Dropbear stop timing value: $pocketjs_number" >&2
            exit 2
            ;;
    esac
done

process_stat_tail() {
    [ -r "$POCKETJS_PROC_ROOT/$1/stat" ] || return 1
    # /proc/PID/stat's comm field is parenthesized but may itself contain
    # spaces or ')'. Strip through the final ") " before selecting fields.
    sed -n '1{s/^.*) //;p;}' "$POCKETJS_PROC_ROOT/$1/stat" 2>/dev/null
}

process_starttime() {
    process_stat_tail "$1" | awk '{ print $20 }'
}

path_is_in_userstore() {
    case "${1:-}" in
        "$POCKETJS_USERSTORE_ROOT"|"$POCKETJS_USERSTORE_ROOT"/*|\
        "$POCKETJS_USERSTORE_ALIAS_ROOT"|"$POCKETJS_USERSTORE_ALIAS_ROOT"/*) return 0 ;;
        *) return 1 ;;
    esac
}

rotate_local_log() {
    pocketjs_rotate_log=$1
    [ -f "$pocketjs_rotate_log" ] || return 0
    pocketjs_rotate_size=$(
        wc -c <"$pocketjs_rotate_log" 2>/dev/null |
            tr -d '[:space:]'
    )
    case "$pocketjs_rotate_size" in
        ''|*[!0-9]*) return 0 ;;
    esac
    [ "$pocketjs_rotate_size" -gt 1048576 ] || return 0
    pocketjs_rotate_dir="$POCKETJS_LOCAL_ROOT/logs/.pocketjs-rotate.$$"
    if ! (umask 077 && mkdir "$pocketjs_rotate_dir") 2>/dev/null; then
        return 1
    fi
    if tail -c 524288 "$pocketjs_rotate_log" >"$pocketjs_rotate_dir/log" 2>/dev/null &&
        chmod 600 "$pocketjs_rotate_dir/log" 2>/dev/null &&
        mv -f "$pocketjs_rotate_dir/log" "$pocketjs_rotate_log"; then
        rmdir "$pocketjs_rotate_dir" 2>/dev/null || true
        return 0
    fi
    rm -f "$pocketjs_rotate_dir/log"
    rmdir "$pocketjs_rotate_dir" 2>/dev/null || true
    return 1
}

# Restoring USB Mass Storage tears down the SSH transport itself. Requiring a
# local KUAL/Library launch avoids killing the command that is performing the
# final safety checks.
if [ -n "${SSH_CONNECTION:-}" ] || [ -n "${SSH_CLIENT:-}" ] || [ -n "${SSH_TTY:-}" ]; then
    echo "PocketJS: Stop USB SSH must be launched locally from KUAL or the Kindle Library" >&2
    exit 1
fi

# Reexec the complete stop chain from tmpfs before inspecting or stopping any
# process. usbnet-stop will remove its own copies after the final transition.
if [ "${POCKETJS_SSH_STOP_REEXEC:-0}" != "1" ]; then
    if [ ! -d "$POCKETJS_TMP_ROOT" ] || [ -L "$POCKETJS_TMP_ROOT" ]; then
        echo "PocketJS: unsafe or missing tmpfs root: $POCKETJS_TMP_ROOT" >&2
        exit 1
    fi
    POCKETJS_SSH_STOP_TMP_DIR="$POCKETJS_TMP_ROOT/pocketjs-stop-ssh.$$"
    if ! (umask 077 && mkdir "$POCKETJS_SSH_STOP_TMP_DIR") 2>/dev/null; then
        echo "PocketJS: could not exclusively create SSH stop tmpfs directory" >&2
        exit 1
    fi
    POCKETJS_SSH_STOP_TMP="$POCKETJS_SSH_STOP_TMP_DIR/stop-ssh.sh"
    POCKETJS_STOP_RUNTIME_TMP="$POCKETJS_SSH_STOP_TMP_DIR/stop-runtime.sh"
    POCKETJS_USBNET_STOP_TMP="$POCKETJS_SSH_STOP_TMP_DIR/usbnet-stop.sh"
    POCKETJS_USB_MODE_TMP="$POCKETJS_SSH_STOP_TMP_DIR/usb-mode.sh"
    if ! cp -p "$0" "$POCKETJS_SSH_STOP_TMP" ||
        ! cp -p "$POCKETJS_STOP_RUNTIME" "$POCKETJS_STOP_RUNTIME_TMP" ||
        ! cp -p "$POCKETJS_USBNET_STOP" "$POCKETJS_USBNET_STOP_TMP" ||
        ! cp -p "$POCKETJS_USB_MODE" "$POCKETJS_USB_MODE_TMP" ||
        ! chmod 700 "$POCKETJS_SSH_STOP_TMP" "$POCKETJS_STOP_RUNTIME_TMP" \
            "$POCKETJS_USBNET_STOP_TMP" "$POCKETJS_USB_MODE_TMP"; then
        rm -f "$POCKETJS_SSH_STOP_TMP" "$POCKETJS_STOP_RUNTIME_TMP" \
            "$POCKETJS_USBNET_STOP_TMP" "$POCKETJS_USB_MODE_TMP"
        rmdir "$POCKETJS_SSH_STOP_TMP_DIR" 2>/dev/null || true
        exit 1
    fi
    POCKETJS_STOP_RUNTIME="$POCKETJS_STOP_RUNTIME_TMP"
    POCKETJS_USBNET_STOP="$POCKETJS_USBNET_STOP_TMP"
    POCKETJS_USB_MODE="$POCKETJS_USB_MODE_TMP"
    POCKETJS_DROPBEAR_TREE="$POCKETJS_SSH_STOP_TMP_DIR/dropbear-tree"
    export POCKETJS_SSH_STOP_REEXEC=1 POCKETJS_SSH_STOP_TMP
    export POCKETJS_SSH_STOP_TMP_DIR
    export POCKETJS_STOP_RUNTIME POCKETJS_STOP_RUNTIME_TMP
    export POCKETJS_USBNET_STOP POCKETJS_USBNET_STOP_TMP
    export POCKETJS_USB_MODE POCKETJS_USB_MODE_TMP
    export POCKETJS_DROPBEAR_TREE

    # KUAL commonly redirects the launcher to /mnt/us/extensions/KUAL.log.
    # Return to KUAL immediately and run the destructive portion from tmpfs
    # with no inherited userstore descriptors. Foreground mode is test-only.
    if [ "${POCKETJS_SSH_STOP_FOREGROUND:-0}" = "1" ]; then
        cd "$POCKETJS_SSH_STOP_TMP_DIR" || exit 1
        exec sh "$POCKETJS_SSH_STOP_TMP" "$@"
    fi
    umask 077
    if ! mkdir -p "$POCKETJS_LOCAL_ROOT/logs" ||
        ! rotate_local_log "$POCKETJS_STOP_LOG_FILE" ||
        ! : >>"$POCKETJS_STOP_LOG_FILE" ||
        ! chmod 600 "$POCKETJS_STOP_LOG_FILE" 2>/dev/null; then
        rm -f "$POCKETJS_SSH_STOP_TMP" "$POCKETJS_STOP_RUNTIME_TMP" \
            "$POCKETJS_USBNET_STOP_TMP" "$POCKETJS_USB_MODE_TMP"
        rmdir "$POCKETJS_SSH_STOP_TMP_DIR" 2>/dev/null || true
        echo "PocketJS: could not prepare detached SSH stop log" >&2
        exit 1
    fi
    POCKETJS_SSH_STOP_LAUNCHER_PID=$$
    POCKETJS_SSH_STOP_LAUNCHER_START=$(process_starttime "$$" 2>/dev/null || true)
    export POCKETJS_SSH_STOP_DETACHED=1
    export POCKETJS_SSH_STOP_LAUNCHER_PID POCKETJS_SSH_STOP_LAUNCHER_START
    (
        trap '' HUP
        exec </dev/null >>"$POCKETJS_STOP_LOG_FILE" 2>&1
        cd "$POCKETJS_SSH_STOP_TMP_DIR" || exit 1
        exec sh "$POCKETJS_SSH_STOP_TMP" "$@"
    ) &
    echo "PocketJS SSH stop worker started; USB Mass Storage will return after safety checks"
    exit 0
fi

if [ "${POCKETJS_SSH_STOP_DETACHED:-0}" = "1" ]; then
    # The freshly exec'd worker now has its own PID, so /proc/$$/fd can close
    # every remaining descriptor that still points into the userstore without
    # disturbing ash's private descriptor for this tmpfs script.
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
            [3-9]) eval "exec ${pocketjs_fd}>&-" || exit 1 ;;
            *)
                [ "$pocketjs_high_fd_supported" = yes ] || exit 1
                eval "exec ${pocketjs_fd}>&-" || exit 1
                ;;
        esac
    done
fi

cleanup_all_tmp_copies() {
    for pocketjs_tmp_file in \
        "${POCKETJS_SSH_STOP_TMP:-}" \
        "${POCKETJS_STOP_RUNTIME_TMP:-}" \
        "${POCKETJS_USBNET_STOP_TMP:-}" \
        "${POCKETJS_USB_MODE_TMP:-}" \
        "${POCKETJS_DROPBEAR_TREE:-}"; do
        [ -n "$pocketjs_tmp_file" ] && rm -f "$pocketjs_tmp_file"
    done
    if [ -n "${POCKETJS_SSH_STOP_TMP_DIR:-}" ]; then
        rmdir "$POCKETJS_SSH_STOP_TMP_DIR" 2>/dev/null || true
    fi
}
trap cleanup_all_tmp_copies EXIT

valid_number() {
    case "${1:-}" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
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

# One bounded /proc pass. A candidate's selector (exact executable, matching
# SSH_CONNECTION, or tracked parent) is bracketed by identical starttimes so a
# recycled PID cannot be added under the identity that was inspected.
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

# Converge capture -> STOP -> stopped-state verification -> capture. Every
# newly captured child is stopped and verified before another pass may finish.
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
        # A TERM-resistant session may have forked. Freeze and converge again
        # immediately before KILL, then leave the tree stopped while killing.
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

wait_for_detached_launcher_exit() {
    [ "${POCKETJS_SSH_STOP_DETACHED:-0}" = "1" ] || return 0
    pocketjs_launcher_pid="${POCKETJS_SSH_STOP_LAUNCHER_PID:-}"
    pocketjs_launcher_start="${POCKETJS_SSH_STOP_LAUNCHER_START:-}"
    valid_number "$pocketjs_launcher_pid" || return 0
    valid_number "$pocketjs_launcher_start" || return 0
    pocketjs_launcher_wait=0
    while detached_launcher_identity_is_active \
        "$pocketjs_launcher_pid" "$pocketjs_launcher_start" &&
        [ "$pocketjs_launcher_wait" -lt "$POCKETJS_SSH_STOP_LAUNCHER_WAIT" ]; do
        sleep 1
        pocketjs_launcher_wait=$((pocketjs_launcher_wait + 1))
    done
    if detached_launcher_identity_is_active \
        "$pocketjs_launcher_pid" "$pocketjs_launcher_start"; then
        echo "PocketJS: KUAL launcher did not release its userstore descriptors; keeping USBNetwork active" >&2
        return 1
    fi
    return 0
}

detached_launcher_identity_is_active() {
    pocketjs_launcher_check_pid=$1
    pocketjs_launcher_check_start=$2
    [ "$(process_starttime "$pocketjs_launcher_check_pid" 2>/dev/null || true)" = \
        "$pocketjs_launcher_check_start" ] || return 1
    # A zombie retains /proc/PID/stat and its starttime until reaped, but has
    # already released cwd and every file descriptor, so it cannot pin KUAL.log.
    [ "$(process_state "$pocketjs_launcher_check_pid" 2>/dev/null || true)" != "Z" ]
}

notify() {
    message=$1
    if [ -x "$POCKETJS_DEV_ROOT/bin/fbink" ]; then
        "$POCKETJS_DEV_ROOT/bin/fbink" -q -m "$message" >/dev/null 2>&1 || true
    elif command -v eips >/dev/null 2>&1; then
        eips 0 2 "$message" >/dev/null 2>&1 || true
    fi
}

if ! wait_for_detached_launcher_exit; then
    exit 1
fi

if ! sh "$POCKETJS_STOP_RUNTIME"; then
    echo "PocketJS: runtime did not stop; keeping USBNetwork active" >&2
    notify "PocketJS stop failed: runtime is still active"
    exit 1
fi

echo "Stopping PocketJS Dropbear and every captured SSH session descendant"
if ! terminate_all_pocketjs_dropbear; then
    echo "PocketJS: a PocketJS Dropbear process survived SIGKILL; keeping USBNetwork active" >&2
    notify "PocketJS stop failed: Dropbear is still active"
    exit 1
fi
rm -f "$POCKETJS_PID_FILE" "$POCKETJS_IDENTITY_FILE"

# This is the final userstore access in this script. Notify before the gadget
# switch; after exec, usbnet-stop only uses tmpfs and /var/local.
notify "PocketJS SSH stopped; restoring USB mode"
rm -f "${POCKETJS_SSH_STOP_TMP:-}" "${POCKETJS_STOP_RUNTIME_TMP:-}" \
    "${POCKETJS_DROPBEAR_TREE:-}"
trap - EXIT HUP INT TERM
export POCKETJS_USBNET_STOP_REEXEC=1
POCKETJS_USBNET_STOP_TMP_DIR="$POCKETJS_SSH_STOP_TMP_DIR"
export POCKETJS_USBNET_STOP_TMP_DIR
exec sh "$POCKETJS_USBNET_STOP"
