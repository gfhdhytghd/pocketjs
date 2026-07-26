#!/bin/sh
# Managed by PocketJS Kindle bootstrap. Local edits will be replaced.

set -u

case "${1:-}" in
    start-ssh)
        exec sh /mnt/us/pocketjs-dev/start-ssh.sh
        ;;
    stop-ssh)
        exec sh /mnt/us/pocketjs-dev/stop-ssh.sh
        ;;
    run-runtime)
        exec sh /mnt/us/pocketjs-dev/run-runtime.sh
        ;;
    stop-runtime)
        exec sh /mnt/us/pocketjs-dev/stop-runtime.sh
        ;;
    diagnose)
        exec sh /mnt/us/pocketjs-dev/diagnose.sh
        ;;
    *)
        echo "PocketJS KUAL: unknown command ${1:-<missing>}" >&2
        exit 2
        ;;
esac
