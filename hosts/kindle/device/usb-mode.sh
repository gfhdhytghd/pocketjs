#!/bin/sh
# Managed by PocketJS Kindle bootstrap. Local edits will be replaced.

set -u

# PW5 firmware exposes the USB gadget switch through volumd. Keep the command
# path and sysfs location overridable so this narrow adapter can be exercised
# without touching a real USB gadget in host-side tests.
POCKETJS_SYSTEM_PATH="${POCKETJS_SYSTEM_PATH:-/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
PATH="$POCKETJS_SYSTEM_PATH"
export PATH

POCKETJS_USB_INTERFACE_PATH="${POCKETJS_USB_INTERFACE_PATH:-/sys/class/net/usb0}"
POCKETJS_USB_WAIT_LIMIT="${POCKETJS_USB_WAIT_LIMIT:-15}"
POCKETJS_VOLUMD_RETRY_LIMIT="${POCKETJS_VOLUMD_RETRY_LIMIT:-10}"
POCKETJS_USB_SHORT_SETTLE="${POCKETJS_USB_SHORT_SETTLE:-1}"
POCKETJS_USB_LONG_SETTLE="${POCKETJS_USB_LONG_SETTLE:-2}"
POCKETJS_TMP_ROOT="${POCKETJS_TMP_ROOT:-/var/tmp}"

for pocketjs_number in \
    "$POCKETJS_USB_WAIT_LIMIT" \
    "$POCKETJS_VOLUMD_RETRY_LIMIT" \
    "$POCKETJS_USB_SHORT_SETTLE" \
    "$POCKETJS_USB_LONG_SETTLE"; do
    case "$pocketjs_number" in
        ''|*[!0-9]*)
            echo "PocketJS: invalid USB mode timing value: $pocketjs_number" >&2
            exit 2
            ;;
    esac
done
if [ "$POCKETJS_VOLUMD_RETRY_LIMIT" -eq 0 ]; then
    echo "PocketJS: volumd retry limit must be greater than zero" >&2
    exit 2
fi

case "${1:-}" in
    network)
        pocketjs_target_value=1
        pocketjs_target_description=USBNetwork
        ;;
    mass-storage)
        pocketjs_target_value=0
        pocketjs_target_description="USB Mass Storage"
        ;;
    *)
        echo "usage: usb-mode.sh network|mass-storage" >&2
        exit 2
        ;;
esac

# Never execute the USB Mass Storage transition from the exported userstore.
# The copy and working directory both live on tmpfs before volumd is touched.
if [ "$pocketjs_target_value" -eq 0 ] &&
    [ "${POCKETJS_USB_MODE_REEXEC:-0}" != "1" ]; then
    if [ ! -d "$POCKETJS_TMP_ROOT" ] || [ -L "$POCKETJS_TMP_ROOT" ]; then
        echo "PocketJS: unsafe or missing tmpfs root: $POCKETJS_TMP_ROOT" >&2
        exit 1
    fi
    POCKETJS_USB_MODE_TMP_DIR="$POCKETJS_TMP_ROOT/pocketjs-usb-mode.$$"
    if ! (umask 077 && mkdir "$POCKETJS_USB_MODE_TMP_DIR") 2>/dev/null; then
        echo "PocketJS: could not exclusively create USB mode tmpfs directory" >&2
        exit 1
    fi
    POCKETJS_USB_MODE_SELF_TMP="$POCKETJS_USB_MODE_TMP_DIR/usb-mode.sh"
    if ! cp -p "$0" "$POCKETJS_USB_MODE_SELF_TMP" ||
        ! chmod 700 "$POCKETJS_USB_MODE_SELF_TMP"; then
        rm -f "$POCKETJS_USB_MODE_SELF_TMP"
        rmdir "$POCKETJS_USB_MODE_TMP_DIR" 2>/dev/null || true
        exit 1
    fi
    export POCKETJS_USB_MODE_REEXEC=1 POCKETJS_USB_MODE_SELF_TMP
    export POCKETJS_USB_MODE_TMP_DIR
    cd "$POCKETJS_USB_MODE_TMP_DIR" || exit 1
    exec sh "$POCKETJS_USB_MODE_SELF_TMP" "$@"
fi

cleanup_tmp_copy() {
    if [ -n "${POCKETJS_USB_MODE_SELF_TMP:-}" ]; then
        rm -f "$POCKETJS_USB_MODE_SELF_TMP"
    fi
    if [ -n "${POCKETJS_USB_MODE_TMP_DIR:-}" ]; then
        rmdir "$POCKETJS_USB_MODE_TMP_DIR" 2>/dev/null || true
    fi
}
trap cleanup_tmp_copy EXIT

usb_network_present() {
    [ -e "$POCKETJS_USB_INTERFACE_PATH" ]
}

target_mode_present() {
    if [ "$pocketjs_target_value" -eq 1 ]; then
        usb_network_present
    else
        ! usb_network_present
    fi
}

# It is safe to accept an already-present network device. Mass Storage is
# different: usb0 absence alone does not prove useUsbForNetwork was reset, so
# that direction must always reaffirm property 0.
if [ "$pocketjs_target_value" -eq 1 ] && target_mode_present; then
    echo "PocketJS: $pocketjs_target_description is already active"
    exit 0
fi

if [ "$(id -u 2>/dev/null || true)" != "0" ]; then
    echo "PocketJS: USB mode switching requires root (scriptlet/KUAL elevation is missing)" >&2
    exit 1
fi

for pocketjs_tool in lipc-set-prop lipc-get-prop lipc-send-event; do
    if ! command -v "$pocketjs_tool" >/dev/null 2>&1; then
        echo "PocketJS: firmware USB mode tool is missing: $pocketjs_tool" >&2
        exit 1
    fi
done

# Reference implementation for modern hard-float Kindles:
# https://github.com/notmarek/kindle-usbnetlite/blob/62532ab8f22502dd3605cc119dc001fd8310bf32/extension/usbnetlite/bin/usbnetwork
if [ "$pocketjs_target_value" -eq 0 ] && usb_network_present; then
    if ! command -v ifconfig >/dev/null 2>&1; then
        echo "PocketJS: ifconfig is missing; cannot quiesce usb0" >&2
        exit 1
    fi
    if ! ifconfig usb0 down; then
        echo "PocketJS: failed to bring usb0 down before restoring USB Mass Storage" >&2
        exit 1
    fi
fi

echo "PocketJS: requesting $pocketjs_target_description through Kindle volumd"
pocketjs_volumd_attempt=1
pocketjs_volumd_set=no
while [ "$pocketjs_volumd_attempt" -le "$POCKETJS_VOLUMD_RETRY_LIMIT" ]; do
    if lipc-set-prop -i -- \
        com.lab126.volumd useUsbForNetwork "$pocketjs_target_value"; then
        pocketjs_volumd_set=yes
        break
    fi
    if [ "$pocketjs_volumd_attempt" -ge "$POCKETJS_VOLUMD_RETRY_LIMIT" ]; then
        break
    fi
    echo "PocketJS: volumd is not ready; retrying ($pocketjs_volumd_attempt/$POCKETJS_VOLUMD_RETRY_LIMIT)" >&2
    sleep 1
    pocketjs_volumd_attempt=$((pocketjs_volumd_attempt + 1))
done
if [ "$pocketjs_volumd_set" != yes ]; then
    if command -v lipc-get-prop >/dev/null 2>&1; then
        lipc-get-prop -i -- com.lab126.volumd useUsbForNetwork 2>&1 || true
    fi
    echo "PocketJS: volumd rejected $pocketjs_target_description mode" >&2
    exit 1
fi
echo "PocketJS: volumd accepted mode $pocketjs_target_value on attempt $pocketjs_volumd_attempt"
pocketjs_reported_value=$(
    lipc-get-prop -i -e -- com.lab126.volumd useUsbForNetwork 2>/dev/null |
        sed -n '1p'
)
if [ "$pocketjs_reported_value" != "$pocketjs_target_value" ]; then
    echo "PocketJS: volumd read-back mismatch (requested $pocketjs_target_value, got ${pocketjs_reported_value:-empty})" >&2
    exit 1
fi
echo "PocketJS: volumd read-back confirmed mode $pocketjs_reported_value"

# These are the same two notifications used by the maintained modern Kindle
# USB-network implementation. The property write is authoritative; keep
# waiting for the verified sysfs state even if one notification reports an
# error, because volumd may already have completed the switch.
if [ "$pocketjs_target_value" -eq 0 ]; then
    sleep "$POCKETJS_USB_SHORT_SETTLE"
fi
if ! lipc-send-event -r 3 -d 2 com.lab126.hal usbUnconfigured; then
    echo "PocketJS: warning: usbUnconfigured notification failed" >&2
else
    echo "PocketJS: usbUnconfigured notification accepted"
fi
sleep "$POCKETJS_USB_LONG_SETTLE"
if ! lipc-send-event -r 3 -d 2 com.lab126.hal usbPlugOut; then
    echo "PocketJS: warning: usbPlugOut notification failed" >&2
else
    echo "PocketJS: usbPlugOut notification accepted"
fi
if [ "$pocketjs_target_value" -eq 0 ]; then
    sleep "$POCKETJS_USB_LONG_SETTLE"
fi

pocketjs_wait=0
while ! target_mode_present && [ "$pocketjs_wait" -lt "$POCKETJS_USB_WAIT_LIMIT" ]; do
    sleep 1
    pocketjs_wait=$((pocketjs_wait + 1))
done

if ! target_mode_present; then
    if command -v lipc-get-prop >/dev/null 2>&1; then
        lipc-get-prop -i -- com.lab126.volumd useUsbForNetwork 2>&1 || true
    fi
    echo "PocketJS: $pocketjs_target_description did not become active" >&2
    exit 1
fi

echo "PocketJS: $pocketjs_target_description is active"
