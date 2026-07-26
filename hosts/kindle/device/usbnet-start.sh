#!/bin/sh
# Managed by PocketJS Kindle bootstrap. Local edits will be replaced.

set -u
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

POCKETJS_DEV_ROOT="${POCKETJS_DEV_ROOT:-/mnt/us/pocketjs-dev}"
POCKETJS_LOCAL_ROOT="${POCKETJS_LOCAL_ROOT:-/var/local/pocketjs}"
POCKETJS_TMP_ROOT="${POCKETJS_TMP_ROOT:-/var/tmp}"
POCKETJS_USERSTORE_ROOT="${POCKETJS_USERSTORE_ROOT:-/mnt/us}"
POCKETJS_USERSTORE_ALIAS_ROOT="${POCKETJS_USERSTORE_ALIAS_ROOT:-/mnt/base-us}"
POCKETJS_USB_INTERFACE_PATH="${POCKETJS_USB_INTERFACE_PATH:-/sys/class/net/usb0}"
POCKETJS_USB_MODE="${POCKETJS_USB_MODE:-$POCKETJS_DEV_ROOT/usb-mode.sh}"
POCKETJS_USBNET_STOP="${POCKETJS_USBNET_STOP:-$POCKETJS_DEV_ROOT/usbnet-stop.sh}"
POCKETJS_USB_STATE="$POCKETJS_LOCAL_ROOT/run/usb-mode-before-pocketjs"
POCKETJS_USB_LOG="$POCKETJS_LOCAL_ROOT/logs/usbnetwork.log"
POCKETJS_KINDLE_IP="${POCKETJS_KINDLE_USB_IP:-@@KINDLE_USB_IP@@}"
pocketjs_switch_attempted=0

# Startup can roll back to Mass Storage, so run the whole operation from tmpfs
# and copy the mode adapter before any gadget transition.
if [ "${POCKETJS_USBNET_START_REEXEC:-0}" != "1" ]; then
    if [ ! -d "$POCKETJS_TMP_ROOT" ] || [ -L "$POCKETJS_TMP_ROOT" ]; then
        echo "PocketJS: unsafe or missing tmpfs root: $POCKETJS_TMP_ROOT" >&2
        exit 1
    fi
    POCKETJS_USBNET_START_TMP_DIR="$POCKETJS_TMP_ROOT/pocketjs-usbnet-start.$$"
    if ! (umask 077 && mkdir "$POCKETJS_USBNET_START_TMP_DIR") 2>/dev/null; then
        echo "PocketJS: could not exclusively create USBNetwork start tmpfs directory" >&2
        exit 1
    fi
    POCKETJS_USBNET_START_TMP="$POCKETJS_USBNET_START_TMP_DIR/usbnet-start.sh"
    POCKETJS_USB_MODE_TMP="$POCKETJS_USBNET_START_TMP_DIR/usb-mode.sh"
    POCKETJS_USBNET_STOP_TMP="$POCKETJS_USBNET_START_TMP_DIR/usbnet-stop.sh"
    if ! cp -p "$0" "$POCKETJS_USBNET_START_TMP" ||
        ! cp -p "$POCKETJS_USB_MODE" "$POCKETJS_USB_MODE_TMP" ||
        ! cp -p "$POCKETJS_USBNET_STOP" "$POCKETJS_USBNET_STOP_TMP" ||
        ! chmod 700 "$POCKETJS_USBNET_START_TMP" "$POCKETJS_USB_MODE_TMP" \
            "$POCKETJS_USBNET_STOP_TMP"; then
        rm -f "$POCKETJS_USBNET_START_TMP" "$POCKETJS_USB_MODE_TMP" \
            "$POCKETJS_USBNET_STOP_TMP"
        rmdir "$POCKETJS_USBNET_START_TMP_DIR" 2>/dev/null || true
        exit 1
    fi
    POCKETJS_USB_MODE="$POCKETJS_USB_MODE_TMP"
    POCKETJS_USBNET_STOP="$POCKETJS_USBNET_STOP_TMP"
    export POCKETJS_USBNET_START_REEXEC=1 POCKETJS_USBNET_START_TMP
    export POCKETJS_USBNET_START_TMP_DIR
    export POCKETJS_USB_MODE POCKETJS_USB_MODE_TMP
    export POCKETJS_USBNET_STOP POCKETJS_USBNET_STOP_TMP
    cd "$POCKETJS_USBNET_START_TMP_DIR" || exit 1
    exec sh "$POCKETJS_USBNET_START_TMP" "$@"
fi

cleanup_tmp_copies() {
    if [ -n "${POCKETJS_USBNET_START_TMP:-}" ]; then
        rm -f "$POCKETJS_USBNET_START_TMP"
    fi
    if [ -n "${POCKETJS_USB_MODE_TMP:-}" ]; then
        rm -f "$POCKETJS_USB_MODE_TMP"
    fi
    if [ -n "${POCKETJS_USBNET_STOP_TMP:-}" ]; then
        rm -f "$POCKETJS_USBNET_STOP_TMP"
    fi
    if [ -n "${POCKETJS_USBNET_START_TMP_DIR:-}" ]; then
        rmdir "$POCKETJS_USBNET_START_TMP_DIR" 2>/dev/null || true
    fi
}
trap cleanup_tmp_copies EXIT

umask 077
mkdir -p "$POCKETJS_LOCAL_ROOT/run" "$POCKETJS_LOCAL_ROOT/logs" || exit 1
chmod 700 "$POCKETJS_LOCAL_ROOT" "$POCKETJS_LOCAL_ROOT/run" \
    "$POCKETJS_LOCAL_ROOT/logs" 2>/dev/null || true
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

path_is_in_userstore() {
    case "${1:-}" in
        "$POCKETJS_USERSTORE_ROOT"|"$POCKETJS_USERSTORE_ROOT"/*|\
        "$POCKETJS_USERSTORE_ALIAS_ROOT"|"$POCKETJS_USERSTORE_ALIAS_ROOT"/*) return 0 ;;
        *) return 1 ;;
    esac
}

persist_original_mode() {
    pocketjs_mode=$1
    pocketjs_state_tmp="$POCKETJS_USB_STATE.tmp.$$"
    rm -f "$pocketjs_state_tmp"
    if ! printf '%s\n' "$pocketjs_mode" >"$pocketjs_state_tmp" ||
        ! mv -f "$pocketjs_state_tmp" "$POCKETJS_USB_STATE" ||
        ! sync >/dev/null 2>&1 ||
        [ "$(sed -n '1p' "$POCKETJS_USB_STATE" 2>/dev/null || true)" != "$pocketjs_mode" ] ||
        [ "$(sed -n '2p' "$POCKETJS_USB_STATE" 2>/dev/null || true)" != "" ]; then
        rm -f "$pocketjs_state_tmp"
        echo "PocketJS: could not durably record the original USB mode" >&2
        return 1
    fi
}

rollback_usb_mode() {
    if [ "$pocketjs_original_mode" = "network" ]; then
        if ! usb_network_present; then
            echo "PocketJS: rollback failed; original USBNetwork mode is not active" >&2
            return 1
        fi
        rm -f "$POCKETJS_USB_STATE"
        echo "PocketJS: original USBNetwork mode left active" >&2
        return 0
    fi

    echo "PocketJS: rolling back to the original USB Mass Storage mode" >&2
    if [ ! -f "$POCKETJS_USBNET_STOP" ]; then
        echo "PocketJS: rollback failed; safe USB stop helper is missing" >&2
        return 1
    fi

    # From this point onward every fd and message stays outside /mnt/us. The
    # stop helper performs the same process-reference guard used by the normal
    # local Stop USB SSH path before it asks volumd to export the filesystem.
    exec </dev/null >>"$POCKETJS_USB_LOG" 2>&1 || return 1
    pocketjs_high_fd_supported=no
    if (eval 'exec 10>&-') 2>/dev/null; then
        pocketjs_high_fd_supported=yes
    fi
    pocketjs_self_fd_root="${POCKETJS_SELF_FD_ROOT:-/proc/$$/fd}"
    for pocketjs_inherited_fd_path in "$pocketjs_self_fd_root/"*; do
        [ -e "$pocketjs_inherited_fd_path" ] || [ -L "$pocketjs_inherited_fd_path" ] ||
            continue
        pocketjs_inherited_fd=${pocketjs_inherited_fd_path##*/}
        case "$pocketjs_inherited_fd" in
            0|1|2|''|*[!0-9]*) continue ;;
        esac
        pocketjs_inherited_target=$(
            readlink "$pocketjs_inherited_fd_path" 2>/dev/null || true
        )
        path_is_in_userstore "$pocketjs_inherited_target" || continue
        case "$pocketjs_inherited_fd" in
            [3-9]) eval "exec ${pocketjs_inherited_fd}>&-" || return 1 ;;
            *)
                [ "$pocketjs_high_fd_supported" = yes ] || return 1
                eval "exec ${pocketjs_inherited_fd}>&-" || return 1
                ;;
        esac
    done
    if ! sh "$POCKETJS_USBNET_STOP"; then
        echo "PocketJS: rollback failed; safe USB Mass Storage restore was refused"
        return 1
    fi
    echo "PocketJS: original USB Mass Storage mode restored"
}

fail_with_rollback() {
    echo "PocketJS: $1" >&2
    if ! rollback_usb_mode; then
        echo "PocketJS: automatic USB rollback was incomplete; run PocketJS Stop USB SSH locally" >&2
    fi
    exit 1
}

if [ -f "$POCKETJS_USB_STATE" ]; then
    pocketjs_original_mode=$(sed -n '1p' "$POCKETJS_USB_STATE" 2>/dev/null || true)
    case "$pocketjs_original_mode" in
        mass-storage|network) ;;
        *)
            echo "PocketJS: invalid saved USB mode in $POCKETJS_USB_STATE" >&2
            exit 1
            ;;
    esac
elif usb_network_present; then
    pocketjs_original_mode=network
    persist_original_mode "$pocketjs_original_mode" || exit 1
else
    pocketjs_original_mode=mass-storage
    persist_original_mode "$pocketjs_original_mode" || exit 1
fi

if usb_network_present; then
    echo "PocketJS USBNetwork is already active (original mode: $pocketjs_original_mode)"
else
    if [ ! -f "$POCKETJS_USB_MODE" ]; then
        echo "PocketJS: USB mode adapter is missing: $POCKETJS_USB_MODE" >&2
        echo "Rerun the PocketJS Kindle bootstrap, then run this scriptlet again." >&2
        exit 1
    fi
    echo "PocketJS: switching USB Mass Storage to USBNetwork"
    pocketjs_switch_attempted=1
    if ! sh "$POCKETJS_USB_MODE" network >>"$POCKETJS_USB_LOG" 2>&1; then
        fail_with_rollback "firmware USBNetwork switch failed"
    fi
fi

# Keep this development path deterministic. Dropbear separately binds only to
# usb0, so enabling it never opens the server on wlan0.
if ! command -v ifconfig >/dev/null 2>&1; then
    fail_with_rollback "ifconfig is unavailable; cannot configure usb0"
fi
if ! ifconfig usb0 "$POCKETJS_KINDLE_IP" netmask 255.255.255.0 up \
    >>"$POCKETJS_USB_LOG" 2>&1; then
    fail_with_rollback "failed to configure usb0 as $POCKETJS_KINDLE_IP"
fi

echo "PocketJS USBNetwork ready: Kindle $POCKETJS_KINDLE_IP; host @@HOST_USB_IP@@"
