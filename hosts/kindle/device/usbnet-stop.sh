#!/bin/sh
# Managed by PocketJS Kindle bootstrap. Local edits will be replaced.

set -u
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

POCKETJS_DEV_ROOT="${POCKETJS_DEV_ROOT:-/mnt/us/pocketjs-dev}"
POCKETJS_LOCAL_ROOT="${POCKETJS_LOCAL_ROOT:-/var/local/pocketjs}"
POCKETJS_TMP_ROOT="${POCKETJS_TMP_ROOT:-/var/tmp}"
POCKETJS_PROC_ROOT="${POCKETJS_PROC_ROOT:-/proc}"
POCKETJS_CONTROL_ROOT="${POCKETJS_CONTROL_ROOT:-/var/run/pocketjs}"
POCKETJS_USERSTORE_ROOT="${POCKETJS_USERSTORE_ROOT:-/mnt/us}"
POCKETJS_USERSTORE_ALIAS_ROOT="${POCKETJS_USERSTORE_ALIAS_ROOT:-/mnt/base-us}"
POCKETJS_USERSTORE_REAL_ROOT=$(readlink -f "$POCKETJS_USERSTORE_ROOT" 2>/dev/null || true)
[ -n "$POCKETJS_USERSTORE_REAL_ROOT" ] ||
    POCKETJS_USERSTORE_REAL_ROOT="$POCKETJS_USERSTORE_ROOT"
POCKETJS_USB_INTERFACE_PATH="${POCKETJS_USB_INTERFACE_PATH:-/sys/class/net/usb0}"
POCKETJS_USB_MODE="${POCKETJS_USB_MODE:-$POCKETJS_DEV_ROOT/usb-mode.sh}"
POCKETJS_USB_STATE="$POCKETJS_LOCAL_ROOT/run/usb-mode-before-pocketjs"
POCKETJS_USB_LOG="$POCKETJS_LOCAL_ROOT/logs/usbnetwork.log"
POCKETJS_UI_STATE="$POCKETJS_DEV_ROOT/run/runtime-ui-stopped"
POCKETJS_POWERD_STATE="$POCKETJS_DEV_ROOT/run/runtime-powerd-state"
POCKETJS_EXPORT_LOCK="$POCKETJS_CONTROL_ROOT/userstore-export.lock"
POCKETJS_STOP_LOCK="$POCKETJS_CONTROL_ROOT/runtime-stop.lock"
POCKETJS_LAUNCH_LOCK="$POCKETJS_CONTROL_ROOT/runtime-launch.lock"
POCKETJS_LAUNCH_LOCK_WAIT="${POCKETJS_LAUNCH_LOCK_WAIT:-10}"
pocketjs_export_lock_owned=0
pocketjs_stop_lock_owned=0
pocketjs_launch_lock_owned=0

case "$POCKETJS_LAUNCH_LOCK_WAIT" in
    ''|*[!0-9]*)
        echo "PocketJS: invalid runtime launch lock wait: $POCKETJS_LAUNCH_LOCK_WAIT" >&2
        exit 2
        ;;
esac

# Copy both scripts off /mnt/us before any quiescence check or gadget change.
if [ "${POCKETJS_USBNET_STOP_REEXEC:-0}" != "1" ]; then
    if [ ! -d "$POCKETJS_TMP_ROOT" ] || [ -L "$POCKETJS_TMP_ROOT" ]; then
        echo "PocketJS: unsafe or missing tmpfs root: $POCKETJS_TMP_ROOT" >&2
        exit 1
    fi
    POCKETJS_USBNET_STOP_TMP_DIR="$POCKETJS_TMP_ROOT/pocketjs-usbnet-stop.$$"
    if ! (umask 077 && mkdir "$POCKETJS_USBNET_STOP_TMP_DIR") 2>/dev/null; then
        echo "PocketJS: could not exclusively create USBNetwork stop tmpfs directory" >&2
        exit 1
    fi
    POCKETJS_USBNET_STOP_TMP="$POCKETJS_USBNET_STOP_TMP_DIR/usbnet-stop.sh"
    POCKETJS_USB_MODE_TMP="$POCKETJS_USBNET_STOP_TMP_DIR/usb-mode.sh"
    if ! cp -p "$0" "$POCKETJS_USBNET_STOP_TMP" ||
        ! cp -p "$POCKETJS_USB_MODE" "$POCKETJS_USB_MODE_TMP" ||
        ! chmod 700 "$POCKETJS_USBNET_STOP_TMP" "$POCKETJS_USB_MODE_TMP"; then
        rm -f "$POCKETJS_USBNET_STOP_TMP" "$POCKETJS_USB_MODE_TMP"
        rmdir "$POCKETJS_USBNET_STOP_TMP_DIR" 2>/dev/null || true
        exit 1
    fi
    POCKETJS_USB_MODE="$POCKETJS_USB_MODE_TMP"
    export POCKETJS_USBNET_STOP_REEXEC=1 POCKETJS_USBNET_STOP_TMP
    export POCKETJS_USBNET_STOP_TMP_DIR
    export POCKETJS_USB_MODE POCKETJS_USB_MODE_TMP
    cd "$POCKETJS_USBNET_STOP_TMP_DIR" || exit 1
    exec sh "$POCKETJS_USBNET_STOP_TMP" "$@"
fi

release_owned_lock() {
    pocketjs_release_lock=$1
    [ -d "$pocketjs_release_lock" ] || return 0
    [ "$(sed -n '1p' "$pocketjs_release_lock/owner" 2>/dev/null || true)" = "$$" ] ||
        return 0
    rm -f "$pocketjs_release_lock/owner"
    rmdir "$pocketjs_release_lock" 2>/dev/null || true
}

cleanup_usbnet_stop() {
    pocketjs_cleanup_status=$?
    trap - EXIT
    if [ "$pocketjs_launch_lock_owned" -eq 1 ]; then
        release_owned_lock "$POCKETJS_LAUNCH_LOCK"
    fi
    if [ "$pocketjs_stop_lock_owned" -eq 1 ]; then
        release_owned_lock "$POCKETJS_STOP_LOCK"
    fi
    if [ "$pocketjs_export_lock_owned" -eq 1 ]; then
        release_owned_lock "$POCKETJS_EXPORT_LOCK"
    fi
    if [ -n "${POCKETJS_USBNET_STOP_TMP:-}" ]; then
        rm -f "$POCKETJS_USBNET_STOP_TMP"
    fi
    if [ -n "${POCKETJS_USB_MODE_TMP:-}" ]; then
        rm -f "$POCKETJS_USB_MODE_TMP"
    fi
    if [ -n "${POCKETJS_USBNET_STOP_TMP_DIR:-}" ]; then
        rmdir "$POCKETJS_USBNET_STOP_TMP_DIR" 2>/dev/null || true
    fi
    if [ "$pocketjs_cleanup_status" -ne 0 ] && command -v eips >/dev/null 2>&1; then
        eips 0 2 "PocketJS USB restore blocked; run Start SSH and diagnostics" \
            >/dev/null 2>&1 || true
    fi
    exit "$pocketjs_cleanup_status"
}
trap cleanup_usbnet_stop EXIT

umask 077
mkdir -p "$POCKETJS_LOCAL_ROOT/run" "$POCKETJS_LOCAL_ROOT/logs" \
    "$POCKETJS_CONTROL_ROOT" || exit 1
chmod 700 "$POCKETJS_LOCAL_ROOT" "$POCKETJS_LOCAL_ROOT/run" \
    "$POCKETJS_LOCAL_ROOT/logs" "$POCKETJS_CONTROL_ROOT" 2>/dev/null || true
: >>"$POCKETJS_USB_LOG" || exit 1
chmod 600 "$POCKETJS_USB_LOG" 2>/dev/null || true

rotate_usb_log() {
    [ -f "$POCKETJS_USB_LOG" ] || return 0
    pocketjs_log_size=$(wc -c <"$POCKETJS_USB_LOG" 2>/dev/null || echo 0)
    case "$pocketjs_log_size" in
        ''|*[!0-9]*) pocketjs_log_size=0 ;;
    esac
    if [ "$pocketjs_log_size" -gt 1000000 ]; then
        tail -c 500000 "$POCKETJS_USB_LOG" >"$POCKETJS_USB_LOG.new.$$" 2>/dev/null &&
            mv -f "$POCKETJS_USB_LOG.new.$$" "$POCKETJS_USB_LOG"
        rm -f "$POCKETJS_USB_LOG.new.$$"
    fi
}
rotate_usb_log

usb_network_present() {
    [ -e "$POCKETJS_USB_INTERFACE_PATH" ]
}

valid_pid() {
    case "${1:-}" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

acquire_export_gate() {
    if ! mkdir "$POCKETJS_EXPORT_LOCK" 2>/dev/null; then
        echo "PocketJS: another or interrupted USB export is active; retry or reboot" >&2
        return 1
    fi
    if ! printf '%s\n' "$$" >"$POCKETJS_EXPORT_LOCK/owner" ||
        [ "$(sed -n '1p' "$POCKETJS_EXPORT_LOCK/owner" 2>/dev/null || true)" != "$$" ]; then
        rm -f "$POCKETJS_EXPORT_LOCK/owner"
        rmdir "$POCKETJS_EXPORT_LOCK" 2>/dev/null || true
        echo "PocketJS: could not publish the USB export gate owner" >&2
        return 1
    fi
    pocketjs_export_lock_owned=1
}

acquire_stop_gate_for_export() {
    if ! mkdir "$POCKETJS_STOP_LOCK" 2>/dev/null; then
        echo "PocketJS: a runtime stop or interrupted stop is active; keeping USBNetwork active" >&2
        return 1
    fi
    if ! printf '%s\n' "$$" >"$POCKETJS_STOP_LOCK/owner" ||
        [ "$(sed -n '1p' "$POCKETJS_STOP_LOCK/owner" 2>/dev/null || true)" != "$$" ]; then
        rm -f "$POCKETJS_STOP_LOCK/owner"
        rmdir "$POCKETJS_STOP_LOCK" 2>/dev/null || true
        echo "PocketJS: could not publish the USB export stop gate owner" >&2
        return 1
    fi
    pocketjs_stop_lock_owned=1
}

acquire_launch_lock_for_export() {
    pocketjs_lock_wait=0
    while ! mkdir "$POCKETJS_LAUNCH_LOCK" 2>/dev/null; do
        pocketjs_lock_owner=$(sed -n '1p' "$POCKETJS_LAUNCH_LOCK/owner" 2>/dev/null || true)
        if valid_pid "$pocketjs_lock_owner" &&
            kill -0 "$pocketjs_lock_owner" 2>/dev/null; then
            if [ "$pocketjs_lock_wait" -ge "$POCKETJS_LAUNCH_LOCK_WAIT" ]; then
                echo "PocketJS: runtime launch generation is still active (pid $pocketjs_lock_owner); keeping USBNetwork active" >&2
                return 1
            fi
            sleep 1
            pocketjs_lock_wait=$((pocketjs_lock_wait + 1))
            continue
        fi

        # Owning the export gate prevents every conforming runtime launcher
        # from entering or continuing. It is therefore safe to recover a
        # dead or half-published launch lock here.
        rm -f "$POCKETJS_LAUNCH_LOCK/owner"
        if ! rmdir "$POCKETJS_LAUNCH_LOCK" 2>/dev/null; then
            echo "PocketJS: runtime launch lock could not be safely recovered; keeping USBNetwork active" >&2
            return 1
        fi
    done

    if ! printf '%s\n' "$$" >"$POCKETJS_LAUNCH_LOCK/owner" ||
        [ "$(sed -n '1p' "$POCKETJS_LAUNCH_LOCK/owner" 2>/dev/null || true)" != "$$" ]; then
        rm -f "$POCKETJS_LAUNCH_LOCK/owner"
        rmdir "$POCKETJS_LAUNCH_LOCK" 2>/dev/null || true
        echo "PocketJS: could not publish the USB export launch lock owner" >&2
        return 1
    fi
    pocketjs_launch_lock_owned=1
}

path_is_in_userstore() {
    case "${1:-}" in
        "$POCKETJS_USERSTORE_ROOT"|"$POCKETJS_USERSTORE_ROOT"/*|\
        "$POCKETJS_USERSTORE_ROOT (deleted)"|\
        "$POCKETJS_USERSTORE_ALIAS_ROOT"|"$POCKETJS_USERSTORE_ALIAS_ROOT"/*|\
        "$POCKETJS_USERSTORE_ALIAS_ROOT (deleted)"|\
        "$POCKETJS_USERSTORE_REAL_ROOT"|"$POCKETJS_USERSTORE_REAL_ROOT"/*|\
        "$POCKETJS_USERSTORE_REAL_ROOT (deleted)") return 0 ;;
        *) return 1 ;;
    esac
}

# KUAL commonly launches extensions with stderr still attached to
# /mnt/us/extensions/KUAL.log. Replace all standard streams before scanning,
# then close any inherited higher-numbered descriptor that still names the
# userstore. Otherwise this worker would correctly—but uselessly—block on its
# own inherited log descriptor.
exec </dev/null >>"$POCKETJS_USB_LOG" 2>&1
for pocketjs_inherited_fd_path in "/proc/$$/fd/"*; do
    [ -e "$pocketjs_inherited_fd_path" ] || [ -L "$pocketjs_inherited_fd_path" ] ||
        continue
    pocketjs_inherited_fd=${pocketjs_inherited_fd_path##*/}
    case "$pocketjs_inherited_fd" in
        0|1|2|''|*[!0-9]*) continue ;;
    esac
    pocketjs_inherited_target=$(readlink "$pocketjs_inherited_fd_path" 2>/dev/null || true)
    if path_is_in_userstore "$pocketjs_inherited_target"; then
        eval "exec ${pocketjs_inherited_fd}>&-"
    fi
done

report_userstore_reference() {
    pocketjs_guard_pid=$1
    pocketjs_guard_kind=$2
    pocketjs_guard_target=$3
    echo "PocketJS: refusing USB Mass Storage while pid $pocketjs_guard_pid has $pocketjs_guard_kind under $POCKETJS_USERSTORE_ROOT: $pocketjs_guard_target" >&2
}

assert_userstore_quiescent() {
    for pocketjs_proc_dir in "$POCKETJS_PROC_ROOT"/[0-9]*; do
        [ -d "$pocketjs_proc_dir" ] || continue
        pocketjs_guard_pid=${pocketjs_proc_dir##*/}

        pocketjs_guard_target=$(readlink "$pocketjs_proc_dir/exe" 2>/dev/null || true)
        if path_is_in_userstore "$pocketjs_guard_target"; then
            report_userstore_reference "$pocketjs_guard_pid" executable "$pocketjs_guard_target"
            return 1
        fi

        pocketjs_guard_target=$(readlink "$pocketjs_proc_dir/cwd" 2>/dev/null || true)
        if path_is_in_userstore "$pocketjs_guard_target"; then
            report_userstore_reference "$pocketjs_guard_pid" cwd "$pocketjs_guard_target"
            return 1
        fi

        for pocketjs_guard_fd in "$pocketjs_proc_dir"/fd/*; do
            [ -e "$pocketjs_guard_fd" ] || [ -L "$pocketjs_guard_fd" ] || continue
            pocketjs_guard_target=$(readlink "$pocketjs_guard_fd" 2>/dev/null || true)
            if path_is_in_userstore "$pocketjs_guard_target"; then
                report_userstore_reference "$pocketjs_guard_pid" "open fd" "$pocketjs_guard_target"
                return 1
            fi
        done

        if [ -r "$pocketjs_proc_dir/maps" ]; then
            while IFS= read -r pocketjs_guard_map; do
                case "$pocketjs_guard_map" in
                    */*) pocketjs_guard_target="/${pocketjs_guard_map#*/}" ;;
                    *) continue ;;
                esac
                if path_is_in_userstore "$pocketjs_guard_target"; then
                    report_userstore_reference "$pocketjs_guard_pid" \
                        "memory map" "$pocketjs_guard_target"
                    return 1
                fi
            done <"$pocketjs_proc_dir/maps"
        fi
    done
}

if [ ! -f "$POCKETJS_USB_STATE" ]; then
    echo "PocketJS: no saved USB mode; refusing to change an unknown USB state" >&2
    exit 1
fi

pocketjs_original_mode=$(sed -n '1p' "$POCKETJS_USB_STATE" 2>/dev/null || true)
case "$pocketjs_original_mode" in
    network)
        if ! usb_network_present; then
            if [ ! -f "$POCKETJS_USB_MODE" ]; then
                echo "PocketJS: cannot restore the original USBNetwork mode; adapter is missing" >&2
                exit 1
            fi
            echo "PocketJS: restoring the original USBNetwork mode"
            if ! sh "$POCKETJS_USB_MODE" network >>"$POCKETJS_USB_LOG" 2>&1; then
                echo "PocketJS: original USBNetwork mode did not reappear; keeping recovery state" >&2
                exit 1
            fi
        fi
        rm -f "$POCKETJS_USB_STATE"
        echo "PocketJS: USBNetwork was already active; leaving it active"
        exit 0
        ;;
    mass-storage) ;;
    *)
        echo "PocketJS: invalid saved USB mode in $POCKETJS_USB_STATE" >&2
        exit 1
        ;;
esac

if [ ! -f "$POCKETJS_USB_MODE" ]; then
    echo "PocketJS: cannot restore USB Mass Storage; adapter is missing: $POCKETJS_USB_MODE" >&2
    exit 1
fi

# Close the stop/launch-versus-export races before scanning. The export gate
# makes new launchers fail, the shared stop gate serializes stale launch-lock
# recovery with stop-runtime, and the launch lock catches a launcher which
# already passed its first gate check. Hold all three through the transition.
acquire_export_gate || exit 1
acquire_stop_gate_for_export || exit 1
acquire_launch_lock_for_export || exit 1

# A SIGKILLed launcher can leave the runtime gone while its durable UI recovery
# record still describes a paused Kindle process. Only stop-runtime may verify
# and resume that identity; never make its script and state unavailable first.
if [ -e "$POCKETJS_UI_STATE" ] || [ -L "$POCKETJS_UI_STATE" ]; then
    echo "PocketJS: Kindle UI recovery is still pending; run Stop Runtime before restoring USB Mass Storage" >&2
    exit 1
fi
if [ -e "$POCKETJS_POWERD_STATE" ] || [ -L "$POCKETJS_POWERD_STATE" ]; then
    echo "PocketJS: Kindle powerd recovery is still pending; run Stop Runtime before restoring USB Mass Storage" >&2
    exit 1
fi

# Two scans bracket sync while all gates are held. They fail closed for every
# userstore reference visible in either snapshot; volumd remains responsible
# for the final filesystem transition. The recovery record stays in /var/local
# when proof is incomplete.
if ! assert_userstore_quiescent; then
    echo "PocketJS: stop the reported process locally, then retry Stop USB SSH" >&2
    exit 1
fi
sync >/dev/null 2>&1 || {
    echo "PocketJS: sync failed; refusing to export USB Mass Storage" >&2
    exit 1
}
if ! assert_userstore_quiescent; then
    echo "PocketJS: PocketJS userstore became busy during sync; keeping USBNetwork active" >&2
    exit 1
fi

echo "PocketJS: restoring USB Mass Storage"
# This helper itself reexecs from tmpfs. Its output, the recovery record, and
# every write after the switch live under /var/local rather than /mnt/us.
if ! sh "$POCKETJS_USB_MODE" mass-storage >>"$POCKETJS_USB_LOG" 2>&1; then
    echo "PocketJS: USB Mass Storage restore did not complete; keeping recovery state" >&2
    exit 1
fi
if usb_network_present; then
    echo "PocketJS: usb0 is still present; keeping recovery state" >&2
    exit 1
fi
rm -f "$POCKETJS_USB_STATE"
echo "PocketJS: previous USB Mass Storage mode restored"
