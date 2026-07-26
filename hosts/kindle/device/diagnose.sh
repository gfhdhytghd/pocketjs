#!/bin/sh
# Managed by PocketJS Kindle bootstrap. Local edits will be replaced.

set -u
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

POCKETJS_DEV_ROOT=/mnt/us/pocketjs-dev
POCKETJS_LOCAL_ROOT=/var/local/pocketjs
POCKETJS_REPORT="$POCKETJS_DEV_ROOT/logs/diagnostics.txt"
POCKETJS_PID_FILE="$POCKETJS_LOCAL_ROOT/run/dropbear.pid"
POCKETJS_USB_STATE="$POCKETJS_LOCAL_ROOT/run/usb-mode-before-pocketjs"
POCKETJS_DROPBEAR_LOG="$POCKETJS_LOCAL_ROOT/logs/dropbear.log"
POCKETJS_DROPBEAR_STOP_LOG="$POCKETJS_LOCAL_ROOT/logs/dropbear-stop.log"
POCKETJS_USB_LOG="$POCKETJS_LOCAL_ROOT/logs/usbnetwork.log"

mkdir -p "$POCKETJS_DEV_ROOT/logs"

{
    echo "PocketJS Kindle diagnostics"
    echo "generated: $(date 2>/dev/null || echo unknown)"
    echo
    echo "== identity =="
    id 2>&1 || true
    uname -a 2>&1 || true
    if [ -r /etc/version.txt ]; then
        sed -n '1,12p' /etc/version.txt 2>&1 || true
    fi
    if [ -r /proc/usid ]; then
        echo "usid: $(sed -n '1p' /proc/usid 2>/dev/null || true)"
    fi
    echo
    echo "== armhf runtime =="
    if [ -e /lib/ld-linux-armhf.so.3 ]; then
        echo "armhf loader: present"
    else
        echo "armhf loader: MISSING"
    fi
    ls -l "$POCKETJS_DEV_ROOT/bin/fbink" "$POCKETJS_DEV_ROOT/bin/dropbear" 2>&1 || true
    "$POCKETJS_DEV_ROOT/bin/fbink" -V 2>&1 || true
    "$POCKETJS_DEV_ROOT/bin/dropbear" -V 2>&1 || true
    echo
    echo "== framebuffer =="
    ls -l /dev/fb0 /dev/input/event* 2>&1 || true
    "$POCKETJS_DEV_ROOT/bin/fbink" -e 2>&1 || true
    echo
    echo "== ssh =="
    if [ -s "$POCKETJS_DEV_ROOT/settings/SSH/authorized_keys" ]; then
        echo "authorized_keys: present"
    else
        echo "authorized_keys: MISSING OR EMPTY"
    fi
    if [ -f "$POCKETJS_PID_FILE" ]; then
        echo "pid file: $(sed -n '1p' "$POCKETJS_PID_FILE" 2>/dev/null || true)"
    else
        echo "pid file: absent"
    fi
    ps 2>&1 | grep '[d]ropbear' || true
    echo
    echo "== network =="
    echo "expected host: @@HOST_USB_IP@@"
    echo "expected Kindle: @@KINDLE_USB_IP@@"
    echo "USB mode backend: Kindle volumd/LIPC"
    for pocketjs_tool in lipc-set-prop lipc-get-prop lipc-send-event; do
        if command -v "$pocketjs_tool" >/dev/null 2>&1; then
            echo "$pocketjs_tool: present"
        else
            echo "$pocketjs_tool: MISSING"
        fi
    done
    lipc-get-prop -i -e -- com.lab126.volumd useUsbForNetwork 2>&1 || true
    if [ -e /sys/class/net/usb0 ]; then
        echo "usb0: present"
    else
        echo "usb0: absent (USB Mass Storage or helper failure)"
    fi
    if [ -r "$POCKETJS_USB_STATE" ]; then
        echo "USB mode before PocketJS: $(sed -n '1p' "$POCKETJS_USB_STATE")"
    else
        echo "USB mode before PocketJS: not recorded"
    fi
    lipc-get-prop com.lab126.wifid cmState 2>&1 || true
    lipc-get-prop com.lab126.wifid ipAddress 2>&1 || true
    ifconfig 2>&1 || ip address 2>&1 || true
    echo
    echo "== storage =="
    mount 2>&1 | grep '/mnt/us' || true
    df -h /mnt/us 2>&1 || df /mnt/us 2>&1 || true
    echo
    echo "== recent dropbear log =="
    tail -n 80 "$POCKETJS_DROPBEAR_LOG" 2>&1 || true
    echo
    echo "== recent Dropbear stop log =="
    tail -n 120 "$POCKETJS_DROPBEAR_STOP_LOG" 2>&1 || true
    echo
    echo "== recent USB mode log =="
    tail -n 120 "$POCKETJS_USB_LOG" 2>&1 || true
} >"$POCKETJS_REPORT" 2>&1

echo "PocketJS diagnostics saved to $POCKETJS_REPORT"
if [ -x "$POCKETJS_DEV_ROOT/bin/fbink" ]; then
    "$POCKETJS_DEV_ROOT/bin/fbink" -q -m \
        "PocketJS diagnostics saved: pocketjs-dev/logs/diagnostics.txt" \
        >/dev/null 2>&1 || true
elif command -v eips >/dev/null 2>&1; then
    eips 0 2 "PocketJS diagnostics saved in pocketjs-dev/logs" >/dev/null 2>&1 || true
fi
